// Minimal typings for the Cloudflare AI Search (autorag) binding — declared here
// rather than relying on @cloudflare/workers-types (pinned at v4; autorag typing
// is not guaranteed). Only the `search()` surface we use is modeled.
export interface AiSearchChunk {
  id: string;
  score: number;
  content: string;
  metadata: { filename: string; folder: string; timestamp: number };
}

export interface AiSearchResult {
  search_query: string;
  data: AiSearchChunk[];
  has_more: boolean;
}

export interface AutoRag {
  search(opts: {
    query: string;
    max_num_results?: number;
    ranking_options?: { score_threshold?: number };
    rewrite_query?: boolean;
  }): Promise<AiSearchResult>;
}

export interface AiBinding {
  autorag(instance: string): AutoRag;
}

export class AiSearchUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Document search is temporarily unavailable');
    this.name = 'AiSearchUnavailableError';
    this.cause = cause;
  }
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
    return res.data ?? [];
  } catch (err) {
    throw new AiSearchUnavailableError(err);
  }
}
