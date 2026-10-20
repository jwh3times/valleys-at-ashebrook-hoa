import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { documents } from '../db/schema';
import { retrieveFrom, type AiSearchChunk } from './search';
import type { Pseudonymizer } from './pii';

// The governing documents (#305, #453). A vector search over the whole library
// ranks correspondence and checklists above the bylaws and covenants, so the
// assistant and reports also search within this category on its own, and list
// it to the model so it knows these documents exist even when no passage from
// one is retrieved.

const GOVERNING_CATEGORY = 'Governing Documents';

export interface GoverningDocument {
  id: string;
  title: string;
}

export function loadGoverningDocuments(env: Env): Promise<GoverningDocument[]> {
  return getDb(env)
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(eq(documents.category, GOVERNING_CATEGORY))
    .orderBy(documents.title);
}

/**
 * The governing passages for `query`. A supplement to the library-wide
 * search, so a failure here leaves them out rather than failing the caller;
 * the model is still told the governing documents exist.
 */
export async function governingPassages(
  env: Env,
  query: string,
  docs: GoverningDocument[],
): Promise<AiSearchChunk[]> {
  try {
    return await retrieveFrom(
      env,
      query,
      docs.map((d) => d.id),
    );
  } catch (err) {
    console.error('[governing] governing-documents search failed', err);
    return [];
  }
}

/** The list the model is given, with each title pseudonymized; '' when the
 * library holds no governing document. */
export function governingCatalog(
  docs: GoverningDocument[],
  pseud: Pseudonymizer,
): string {
  if (docs.length === 0) return '';
  const lines = docs.map((d) => `- "${pseud.anonymize(d.title)}"`).join('\n');
  return `Governing documents in the library:\n${lines}\n\n`;
}

/** The system-prompt instruction that goes with the catalog. */
export function governingInstruction(subject: 'question' | 'topic'): string {
  return `The excerpts are the passages that best match the ${subject}, not whole documents. The message also lists the governing documents the library holds. Never say the association lacks a document on that list: if no excerpt from it covers the point, say the excerpts provided do not cover it.`;
}

/** `chunks` in order, without a second copy of any passage (the same text
 * from the same twin, however many searches returned it). */
export function uniqueChunks(chunks: AiSearchChunk[]): AiSearchChunk[] {
  const seen = new Set<string>();
  return chunks.filter((c) => {
    const key = `${c.metadata.folder}\n${c.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
