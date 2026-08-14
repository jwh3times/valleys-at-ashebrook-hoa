import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';

// ADR 0022 phase 2: READ-ONLY preview of the new roster (issue #210).
//
// There is no POST, PATCH, or DELETE here, and there must not be one until
// phase 3. The phase-2 backfill is an idempotent CLEAN-REPLACE: anything a
// board member wrote to these tables would be silently erased by the next
// rehearsal run, and again by the authoritative run inside the write-freeze.
// Legacy stays the only roster editor until the flip.
//
// Gated with `requireBoard` like every other admin route. The finer boundary
// this surface eventually needs — the redaction and audit-integrity sections
// restricted to System Administration Access — cannot be enforced yet, because
// capabilities do not become authoritative until phase 3. Until then the whole
// preview is board-only, which is the more restrictive of the two.

interface CountRow {
  label: string;
  n: number;
}

/** Structural counts and a small sample. IDs and non-personal fields only —
 * this is a migration-inspection surface, not a roster browser, and it must not
 * become a second way to read resident contact details. */
const SECTIONS = {
  roster: [
    ['Lots', 'SELECT COUNT(*) AS n FROM properties WHERE retired_at IS NULL'],
    [
      'Retired Lots',
      'SELECT COUNT(*) AS n FROM properties WHERE retired_at IS NOT NULL',
    ],
    ['Parties', 'SELECT COUNT(*) AS n FROM parties'],
    [
      '  of which people',
      "SELECT COUNT(*) AS n FROM parties WHERE kind = 'person'",
    ],
    [
      '  of which organizations',
      "SELECT COUNT(*) AS n FROM parties WHERE kind = 'organization'",
    ],
    [
      'Current Ownerships',
      'SELECT COUNT(*) AS n FROM ownerships WHERE end_day IS NULL AND voided_at IS NULL',
    ],
    [
      'Contact Methods',
      'SELECT COUNT(*) AS n FROM contact_methods WHERE voided_at IS NULL',
    ],
    [
      'Current Representations',
      'SELECT COUNT(*) AS n FROM representations WHERE end_day IS NULL AND voided_at IS NULL',
    ],
  ],
  board: [
    [
      'Board Terms',
      'SELECT COUNT(*) AS n FROM board_service_terms WHERE voided_at IS NULL',
    ],
    [
      'Office Assignments',
      'SELECT COUNT(*) AS n FROM board_office_assignments WHERE voided_at IS NULL',
    ],
  ],
  access: [
    [
      'Live Board grants',
      "SELECT COUNT(*) AS n FROM access_grants WHERE grant_type = 'board' AND ended_at IS NULL",
    ],
    [
      'Live System Administration grants',
      "SELECT COUNT(*) AS n FROM access_grants WHERE grant_type = 'system_admin' AND ended_at IS NULL",
    ],
    [
      'Current Person Links',
      'SELECT COUNT(*) AS n FROM person_links WHERE ended_at IS NULL',
    ],
  ],
  review: [
    [
      'Open Review Flags',
      "SELECT COUNT(*) AS n FROM review_flags WHERE status = 'open'",
    ],
    ['Audit Events', 'SELECT COUNT(*) AS n FROM audit_events'],
  ],
  compliance: [
    [
      'Audit integrity violations',
      'SELECT COUNT(*) AS n FROM audit_integrity_violations_v',
    ],
    [
      'Board eligibility violations',
      'SELECT COUNT(*) AS n FROM board_eligibility_violations_v',
    ],
    ['Redactions recorded', 'SELECT COUNT(*) AS n FROM roster_redactions'],
    [
      'Pending redaction cleanup',
      "SELECT COUNT(*) AS n FROM redaction_tasks WHERE status = 'pending'",
    ],
    [
      'Unexplained shadow mismatches',
      'SELECT COUNT(*) AS n FROM cutover_shadow_mismatches WHERE explained_as IS NULL',
    ],
    [
      'Explained shadow mismatches',
      'SELECT COUNT(*) AS n FROM cutover_shadow_mismatches WHERE explained_as IS NOT NULL',
    ],
  ],
} as const;

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;

  const entries = Object.entries(SECTIONS).flatMap(([section, rows]) =>
    rows.map(([label, sql]) => ({ section, label, sql })),
  );

  const results = await env.DATABASE.batch(
    entries.map((e) => env.DATABASE.prepare(e.sql)),
  );

  const sections: Record<string, CountRow[]> = {};
  entries.forEach((entry, i) => {
    const n =
      ((results[i]?.results as { n: number }[]) ?? [{ n: 0 }])[0]?.n ?? 0;
    sections[entry.section] = [
      ...(sections[entry.section] ?? []),
      { label: entry.label, n },
    ];
  });

  return new Response(JSON.stringify({ sections }), {
    headers: { 'content-type': 'application/json' },
  });
};
