import { docIdFromFolder, toSources, type Source } from './sources';
import type { AiSearchChunk } from './search';
import type { Pseudonymizer } from './pii';

export interface ExcerptContext {
  sources: Source[];
  contextText: string; // pseudonymized, [Source N]-labeled excerpts, '\n\n'-joined
  documentsFound: boolean;
}

/**
 * Resolve retrieved chunks to real documents and build the pseudonymized,
 * per-document-numbered excerpt context shared by the assistant and the
 * report generator. Orphan-vector chunks (no D1 row — ADR 0009) and
 * empty-content chunks are dropped; they must never reach the model.
 */
export async function buildExcerptContext(
  env: Env,
  chunks: AiSearchChunk[],
  pseud: Pseudonymizer,
): Promise<ExcerptContext> {
  const allSources = await toSources(env, chunks);
  const bySourceId = new Map(allSources.map((s) => [s.id, s]));
  const resolvedChunks = chunks.filter((c) => {
    const id = docIdFromFolder(c.metadata.folder);
    return !!id && bySourceId.has(id) && c.content.trim() !== '';
  });

  const resolvedIds: string[] = [];
  const seen = new Set<string>();
  for (const c of resolvedChunks) {
    const id = docIdFromFolder(c.metadata.folder)!;
    if (!seen.has(id)) {
      seen.add(id);
      resolvedIds.push(id);
    }
  }
  const sources = resolvedIds.map((id) => bySourceId.get(id)!);

  const indexByDocId = new Map(sources.map((s, i) => [s.id, i + 1]));
  const contextText = resolvedChunks
    .map((c) => {
      const id = docIdFromFolder(c.metadata.folder)!;
      const src = bySourceId.get(id)!;
      const idx = indexByDocId.get(id)!;
      const label = `[Source ${idx}] ${src.category} — "${pseud.anonymize(src.title)}"`;
      return `${label}\n${pseud.anonymize(c.content)}`;
    })
    .join('\n\n');

  return { sources, contextText, documentsFound: sources.length > 0 };
}
