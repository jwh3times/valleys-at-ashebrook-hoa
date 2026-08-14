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
//  1. NO AUTHORIZATION DECISION depends on the new model. Derivation computes
//     an answer, but only the shadow comparison consumes it; every guard still
//     reads legacy. This is the property that makes phase 2 reversible by
//     flipping a flag rather than by reverting code.
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
