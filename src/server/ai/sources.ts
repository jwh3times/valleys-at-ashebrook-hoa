import { inArray } from 'drizzle-orm';
import { getDb } from '../db/client';
import { documents } from '../db/schema';
import type { AiSearchChunk } from './search';

export interface Source {
  id: string;
  title: string;
  category: string;
  href: string;
}

/** The R2 layout is `documents/<uuid>/<filename>` — pull the uuid out. */
function docIdFromFolder(folder: string): string | null {
  const m = /(?:^|\/)documents\/([^/]+)\//.exec(folder);
  return m ? m[1] : null;
}

/**
 * Map retrieved chunks back to their real D1 document rows, in first-seen
 * (best-score) order, deduped by document id. Sources are board-only metadata
 * shown to the caller — they are NOT sent to Anthropic.
 */
export async function toSources(
  env: Env,
  chunks: AiSearchChunk[],
): Promise<Source[]> {
  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const c of chunks) {
    const id = docIdFromFolder(c.metadata.folder);
    if (id && !seen.has(id)) {
      seen.add(id);
      orderedIds.push(id);
    }
  }
  if (orderedIds.length === 0) return [];

  const rows = await getDb(env)
    .select({
      id: documents.id,
      title: documents.title,
      category: documents.category,
    })
    .from(documents)
    .where(inArray(documents.id, orderedIds));
  const byId = new Map(rows.map((r) => [r.id, r]));

  return orderedIds
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map((r) => ({
      id: r.id,
      title: r.title,
      category: r.category,
      href: `/api/files/${r.id}`,
    }));
}
