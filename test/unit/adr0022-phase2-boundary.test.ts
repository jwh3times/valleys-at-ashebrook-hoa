import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// The ADR 0022 phase 2 boundary (issue #210).
//
// This began as a phase-1 inertness guard: nothing under `src/` could so much
// as name the new tables. Phase 2 deliberately crosses that line — derivation
// reads them, the shadow comparison writes its own table, and the read-only
// admin preview displays counts from them — so the guard is narrowed to the
// boundary that STILL matters, rather than deleted.
//
// What must remain true until the phase-3 flip:
//
//  1. AUTHORIZATION REACHES THE NEW MODEL ONLY THROUGH THE FLAG. Phase 3a
//     (#217) changed this invariant rather than retiring it, and the change is
//     that ticket's entire point: `cutover_mode` now selects which model
//     answers, so "no authorization decision depends on the new model" stopped
//     being true by design.
//
//     What replaces it is narrower and still load-bearing. The ONLY route from
//     a request to the new model runs through `context.ts` and the flag, whose
//     default and failure mode are both `legacy`. There is no second code path,
//     no dual-write, and no guard, page, or content read that reaches past that
//     seam into the roster tables itself.
//
//     The two operational modules under `authz/` that touch `cutover_settings`
//     — `write-freeze.ts` and `cutover-mode.ts` — are pinned by the test below
//     to that one table. Neither reads a roster or audit table, so neither can
//     become the wedge by which a guard starts deriving identity outside the
//     flag. `write-freeze.ts` in particular decides only WHETHER THE SITE
//     ACCEPTS MUTATIONS AT ALL, identically for every caller; it never decides
//     who a caller is, what tier they read, or which Lots are theirs.

//
//  2. NO MEMBER OR PUBLIC CONTENT READ touches the new tables. Tier-filtered
//     reads stay on the legacy roster until the flip.
//
//  3. NOTHING WRITES THE NEW ROSTER through a route. The backfill
//     clean-replaces these tables, so a board member's edit would be silently
//     erased — which is why the admin preview is read-only.
//
// Deleted at the flip, when all three stop being true by design.

const SRC = join(process.cwd(), 'src');

/** May reference the new tables. Each earns it, and nothing else does. */
const ALLOWED = new Set([
  // Registers every schema module so migrations and types stay coherent.
  'server/db/client.ts',
  // Phase 2 derivation. Its result is compared and discarded.
  'server/authz/derive.ts',
  // The comparison, and the operator-only mismatch table it writes.
  'server/authz/shadow.ts',
  'server/authz/shadow-compare.ts',
  // The two operational flag readers. Both scoped to cutover_settings by their
  // own test below; see invariant 1 for why neither breaks it.
  'server/authz/write-freeze.ts',
  'server/authz/cutover-mode.ts',
  // The read-only admin preview and its route.
  'pages/api/admin/roster-preview.ts',
  'components/admin/RosterPreview.tsx',
]);

const PHASE_1_MODULES = ['roster-schema', 'audit-schema', 'cutover-schema'];

const NEW_TABLES = [
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

const relativePath = (file: string) =>
  relative(SRC, file).split('\\').join('/');

describe('the ADR 0022 phase 2 boundary', () => {
  it('keeps every guard except derivation on the legacy model', () => {
    // The load-bearing one. If a guard starts reading the new tables, phase 2
    // stops being reversible by flipping a flag.
    const offenders: string[] = [];
    for (const file of sourceFiles(join(SRC, 'server', 'authz'))) {
      const rel = relativePath(file);
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      for (const table of NEW_TABLES) {
        if (text.includes(table)) offenders.push(`${rel} reads ${table}`);
      }
      for (const module of PHASE_1_MODULES) {
        if (text.includes(module)) offenders.push(`${rel} imports ${module}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('lets the two flag readers read cutover_settings and nothing else', () => {
    // The narrow form of their exemption. A blanket entry in ALLOWED would make
    // this file a wedge: any future guard could read access_grants or
    // board_service_terms under cover of being "operational". They get
    // cutover_settings — one a maintenance switch that outlives the migration,
    // the other the flag that governs the flip — and nothing else.
    const forbidden = [
      ...NEW_TABLES.filter((t) => t !== 'cutover_settings'),
      'roster-schema',
      'audit-schema',
    ];
    const offenders: string[] = [];
    for (const file of ['write-freeze.ts', 'cutover-mode.ts']) {
      const text = readFileSync(join(SRC, 'server', 'authz', file), 'utf8');
      for (const name of forbidden) {
        if (text.includes(name)) offenders.push(`${file} references ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps content reads on the legacy roster', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(SRC, 'server', 'content'))) {
      const rel = relativePath(file);
      const text = readFileSync(file, 'utf8');
      for (const table of NEW_TABLES) {
        if (text.includes(table)) offenders.push(`${rel} reads ${table}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('exposes no route that writes the new roster', () => {
    // The backfill clean-replaces these tables on every rehearsal run, so an
    // edit made through a route would be silently erased.
    const offenders: string[] = [];
    for (const file of sourceFiles(join(SRC, 'pages'))) {
      const rel = relativePath(file);
      const text = readFileSync(file, 'utf8');
      const touchesNewModel =
        NEW_TABLES.some((t) => text.includes(t)) ||
        PHASE_1_MODULES.some((m) => text.includes(m));
      if (!touchesNewModel) continue;
      if (!ALLOWED.has(rel)) {
        offenders.push(`${rel} references the new roster`);
        continue;
      }
      for (const verb of ['POST', 'PATCH', 'PUT', 'DELETE']) {
        if (new RegExp(`export const ${verb}\\b`).test(text)) {
          offenders.push(`${rel} exports ${verb}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('leaves the legacy roster modules untouched by the new schema', () => {
    // `src/server/roster/` still serves legacy verification. Its normalizers
    // are shared with the backfill, which is fine; reading the new tables is
    // not.
    const offenders: string[] = [];
    for (const file of sourceFiles(join(SRC, 'server', 'roster'))) {
      const rel = relativePath(file);
      const text = readFileSync(file, 'utf8');
      for (const table of NEW_TABLES) {
        if (text.includes(table)) offenders.push(`${rel} reads ${table}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
