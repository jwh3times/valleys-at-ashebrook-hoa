import fs from "node:fs";
import path from "node:path";

/**
 * Governing documents are described in `content/documents.json` and the actual
 * files live in `public/documents/`. Each entry:
 *
 *   {
 *     "title": "Covenants, Conditions & Restrictions (CC&Rs)",
 *     "category": "Governing Documents",
 *     "file": "ccrs.pdf",
 *     "updated": "2025-01-15",
 *     "description": "The recorded CC&Rs for the community."
 *   }
 *
 * To publish a document: drop the PDF into `public/documents/` and add an entry
 * here. `category`, `updated`, and `description` are optional.
 */

const DOCUMENTS_FILE = path.join(process.cwd(), "content", "documents.json");

export type GoverningDocument = {
  title: string;
  category: string;
  /** File name within `public/documents/`. */
  file: string;
  updated?: string;
  description?: string;
};

export function getDocuments(): GoverningDocument[] {
  if (!fs.existsSync(DOCUMENTS_FILE)) return [];
  const raw = fs.readFileSync(DOCUMENTS_FILE, "utf8");
  const parsed = JSON.parse(raw) as GoverningDocument[];
  return parsed.filter((d) => d && d.title && d.file);
}

/** Documents grouped by category, categories alphabetized. */
export function getDocumentsByCategory(): [string, GoverningDocument[]][] {
  const groups = new Map<string, GoverningDocument[]>();
  for (const doc of getDocuments()) {
    const category = doc.category || "General";
    const list = groups.get(category) ?? [];
    list.push(doc);
    groups.set(category, list);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
