import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Permanent guard against reintroducing references to removed roster tables. */
const SRC = join(process.cwd(), 'src');

const DROPPED: Record<string, string> = {
  owners: 'owners',
  userPropertyLinks: 'user_property_links',
  propertyVerifications: 'property_verifications',
  manualApprovalQueue: 'manual_approval_queue',
  boardPeople: 'board_people',
  properties: 'properties',
  boardServiceTerms: 'board_service_terms',
};

function sourceFiles(dir: string): string[] {
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

const relativePath = (file: string) => relative(SRC, file).split(sep).join('/');

/** URLs are neutralised first: a doc link would otherwise read as a line
 * comment and swallow the rest of its line, HIDING a reference rather than
 * merely over-reporting one. */
function stripComments(source: string): string {
  return source
    .replace(/https?:\/\//g, 'url_')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, '');
}

/** Which dropped tables this source actually touches, by either signal. */
function droppedTablesIn(source: string): string[] {
  const code = stripComments(source);
  const found = new Set<string>();

  for (const match of code.matchAll(
    /import[^;]*?\{([^}]*)\}[^;]*?from[^;]*?['"][^'"]*(?:db\/schema|auth-schema)['"]/g,
  )) {
    for (const raw of match[1].split(',')) {
      const symbol = raw
        .trim()
        .split(/\s+as\s+/)[0]
        .trim();
      if (symbol in DROPPED) found.add(DROPPED[symbol]);
    }
  }

  for (const table of Object.values(DROPPED)) {
    const querying = new RegExp(
      String.raw`(FROM|JOIN|INTO|UPDATE|TABLE)\s+${table}\b`,
      'i',
    );
    if (querying.test(code)) found.add(table);
  }

  return [...found].sort();
}

describe('permanent roster schema', () => {
  it('has no serving-code references to removed or renamed tables', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const tables = droppedTablesIn(readFileSync(file, 'utf8'));
      if (tables.length > 0)
        offenders.push(`${relativePath(file)} reads ${tables.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
