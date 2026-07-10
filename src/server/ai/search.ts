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
