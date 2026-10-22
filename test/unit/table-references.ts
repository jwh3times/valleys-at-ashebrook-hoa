import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The table-reference scanner shared by the static boundary suites
// (`legacy-roster-consumers`, `tenancy-not-lot-authority`). It reports which of
// a set of tables a source touches, by either signal: importing the table's
// Drizzle symbol from a schema module, or naming it after a SQL keyword.

/** Every `.ts`, `.tsx` and `.astro` file under `dir`. */
export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (/\.(ts|tsx|astro)$/.test(entry)) out.push(full);
  }
  return out;
}

/** URLs are neutralised first: a doc link would otherwise read as a line
 * comment and swallow the rest of its line, HIDING a reference rather than
 * merely over-reporting one. */
export function stripComments(source: string): string {
  return source
    .replace(/https?:\/\//g, 'url_')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, '');
}

/**
 * Which of `tables` (Drizzle symbol -> SQL table name) this source touches.
 * Imports count from `db/schema`, `auth-schema` and `roster-schema`.
 */
export function tablesReferencedIn(
  source: string,
  tables: Record<string, string>,
): string[] {
  const code = stripComments(source);
  const found = new Set<string>();

  for (const match of code.matchAll(
    /import[^;]*?\{([^}]*)\}[^;]*?from[^;]*?['"][^'"]*(?:db\/schema|auth-schema|roster-schema)['"]/g,
  )) {
    for (const raw of match[1].split(',')) {
      const symbol = raw
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        .trim();
      if (symbol in tables) found.add(tables[symbol]);
    }
  }

  for (const table of Object.values(tables)) {
    const querying = new RegExp(
      String.raw`(FROM|JOIN|INTO|UPDATE|TABLE)\s+${table}\b`,
      'i',
    );
    if (querying.test(code)) found.add(table);
  }

  return [...found].sort();
}
