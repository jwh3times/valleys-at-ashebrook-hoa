// Minimal typings for the Cloudflare AI Search (autorag) binding — declared here
// rather than relying on @cloudflare/workers-types (pinned at v4; autorag typing
// is not guaranteed). Only the `search()` surface we use is modeled.
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

export interface AutoRag {
  search(opts: {
    query: string;
    max_num_results?: number;
    ranking_options?: { score_threshold?: number };
    rewrite_query?: boolean;
  }): Promise<RawSearchResult>;
}

export interface MarkdownDocument {
  name: string;
  blob: Blob;
}
export interface ToMarkdownResult {
  name: string;
  format: string; // 'markdown' | 'error'
  mimetype?: string;
  tokens?: number;
  data?: string;
}

export interface AiBinding {
  autorag(instance: string): AutoRag;
  toMarkdown(
    files: MarkdownDocument[],
    options?: Record<string, unknown>,
  ): Promise<ToMarkdownResult[]>;
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

/** Retrieve the top document chunks relevant to `query` from the AI Search index. */
export async function retrieve(
  env: Env,
  query: string,
  limit = 8,
): Promise<AiSearchChunk[]> {
  try {
    const res = await env.AI.autorag(env.AI_SEARCH_INSTANCE).search({
      query,
      max_num_results: limit,
      ranking_options: { score_threshold: 0.3 },
      rewrite_query: true,
    });
    const raw = res.data ?? res.chunks ?? [];
    return raw.map(normalizeChunk);
  } catch (err) {
    throw new AiSearchUnavailableError(err);
  }
}
