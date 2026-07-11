import path from 'node:path';
import {
  safeObjectName,
  contentTypeFor,
  type DocumentEntry,
} from './import-documents.ts';

export interface ManifestEntry {
  relativePath: string;
  title: string;
  category: string;
  visibility: string;
  ragRelPath: string | null;
}

export function ragKeyFor(id: string): string {
  return `rag/${id}.md`;
}

/** Build a D1/R2 DocumentEntry for a manifest row + assigned uuid. sizeBytes is
 * filled by the importer after stat; default 0 keeps this pure/testable. */
export function toDocumentEntry(
  m: ManifestEntry,
  id: string,
  sizeBytes = 0,
): DocumentEntry {
  const filename = path.basename(m.relativePath);
  return {
    id,
    relativePath: m.relativePath,
    filename,
    title: m.title,
    category: m.category,
    visibility: m.visibility,
    r2Key: `documents/${id}/${safeObjectName(filename)}`,
    sizeBytes,
    contentType: contentTypeFor(filename),
  };
}
