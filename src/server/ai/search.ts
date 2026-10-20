// The Cloudflare AI binding itself is typed by worker-configuration.d.ts,
// generated from wrangler.toml. This module keeps only the stable internal
// search shape consumed by the assistant and the compatibility normalizer for
// raw results returned across the AutoRAG -> AI Search transition.
//
// `AiSearchChunk` is our STABLE internal shape that the rest of the assistant
// (`toSources`, `answer`) consumes. The raw binding response is NOT this shape —
// its structure shifted across the AutoRAG -> "AI Search" rebrand (per-item
// fields have appeared under `metadata`, `attributes`, or `item`; the folder as
// `attributes.folder` or the full `item.key`; the text as a `content` string, a
// `content` array of `{type,text}` blocks, or a `text` field). `retrieve()`
// normalizes whatever comes back into `AiSearchChunk` so the consumers never see
// the raw variance. See `normalizeChunk`.
export interface AiSearchChunk {
  id: string;
  score: number;
  content: string;
  metadata: { filename: string; folder: string; timestamp: number };
}

/** Loosely-typed raw item from the AI Search binding — normalized by `retrieve`. */
interface RawSearchItem {
  id?: string;
  file_id?: string;
  score?: number;
  content?: unknown;
  text?: string;
  filename?: string;
  metadata?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  item?: {
    key?: string;
    timestamp?: number;
    metadata?: Record<string, unknown>;
  };
}

/** Loosely-typed raw envelope — results have appeared under `data` or `chunks`. */
interface RawSearchResult {
  search_query?: string;
  data?: RawSearchItem[];
  chunks?: RawSearchItem[];
  has_more?: boolean;
}

export class AiSearchUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Document search is temporarily unavailable');
    this.name = 'AiSearchUnavailableError';
    this.cause = cause;
  }
}

// --- Raw-response normalization ------------------------------------------------

/** Pull the chunk's text out of the several shapes the binding has used. */
function chunkText(item: RawSearchItem): string {
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) {
    return item.content
      .map((b) =>
        typeof b === 'string' ? b : ((b as { text?: unknown })?.text ?? ''),
      )
      .filter((t): t is string => typeof t === 'string')
      .join('');
  }
  if (typeof item.text === 'string') return item.text;
  return '';
}

/**
 * The R2-key path used for citation mapping. Any value containing
 * `documents/<uuid>/...` works — `docIdFromFolder` extracts the uuid from either
 * a folder (`documents/<uuid>/`) or a full object key.
 */
function chunkFolder(item: RawSearchItem): string {
  const candidates = [
    item.metadata?.folder,
    item.attributes?.folder,
    item.item?.key,
    (item as { key?: unknown }).key,
    item.filename,
  ];
  for (const c of candidates) if (typeof c === 'string' && c) return c;
  return '';
}

function chunkFilename(item: RawSearchItem): string {
  if (typeof item.filename === 'string') return item.filename;
  if (typeof item.item?.key === 'string') return item.item.key;
  const mf = item.metadata?.filename ?? item.attributes?.filename;
  return typeof mf === 'string' ? mf : '';
}

function chunkTimestamp(item: RawSearchItem): number {
  const t =
    item.attributes?.timestamp ??
    item.item?.timestamp ??
    item.metadata?.timestamp;
  return typeof t === 'number' ? t : 0;
}

function normalizeChunk(item: RawSearchItem): AiSearchChunk {
  const content = chunkText(item);
  if (!content) {
    // Unknown/unsupported chunk shape. Log the KEYS only (never the values — those
    // can contain document text / resident PII) so the real shape is diagnosable
    // from Workers logs without leaking content.
    console.warn(
      '[assistant] AI Search chunk text not extractable — item keys:',
      Object.keys(item),
      '| attributes:',
      item.attributes ? Object.keys(item.attributes) : null,
      '| item:',
      item.item ? Object.keys(item.item) : null,
    );
  }
  return {
    id: String(item.file_id ?? item.id ?? ''),
    score: typeof item.score === 'number' ? item.score : 0,
    content,
    metadata: {
      filename: chunkFilename(item),
      folder: chunkFolder(item),
      timestamp: chunkTimestamp(item),
    },
  };
}

async function search(
  env: Env,
  options: Record<string, unknown>,
): Promise<AiSearchChunk[]> {
  try {
    const res = (await env.AI.autorag(env.AI_SEARCH_INSTANCE).search(
      options as never,
    )) as unknown as RawSearchResult;
    const raw = res.data ?? res.chunks ?? [];
    return raw.map(normalizeChunk);
  } catch (err) {
    throw new AiSearchUnavailableError(err);
  }
}

/** Retrieve the top document chunks relevant to `query` from the AI Search index. */
export async function retrieve(
  env: Env,
  query: string,
  limit = 8,
): Promise<AiSearchChunk[]> {
  return search(env, {
    query,
    max_num_results: limit,
    ranking_options: { score_threshold: 0.3 },
    rewrite_query: true,
  });
}

/**
 * Documents per search in `retrieveFrom`. AI Search fails every search whose
 * `or` filter has more than 48 clauses (measured against production,
 * 2026-10-20; the limit is not documented), so a longer list is split.
 */
export const FILTER_BATCH = 40;

/**
 * Retrieve the chunks most relevant to `query` from the named documents only
 * (#305). The library-wide search ranks correspondence and checklists above
 * the bylaws and covenants, so the assistant and reports also search within
 * the governing documents. AI Search matches a twin by its bare name, without
 * the `rag/` folder.
 *
 * Past `FILTER_BATCH` documents, each batch is its own search and the best
 * `limit` across them are kept. Each batch may rewrite the query a little
 * differently, so their scores are close to comparable, not exactly. A batch
 * that fails is logged and left out; only when every batch fails does this
 * throw.
 */
export async function retrieveFrom(
  env: Env,
  query: string,
  documentIds: string[],
  limit = 4,
): Promise<AiSearchChunk[]> {
  const batches: string[][] = [];
  for (let i = 0; i < documentIds.length; i += FILTER_BATCH)
    batches.push(documentIds.slice(i, i + FILTER_BATCH));
  const settled = await Promise.allSettled(
    batches.map((ids) =>
      search(env, {
        query,
        max_num_results: limit,
        ranking_options: { score_threshold: 0.3 },
        rewrite_query: true,
        filters: {
          type: 'or',
          filters: ids.map((id) => ({
            type: 'eq',
            key: 'filename',
            value: `${id}.md`,
          })),
        },
      }),
    ),
  );
  const found = settled.flatMap((r) =>
    r.status === 'fulfilled' ? [r.value] : [],
  );
  const failed = settled.filter((r) => r.status === 'rejected');
  if (failed.length > 0 && found.length === 0) throw failed[0].reason;
  if (failed.length > 0)
    console.error(
      `[search] ${failed.length} of ${batches.length} filtered searches failed`,
      failed[0].reason,
    );
  return found
    .flat()
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
