import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// The ADR 0022 model boundary (issues #210, #217, #218).
//
// This began as a phase-1 inertness guard: nothing under `src/` could so much
// as name the new tables. Each phase deliberately crosses part of that line —
// phase 2 let derivation read them in shadow, phase 3a let `cutover_mode`
// decide which model answers, and phase 3b (#218) built the routes that WRITE
// the new roster — so the guard is narrowed each time to the boundary that
// STILL matters, rather than deleted.
//
// What must remain true until phase 4 (#212):
//
//  1. AUTHORIZATION REACHES THE NEW MODEL ONLY THROUGH THE FLAG. The ONLY
//     route from a request to the new model runs through `context.ts` and
//     `cutover_mode`, whose default and failure mode are both `legacy`. No
//     guard, page, or content read reaches past that seam into the roster
//     tables itself. (`revalidation-event.ts` is the one authz module that
//     WRITES the ledger — the #217-decided Access Event — and it is called
//     only from the derived serving path, never from shadow.)
//
//  2. NO MEMBER OR PUBLIC CONTENT READ touches the new tables. Tier-filtered
//     reads stay on the legacy roster until the flip.
//
//  3. THE NEW-MODEL SURFACE IS A DECLARED INVENTORY. Phase 3b retired the
//     phase-2 claim that nothing writes the new roster through a route — the
//     roster, board-service, and access routes exist precisely to write it.
//     What replaces the claim is an enumeration: every file under `src/pages`
//     and every module under `src/server/roster` that references the new
//     tables must be declared below, so a public page or a legacy verification
//     module cannot quietly start reading roster rows. (Note for operators
//     until the flip: the phase-2 backfill rehearsal clean-replaces these
//     tables, so rows written through the 3b routes before the authoritative
//     run are erased by a rehearsal — sequencing owned by #222.)
//
// Deleted in phase 4, when the legacy model is gone and the inventory is the
// whole application.

const SRC = join(process.cwd(), 'src');

/** May reference the new tables. Each earns it, and nothing else does. */
const ALLOWED = new Set([
  // Registers every schema module so migrations and types stay coherent.
  'server/db/client.ts',
  // Derivation: the derived model's read side.
  'server/authz/derive.ts',
  // The comparison, and the operator-only mismatch table it writes.
  'server/authz/shadow.ts',
  'server/authz/shadow-compare.ts',
  // The two operational flag readers. Both scoped to cutover_settings by their
  // own test below.
  'server/authz/write-freeze.ts',
  'server/authz/cutover-mode.ts',
  // The failed-grant-re-validation Access Event writer (#217, option 1).
  'server/authz/revalidation-event.ts',
  // The read-only admin preview route. (Its phase-2 panel, RosterPreview.tsx,
  // was retired by phase 3e in favor of the five writable panels.)
  'pages/api/admin/roster-preview.ts',
]);

/**
 * The phase 3b (#218) inventory: routes that operate the new roster, and the
 * server modules they share. A file referencing the new tables must appear
 * here or in ALLOWED; a new roster surface is added by extending this list in
 * the same PR that adds the route.
 */
const NEW_MODEL_SURFACE = new Set([
  // Board service and access.
  'pages/api/admin/board-service.ts',
  'pages/api/admin/access-grants.ts',
  // The roster surfaces.
  'pages/api/admin/roster.ts',
  'pages/api/admin/roster-lots.ts',
  'pages/api/admin/roster-parties.ts',
  'pages/api/admin/roster-ownerships.ts',
  'pages/api/admin/roster-representations.ts',
  'pages/api/admin/roster-contact-methods.ts',
  'pages/api/admin/roster-export.ts',
  // Member correction requests and their board review surface.
  'pages/api/admin/correction-requests.ts',
  'pages/api/member/roster-self.ts',
  'pages/api/member/correction-requests.ts',
  // The System-Administrator-only compliance surfaces.
  'pages/api/admin/redactions.ts',
  'pages/api/admin/access-denials.ts',
  'pages/api/admin/audit-integrity.ts',
  // Election certification creates Persons and board service terms (#203).
  'pages/api/admin/elections.ts',
  // Phase 3c (#219): Person Verification, Person Links, and bootstrap.
  'pages/api/verify/request.ts',
  'pages/api/verify/confirm.ts',
  'pages/api/verify/review.ts',
  'pages/api/verify/unlink.ts',
  'pages/api/bootstrap/board.ts',
  'pages/api/admin/person-links.ts',
  'pages/api/admin/verification-requests.ts',
  // Phase 3d (#220): transfer-time effects and the review-flag queue.
  'pages/api/admin/review-flags.ts',
  // Phase 3e (#221): the two legacy role surfaces, re-pointed behind the
  // cutover flag. Their `derived` branch writes Access Grants and Person Link
  // endings; their `legacy` branch is unchanged.
  'pages/api/admin/roles.ts',
  'pages/api/admin/members.ts',
  // Shared server modules for the routes above.
  'server/roster/audit.ts',
  'server/roster/access.ts',
  'server/roster/reads.ts',
  'server/roster/board-consequences.ts',
  'server/roster/verification.ts',
  'server/roster/identity.ts',
  'server/roster/bootstrap.ts',
  'server/roster/transfer-effects.ts',
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
  'roster_changes',
  'board_service_changes',
  'access_events',
  'review_flags',
  'redaction_tasks',
  'correction_requests',
  'identity_events',
  'verification_codes',
  'verification_review_requests',
  'system_admin_bootstrap',
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

describe('the ADR 0022 model boundary', () => {
  it('keeps every guard except derivation on the legacy model', () => {
    // The load-bearing one. If a guard starts reading the new tables outside
    // the flag seam, the flip stops being reversible by flipping a flag.
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

  it('confines the new roster to the declared route and module inventory', () => {
    // Phase 3b's replacement for "exposes no route that writes the new
    // roster": the routes exist now, so the boundary is that ONLY the declared
    // inventory references the new model. A public page, a content read, or an
    // undeclared route naming a roster table is exactly the quiet leak this
    // file exists to stop.
    const offenders: string[] = [];
    const scanned = [
      ...sourceFiles(join(SRC, 'pages')),
      ...sourceFiles(join(SRC, 'server', 'roster')),
    ];
    for (const file of scanned) {
      const rel = relativePath(file);
      if (ALLOWED.has(rel) || NEW_MODEL_SURFACE.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      const touched = [
        ...NEW_TABLES.filter((t) => text.includes(t)),
        ...PHASE_1_MODULES.filter((m) => text.includes(m)),
      ];
      for (const name of touched) {
        offenders.push(`${rel} references ${name} without being declared`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
