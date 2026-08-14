#!/usr/bin/env node
/**
 * ADR 0022 migration invariant gate.
 *
 * Runs after every migration and at every phase transition, daily through the
 * phase-3 quiet period, and weekly through the phase-4 soak. A non-empty result
 * BLOCKS the transition — this is a gate with an exit code, not a report. In
 * phase 4 it is promoted from a phase gate to a scheduled job on the existing
 * Worker cron trigger, because the checks that gate a migration are exactly the
 * checks that catch drift afterwards.
 *
 * Usage:
 *   npx tsx scripts/verify-invariants.ts --local
 *   npx tsx scripts/verify-invariants.ts --remote
 *
 * Every check is a query that MUST return zero rows. Adding a check means
 * adding a query whose result set is "the things that are wrong".
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

interface Check {
  name: string;
  /** What a returned row means, for the operator reading a red run. */
  meaning: string;
  sql: string;
  /** Set when a check cannot run until a later phase creates its view. */
  pendingPhase?: number;
}

/**
 * Overlap for inclusive-start / exclusive-end intervals, where a NULL start
 * reads as negative infinity (accepted legacy history) and a NULL end as open.
 */
function overlapPredicate(alias: string, other: string, end: string): string {
  return `(${alias}.start_day IS NULL OR ${other}.${end} IS NULL OR ${alias}.start_day < ${other}.${end})
      AND (${other}.start_day IS NULL OR ${alias}.${end} IS NULL OR ${other}.start_day < ${alias}.${end})`;
}

function intervalCheck(
  name: string,
  table: string,
  keyColumns: string[],
  end = 'end_day',
  live = `a.voided_at IS NULL AND b.voided_at IS NULL`,
): Check {
  const keys = keyColumns.map((c) => `a.${c} = b.${c}`).join(' AND ');
  return {
    name,
    meaning: `two overlapping ${table} rows share ${keyColumns.join(' + ')}`,
    sql: `SELECT a.id AS a_id, b.id AS b_id FROM ${table} a
          JOIN ${table} b ON ${keys} AND a.id < b.id
          WHERE ${live} AND ${overlapPredicate('a', 'b', end)}`,
  };
}

const CHECKS: Check[] = [
  {
    name: 'foreign_keys',
    meaning: 'a row references a parent that does not exist',
    sql: 'PRAGMA foreign_key_check',
  },

  // Interval non-overlap. These are transactional invariants at the mutation
  // boundary — a partial index cannot express interval overlap, and board
  // terms have a mandatory scheduled end so there is no `end IS NULL`
  // predicate to index at all. This is the backstop that proves the
  // transactional checks held.
  intervalCheck('ownership_overlap', 'ownerships', [
    'owner_party_id',
    'lot_id',
  ]),
  intervalCheck('representation_overlap', 'representations', [
    'representative_person_id',
    'organization_party_id',
  ]),
  intervalCheck('office_person_overlap', 'board_office_assignments', [
    'person_id',
  ]),
  intervalCheck('office_holder_overlap', 'board_office_assignments', [
    'office',
  ]),
  {
    name: 'board_term_person_overlap',
    meaning: 'one Person holds two overlapping Board Terms',
    sql: `SELECT a.id AS a_id, b.id AS b_id FROM board_service_terms a
          JOIN board_service_terms b ON a.person_id = b.person_id AND a.id < b.id
          WHERE a.voided_at IS NULL AND b.voided_at IS NULL
            AND a.cancelled_at IS NULL AND b.cancelled_at IS NULL
            AND a.start_day < COALESCE(b.actual_end_day, b.scheduled_end_day)
            AND b.start_day < COALESCE(a.actual_end_day, a.scheduled_end_day)`,
  },
  {
    name: 'board_term_lot_overlap',
    meaning: 'one Lot qualifies two overlapping Board Terms',
    sql: `SELECT a.id AS a_id, b.id AS b_id FROM board_service_terms a
          JOIN board_service_terms b ON a.qualifying_lot_id = b.qualifying_lot_id AND a.id < b.id
          WHERE a.voided_at IS NULL AND b.voided_at IS NULL
            AND a.cancelled_at IS NULL AND b.cancelled_at IS NULL
            AND a.start_day < COALESCE(b.actual_end_day, b.scheduled_end_day)
            AND b.start_day < COALESCE(a.actual_end_day, a.scheduled_end_day)`,
  },

  // Party subtype completeness. SQLite enforces child-to-parent through the
  // composite (id, kind) FK; the parent-to-child direction — every Party has
  // exactly one subtype row — is unenforceable in schema, so it is checked
  // here and written in one D1 batch.
  {
    name: 'party_subtype_completeness',
    meaning: 'a Party has no subtype row, or rows in both subtypes',
    sql: `SELECT p.id, p.kind FROM parties p
          LEFT JOIN people pe ON pe.party_id = p.id
          LEFT JOIN organizations o ON o.party_id = p.id
          WHERE (pe.party_id IS NULL AND o.party_id IS NULL)
             OR (pe.party_id IS NOT NULL AND o.party_id IS NOT NULL)`,
  },
  {
    name: 'party_consolidation_same_kind',
    meaning: 'a Party is consolidated into a Party of a different kind',
    sql: `SELECT a.id, a.kind, b.kind AS target_kind FROM parties a
          JOIN parties b ON a.consolidated_into_party_id = b.id
          WHERE a.kind <> b.kind`,
  },
  {
    name: 'party_consolidation_one_hop',
    meaning: 'a consolidation chain is longer than one hop',
    sql: `SELECT a.id FROM parties a
          JOIN parties b ON a.consolidated_into_party_id = b.id
          WHERE b.consolidated_into_party_id IS NOT NULL`,
  },

  // Ledger integrity. Every envelope has exactly one typed detail; the writers
  // enforce this in atomic batches, and this proves they did.
  {
    name: 'audit_event_detail_cardinality',
    meaning: 'an Audit Event has no typed detail, or more than one',
    sql: `SELECT e.id, e.family,
                 (SELECT COUNT(*) FROM roster_changes d WHERE d.event_id = e.id)
               + (SELECT COUNT(*) FROM board_service_changes d WHERE d.event_id = e.id)
               + (SELECT COUNT(*) FROM identity_events d WHERE d.event_id = e.id)
               + (SELECT COUNT(*) FROM access_events d WHERE d.event_id = e.id)
               + (SELECT COUNT(*) FROM roster_redactions d WHERE d.event_id = e.id)
               + (SELECT COUNT(*) FROM review_events d WHERE d.event_id = e.id)
               + (SELECT COUNT(*) FROM audit_record_corrections d WHERE d.event_id = e.id)
                 AS detail_count
          FROM audit_events e
          WHERE detail_count <> 1`,
  },
  {
    name: 'audit_causal_order',
    meaning:
      'an event is caused by a later event, or by one in another correlation',
    sql: `SELECT e.id FROM audit_events e
          JOIN audit_events c ON e.causing_event_id = c.id
          WHERE c.correlation_id <> e.correlation_id
             OR c.correlation_sequence >= e.correlation_sequence`,
  },
  {
    name: 'redaction_has_evidence_and_tasks',
    meaning: 'a redaction event has no evidence row, or no cleanup task',
    sql: `SELECT e.id FROM audit_events e
          WHERE e.family = 'roster_redaction'
            AND (NOT EXISTS (SELECT 1 FROM roster_redactions r WHERE r.event_id = e.id)
              OR NOT EXISTS (SELECT 1 FROM redaction_tasks t WHERE t.redaction_event_id = e.id))`,
  },
  {
    name: 'review_flag_has_opening_event',
    meaning: 'a Review Flag has no opening Review Event',
    sql: `SELECT f.id FROM review_flags f
          WHERE NOT EXISTS (SELECT 1 FROM review_events v WHERE v.review_flag_id = f.id)`,
  },

  // Ballot secrecy. Impact discovery is exactly the feature that would find
  // joining choices to owners convenient, so the prohibition is checked rather
  // than merely documented.
  {
    name: 'no_flag_references_ballot_choices',
    meaning: 'a Review Flag column references ballot_choices',
    sql: `SELECT name FROM pragma_table_info('review_flags')
          WHERE name LIKE '%choice%' OR name LIKE '%candidate%'`,
  },

  // View-backed checks. Phase 1 creates no views; phase 2 lands them with the
  // code that reads them, and these un-stub then.
  {
    name: 'audit_integrity_violations',
    meaning: 'the audit integrity view reported a violation',
    sql: 'SELECT * FROM audit_integrity_violations_v',
    pendingPhase: 2,
  },
  {
    name: 'board_eligibility_violations',
    meaning:
      'a Board Term outlived the Ownership or Representation qualifying it',
    sql: 'SELECT * FROM board_eligibility_violations_v',
    pendingPhase: 2,
  },
];

// Invoke wrangler's JS entry through the current Node binary rather than the
// `npx` shim. Two Windows hazards are avoided at once: `shell: true` would
// word-split the SQL argument (wrangler then reports "Unknown arguments: FROM,
// review_flags", which reads like a schema failure rather than a quoting bug),
// and spawning `npx.cmd` without a shell fails outright with EINVAL.
// Resolved through package.json rather than the bin path directly: wrangler's
// `exports` map does not expose `./bin/wrangler.js`, so resolving it fails.
const WRANGLER = join(
  dirname(createRequire(import.meta.url).resolve('wrangler/package.json')),
  'bin',
  'wrangler.js',
);

function runQuery(sql: string, remote: boolean): unknown[] {
  const out = execFileSync(
    process.execPath,
    [
      WRANGLER,
      'd1',
      'execute',
      'DATABASE',
      remote ? '--remote' : '--local',
      '--json',
      '--command',
      sql,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const parsed = JSON.parse(out) as { results?: unknown[] }[];
  return parsed[0]?.results ?? [];
}

function main(): void {
  const remote = process.argv.includes('--remote');
  if (!remote && !process.argv.includes('--local')) {
    console.error('Pass --local or --remote.');
    process.exit(2);
  }

  console.log(`verify-invariants: ${remote ? 'REMOTE' : 'local'}\n`);

  let failures = 0;
  let pending = 0;

  for (const check of CHECKS) {
    if (check.pendingPhase) {
      console.log(`  ⏳ ${check.name} — pending phase ${check.pendingPhase}`);
      pending += 1;
      continue;
    }
    let rows: unknown[];
    try {
      rows = runQuery(check.sql, remote);
    } catch (err) {
      console.error(`  ✗ ${check.name} — query failed`);
      console.error(String(err instanceof Error ? err.message : err));
      failures += 1;
      continue;
    }
    if (rows.length === 0) {
      console.log(`  ✓ ${check.name}`);
      continue;
    }
    failures += 1;
    console.error(
      `  ✗ ${check.name} — ${rows.length} row(s): ${check.meaning}`,
    );
    // IDs and codes only. These outputs are read by operators and pasted into
    // runbooks and alerts, so they must never carry personal values.
    for (const row of rows.slice(0, 10))
      console.error(`      ${JSON.stringify(row)}`);
    if (rows.length > 10) console.error(`      … ${rows.length - 10} more`);
  }

  console.log(
    `\n${CHECKS.length - pending} checks run, ${pending} pending, ${failures} failed.`,
  );
  if (failures > 0) {
    console.error('\nBLOCKED: fix these before the phase transition.');
    process.exit(1);
  }
  console.log('All invariants hold.');
}

main();
