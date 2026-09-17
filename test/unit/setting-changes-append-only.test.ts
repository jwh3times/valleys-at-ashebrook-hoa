import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `setting_changes` (#363, ADR 0024) is append-only BY CONVENTION — D1 has
 * one binding and this codebase forbids triggers, so nothing in the database
 * itself can refuse an UPDATE or DELETE against the table. This is the static
 * guard: no route may write SQL, raw or through Drizzle, that updates or
 * deletes a `setting_changes`/`settingChanges` row. The one legitimate writer
 * (`setSiteGate` in `src/pages/api/admin/site.ts`) only ever INSERTs.
 *
 * Modelled on `ballot-privacy-boundary.test.ts`'s static scan: the failure
 * this guards against is a future edit — a "fix the actor id" correction
 * route, say — that would look reasonable in review but would quietly let a
 * board member rewrite what an earlier board member did.
 */

const SRC = join(process.cwd(), 'src');

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

describe('setting_changes is append-only', () => {
  it('has no UPDATE or DELETE against the table anywhere in src/, raw or Drizzle', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      const rel = file
        .slice(SRC.length + 1)
        .split('\\')
        .join('/');

      // Raw SQL: UPDATE/DELETE naming the table, case-insensitively, in
      // either quoting style.
      if (/UPDATE\s+["`]?setting_changes["`]?/i.test(text))
        offenders.push(`${rel}: raw UPDATE against setting_changes`);
      if (/DELETE\s+FROM\s+["`]?setting_changes["`]?/i.test(text))
        offenders.push(`${rel}: raw DELETE against setting_changes`);

      // Drizzle: db.update(settingChanges) / db.delete(settingChanges).
      if (/\.update\(\s*settingChanges\s*\)/.test(text))
        offenders.push(`${rel}: Drizzle .update(settingChanges)`);
      if (/\.delete\(\s*settingChanges\s*\)/.test(text))
        offenders.push(`${rel}: Drizzle .delete(settingChanges)`);
    }
    expect(offenders).toEqual([]);
  });

  it('has at least one INSERT-only writer, so the scan above is not vacuous', () => {
    const site = readFileSync(
      join(SRC, 'pages', 'api', 'admin', 'site.ts'),
      'utf8',
    );
    expect(site).toMatch(/INSERT INTO setting_changes/);
    expect(site).not.toMatch(/UPDATE\s+["`]?setting_changes["`]?/i);
    expect(site).not.toMatch(/DELETE\s+FROM\s+["`]?setting_changes["`]?/i);
  });
});
