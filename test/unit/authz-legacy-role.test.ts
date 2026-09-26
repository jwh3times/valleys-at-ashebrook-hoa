import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Keep stored roles out of authorization. Only context.ts may resolve a
 * Better Auth session; behavioral API tests prove it ignores the session role. */

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

function files(dir: string, exts = ['.ts']): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...files(full, exts));
      continue;
    }
    if (exts.some((e) => entry.endsWith(e))) out.push(full);
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
    // The session reader must exist so the import boundary is not vacuous.
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

describe('the content tier is never used as an access check', () => {
  // `contentTier` answers what a caller may READ; what a caller may DO is
  // `ctx.capabilities`. A COMPARISON on the tier is a guard-shaped use, and
  // this scan keeps the call sites fixed in phase 3a (owner-lookup, the
  // voting preflights, the proxies and vote pages) from growing back. Phase 4
  // (#212) retired the `role` alias this used to watch; the rule moved with
  // the value it named.
  //
  // A convention scan, not a proof: it matches the `ctx` naming convention, so
  // a differently-named context variable slips it (src/lib/site.ts's `auth`
  // param does, legitimately — its tier reads decide which nav links render,
  // which is presentation). Reads that pass the tier onward, like
  // `visibleTiers(ctx.contentTier)`, are content reads and deliberately not
  // matched.
  it('is never compared against a literal outside the guards', () => {
    const pattern = /\bctx[!?]?\.contentTier\s*[!=]==/;
    const src = join(process.cwd(), 'src');
    const offenders: string[] = [];
    for (const file of files(src, ['.ts', '.tsx', '.astro'])) {
      const name = relative(src, file).split('\\').join('/');
      if (pattern.test(readFileSync(file, 'utf8'))) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
