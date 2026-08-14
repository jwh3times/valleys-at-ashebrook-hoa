import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * ADR 0022 phase 3a (#217): nothing under `src/server/authz/` reads
 * `users.role` as an authorization fact.
 *
 * A phase-3 acceptance criterion and a phase-4 (#212) precondition. It guards
 * against a guard quietly consulting the stored column again — which no
 * behavioral test would catch, because legacy synthesis happens to agree with
 * the column today, so a module reading either one passes every existing test.
 *
 * This checks IMPORTS rather than property access. Grepping for `.role` reads
 * comments as code and misses `(result.user as { role?: unknown }).role`, so it
 * fails in both directions. What a module imports is unambiguous, and it is
 * also the real precondition: a module that cannot reach the session or the
 * `users` table cannot read the column no matter how it is written.
 *
 * `context.ts` is the ONE place allowed to. That is the seam — it turns the
 * legacy column into an `AuthContext` under `cutover_mode = legacy`, and nothing
 * downstream knows the column exists. Phase 4 deletes both.
 */

const AUTHZ = join(process.cwd(), 'src', 'server', 'authz');

/** The seam itself. Nothing else in this directory earns an entry. */
const SEAM = 'context.ts';

/**
 * Import specifiers that expose the stored role: the Better Auth factory, whose
 * session carries `user.role`, and the schema modules declaring the column.
 */
const ROLE_BEARING = [
  /from\s+['"][^'"]*\/auth['"]/,
  /from\s+['"][^'"]*auth-schema['"]/,
  /\busers\b[^\n]*from\s+['"][^'"]*\/db\/schema['"]/,
];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...files(full));
      continue;
    }
    if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Import lines only — so a doc comment mentioning `users.role` is not a hit. */
const importLines = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => /^\s*import\b/.test(l))
    .join('\n');

describe('the authorization layer and the legacy role column', () => {
  it('found the authz modules to check', () => {
    expect(files(AUTHZ).length).toBeGreaterThanOrEqual(8);
  });

  it('can reach the stored role only from the seam', () => {
    const offenders: string[] = [];
    for (const file of files(AUTHZ)) {
      const name = relative(AUTHZ, file).split('\\').join('/');
      if (name === SEAM) continue;
      const imports = importLines(file);
      for (const pattern of ROLE_BEARING) {
        if (pattern.test(imports)) offenders.push(`${name} imports ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('still has the seam reaching it, so this test is not vacuous', () => {
    // If context.ts stops importing the session before phase 4 deletes the
    // column, the legacy half of the flip has silently broken and the
    // assertion above would still pass.
    const imports = importLines(join(AUTHZ, SEAM));
    expect(ROLE_BEARING.some((p) => p.test(imports))).toBe(true);
  });

  it('derives capability from the roster, never from the stored role', () => {
    // derive.ts is the new model's answer. It must not consult the column even
    // in passing — that would make the flip a no-op dressed as a migration.
    const imports = importLines(join(AUTHZ, 'derive.ts'));
    expect(ROLE_BEARING.filter((p) => p.test(imports))).toEqual([]);
  });
});
