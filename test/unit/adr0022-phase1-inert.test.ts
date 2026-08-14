import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ADR 0022 phase 1 ("expand") must be BEHAVIORALLY INERT — see issue #209.
//
// The whole safety argument for landing ~30 tables in one go is that nothing
// reads them, so the site cannot change behavior. That argument is only as good
// as its enforcement: a single stray import in a route or page would quietly
// turn an inert migration into a live dependency, and the phase-2 backfill's
// clean-replace would then be erasing data something actually reads.
//
// This test is the enforcement. It is expected to be DELETED in phase 2, when
// derivation legitimately starts reading these tables.

const SRC = join(process.cwd(), 'src');

// Legitimate readers, and only these:
//
//   client.ts   — registers every schema module so migrations and types stay
//                 coherent. Registration is not reading.
//   derive.ts   — phase 2's derived-authorization module. It reads the new
//                 tables by design, but in phase 2 its result is compared and
//                 discarded; legacy still decides every request.
//
// The guard that remains is the one still worth having: no page, route,
// component, or content read may touch these tables. That boundary holds until
// the phase-3 flip, and this test is deleted with it.
//   shadow.ts   — phase 2's comparison. It reads the derived model and writes
//                 the operator-only mismatch table, and is structurally
//                 incapable of changing a response.
const ALLOWED = new Set([
  'server/db/client.ts',
  'server/authz/derive.ts',
  'server/authz/shadow.ts',
]);

const PHASE_1_MODULES = ['roster-schema', 'audit-schema', 'cutover-schema'];

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

describe('ADR 0022 phase 1 is behaviorally inert', () => {
  it('is imported by nothing under src/ except the D1 client', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/');
      // The schema modules import each other by design.
      if (PHASE_1_MODULES.some((m) => rel === `server/db/${m}.ts`)) continue;
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      for (const module of PHASE_1_MODULES) {
        if (text.includes(`db/${module}`) || text.includes(`./${module}`)) {
          offenders.push(`${rel} imports ${module}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does not reference a phase 1 table name anywhere under src/', () => {
    // Catches a raw SQL string that bypasses the Drizzle import entirely.
    const tables = [
      'parties',
      'contact_methods',
      'ownerships',
      'representations',
      'person_links',
      'person_verifications',
      'board_service_terms',
      'board_office_assignments',
      'access_grants',
      'audit_events',
      'review_flags',
      'cutover_settings',
      'cutover_shadow_mismatches',
    ];
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/');
      if (rel.startsWith('server/db/')) continue;
      // derive.ts names these tables in raw SQL by design — that IS the
      // derivation. Everything else naming one is reading the new model from
      // somewhere it must not be read yet.
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      for (const table of tables) {
        if (text.includes(table)) offenders.push(`${rel} mentions ${table}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
