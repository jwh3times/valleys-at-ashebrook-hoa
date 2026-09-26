import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Permanent module boundary: authorization resolves through context/derive;
// content reads may access only declared identity/authority tables, never
// grants or audit internals. The write freeze remains an independent switch.

const SRC = join(process.cwd(), 'src');

/** May reference the new tables. Each earns it, and nothing else does. */
const ALLOWED = new Set([
  // Registers every schema module so migrations and types stay coherent.
  'server/db/client.ts',
  // Derivation: the derived model's read side.
  'server/authz/derive.ts',
  // The operator freeze reader is scoped to cutover_settings below.
  'server/authz/write-freeze.ts',
  // The failed-grant-re-validation Access Event writer (#217, option 1).
  'server/authz/revalidation-event.ts',
  // The read-only admin preview route. (Its phase-2 panel, RosterPreview.tsx,
  // was retired by phase 3e in favor of the five writable panels.)
  'pages/api/admin/roster-preview.ts',
  'pages/api/admin/roles.ts',
]);

/**
 * Content modules that legitimately reach the party roster, and what for.
 *
 * #248 part 2 (migration 0029) repointed `member_attendance`, `member_votes`,
 * `ballots`, and `proxies` off the legacy `owners` table onto
 * `people(party_id)`. Answering "who may act for this lot" is therefore a
 * roster question now, and these are the modules that ask it. They read
 * IDENTITY AND AUTHORITY only — see ROSTER_TABLES_ALLOWED_IN_CONTENT.
 */
const ROSTER_READING_CONTENT = new Map([
  [
    'casting-authority.ts',
    'the shared voting read and mutation predicates, which resolve the ' +
      "current Person Link and that Person's Lot Authority",
  ],
  [
    'proxy-guards.ts',
    'the phase-3d grantor re-validation, which asks whether a proxy grantor ' +
      'still holds the lot',
  ],
  [
    'voting.ts',
    "the cast path's preflight and its mutation-boundary authority predicate",
  ],
  [
    'voting-reads.ts',
    'the provenance options offered for a caller lot at /vote',
  ],
  [
    'reads.ts',
    'the Person names on member attendance, member votes, ballots and ' +
      'proxies, and the member lot pickers',
  ],
]);

/**
 * What a declared content module may name. Identity and authority — never
 * access, never the ledger, never the cutover flags.
 */
const ROSTER_TABLES_ALLOWED_IN_CONTENT = new Set([
  'parties',
  'ownerships',
  'person_links',
  'representations',
]);

/** Does this module reach the roster indirectly, via an import? */
function importsRoster(text: string): boolean {
  return /from '[^']*(db\/roster-schema|roster\/authority)'/.test(text);
}

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
  // #248: the meeting and elections records name WHO ACTED, and that identity
  // is the roster's Person now rather than the retired `board_people` row.
  // These read `people`/`parties` to offer and validate that link — they write
  // no roster row, and the roster remains the party surfaces' to write.
  'pages/api/admin/meetings.ts',
  'pages/api/admin/candidates.ts',
  // #248 part 2: the proxies record names a Person as grantor and holder, so
  // the board route pre-checks that Person exists and the member route offers
  // the lot's authority holders. Neither writes a roster row.
  'pages/api/admin/proxies.ts',
  // Phase 3e (#221): the legacy role surface, re-pointed behind the cutover
  // flag. Its `derived` branch writes Access Grants; its `legacy` branch is
  // unchanged.
  'pages/api/admin/roles.ts',
  // Shared server modules for the routes above.
  'server/roster/audit.ts',
  'server/roster/access.ts',
  'server/roster/reads.ts',
  'server/roster/board-consequences.ts',
  'server/roster/verification.ts',
  'server/roster/identity.ts',
  'server/roster/bootstrap.ts',
  'server/roster/transfer-effects.ts',
  // #248 part 2: the single definition of "this Person holds Lot Authority
  // over this Lot", shared by the content guards and the casting SQL.
  'server/roster/authority.ts',
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
    for (const file of ['write-freeze.ts']) {
      const text = readFileSync(join(SRC, 'server', 'authz', file), 'utf8');
      for (const name of forbidden) {
        if (text.includes(name)) offenders.push(`${file} references ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('lets only declared content modules reach the roster, for identity only', () => {
    // The narrowed form of rule 2. An undeclared content module reaching the
    // roster — directly or through roster/authority.ts — is the quiet leak
    // this catches; so is a declared one wandering from identity into access
    // or the audit ledger.
    const offenders: string[] = [];
    for (const file of sourceFiles(join(SRC, 'server', 'content'))) {
      const rel = relativePath(file);
      const name = rel.slice('server/content/'.length);
      const text = readFileSync(file, 'utf8');
      const declared = ROSTER_READING_CONTENT.has(name);
      const named = NEW_TABLES.filter((table) => text.includes(table));
      if (!declared) {
        for (const table of named) offenders.push(`${rel} reads ${table}`);
        if (importsRoster(text))
          offenders.push(`${rel} imports the roster without being declared`);
        continue;
      }
      for (const table of named) {
        if (!ROSTER_TABLES_ALLOWED_IN_CONTENT.has(table))
          offenders.push(`${rel} reads ${table}, which is not identity`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the declared content list honest as modules are repointed', () => {
    // The anti-rot half, matching legacy-roster-consumers.test.ts: a module
    // listed here that no longer reaches the roster tells a future reader
    // there is a boundary to respect where there is none.
    const stale: string[] = [];
    for (const name of ROSTER_READING_CONTENT.keys()) {
      const text = readFileSync(join(SRC, 'server', 'content', name), 'utf8');
      const reaches =
        importsRoster(text) || NEW_TABLES.some((t) => text.includes(t));
      if (!reaches) stale.push(`${name} no longer reaches the roster`);
    }
    expect(stale).toEqual([]);
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
