#!/usr/bin/env node
/**
 * ADR 0022 roster backfill — legacy rows into the party roster.
 *
 *   node --experimental-strip-types scripts/migrate-roster.ts --local
 *   node --experimental-strip-types scripts/migrate-roster.ts --local --write --operator=<accountId>
 *
 * DRY RUN BY DEFAULT. `--write` is required to change anything.
 *
 * This file is I/O only — read legacy rows, print, apply. Every decision that
 * could be wrong lives in `backfill-plan.ts`, where it is tested against
 * synthetic legacy data without a database.
 *
 * PHASE 2 is a rehearsal: an idempotent clean-replace over the new domain
 * tables, whose output is counts and queues. Legacy stays the only roster
 * editor, and the new admin surfaces ship read-only, because this run's
 * clean-replace would silently erase anything a board member wrote.
 * PHASE 3 re-runs it authoritatively inside the write-freeze, where it becomes
 * insert-once keyed by `operation_key` — see issue #211.
 *
 * Deliberately not a Wrangler migration: migrations are forward-only and marked
 * applied permanently, cannot produce dry-run counts or exception queues, and
 * the audit baseline is application logic rather than SQL.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  buildPlan,
  CLEAN_REPLACE_STATEMENTS,
  type LegacyBoardAccount,
  type LegacyBoardPerson,
  type LegacyBoardTerm,
  type LegacyOwner,
  type LegacyProperty,
  type PlanException,
} from './backfill-plan.ts';

// See verify-invariants.ts for why this is neither `npx` nor `shell: true`.
const WRANGLER = join(
  dirname(createRequire(import.meta.url).resolve('wrangler/package.json')),
  'bin',
  'wrangler.js',
);

function run(args: string[]): string {
  return execFileSync(process.execPath, [WRANGLER, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function query<T>(sql: string, remote: boolean): T[] {
  const out = run([
    'd1',
    'execute',
    'DATABASE',
    remote ? '--remote' : '--local',
    '--json',
    '--command',
    sql,
  ]);
  return (JSON.parse(out) as { results?: T[] }[])[0]?.results ?? [];
}

function report(label: string, items: PlanException[]): void {
  if (items.length === 0) {
    console.log(`\n${label}: none`);
    return;
  }
  console.log(`\n${label}: ${items.length}`);
  const byKind = new Map<string, PlanException[]>();
  for (const e of items) byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e]);
  for (const [kind, group] of byKind) {
    console.log(`  ${kind} (${group.length})`);
    for (const e of group.slice(0, 5)) console.log(`      ${e.detail}`);
    if (group.length > 5) console.log(`      … ${group.length - 5} more`);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const remote = argv.includes('--remote');
  const write = argv.includes('--write');
  const authoritative = argv.includes('--authoritative');
  const operator =
    argv.find((a) => a.startsWith('--operator='))?.split('=')[1] ?? null;

  if (!remote && !argv.includes('--local')) {
    console.error('Pass --local or --remote.');
    process.exit(2);
  }
  if (write && !operator) {
    // `actor_kind = 'migration'` is legal only for this backfill and still
    // names a human — the same shape that makes bootstrap safe.
    console.error(
      '--write requires --operator=<account id>, which the audit baseline records as the actor.',
    );
    process.exit(2);
  }

  console.log(
    `migrate-roster: ${remote ? 'REMOTE' : 'local'} ${write ? 'WRITE' : 'dry run'} ` +
      `${authoritative ? 'AUTHORITATIVE (insert-once)' : 'rehearsal (clean-replace)'}\n`,
  );

  const data = {
    properties: query<LegacyProperty>(
      'SELECT id, status, notes FROM properties',
      remote,
    ),
    owners: query<LegacyOwner>(
      'SELECT id, property_id, full_name, phone, email, status, notes FROM owners',
      remote,
    ),
    boardPeople: query<LegacyBoardPerson>(
      'SELECT id, full_name FROM board_people',
      remote,
    ),
    boardTerms: query<LegacyBoardTerm>(
      'SELECT id, person_id, title, term_start, term_end FROM board_terms',
      remote,
    ),
    boardAccounts: query<LegacyBoardAccount>(
      "SELECT id FROM users WHERE role = 'board'",
      remote,
    ),
  };

  const plan = buildPlan(data, Date.now(), {
    operatorAccountId: operator,
    mode: authoritative ? 'authoritative' : 'rehearsal',
  });
  const blocking = plan.exceptions.filter((e) => e.queue === 'blocking');
  const advisory = plan.exceptions.filter((e) => e.queue === 'advisory');

  console.log('Legacy read:');
  console.log(`  properties        ${data.properties.length}`);
  console.log(`  owners            ${data.owners.length}`);
  console.log(`  board people      ${data.boardPeople.length}`);
  console.log(`  board terms       ${data.boardTerms.length}`);
  console.log(`  role='board'      ${data.boardAccounts.length}`);
  console.log('\nPlanned:');
  console.log(`  parties           ${plan.counts.parties}`);
  console.log(`  contact methods   ${plan.counts.contactMethods}`);
  console.log(`  ownerships        ${plan.counts.ownerships}`);
  console.log(`  lots retired      ${plan.counts.lotsRetired}`);
  console.log(`  board terms       ${plan.counts.boardTerms}`);
  console.log(
    `  baseline events   ${plan.counts.baselineEvents}` +
      (operator === null
        ? '  (pass --operator to plan the audit baseline)'
        : ''),
  );

  report('FLIP-BLOCKING', blocking);
  report('advisory', advisory);

  console.log(`\n${blocking.length} blocking, ${advisory.length} advisory.`);
  if (blocking.length > 0) {
    console.log(
      'Every blocking exception must reach zero before phase 3. There is no threshold.',
    );
  }

  if (!write) {
    console.log(
      `\nDry run — ${plan.statements.length} statements not executed.`,
    );
    return;
  }

  // Phase 3 requires every flip-blocking queue at zero. Enforced here rather
  // than left to a runbook step, because this is the run that makes the new
  // roster authoritative and there is no threshold to argue about at 11pm.
  if (authoritative && blocking.length > 0) {
    console.error(
      `\nREFUSING TO RUN: ${blocking.length} flip-blocking exception(s) outstanding.\n` +
        'The authoritative backfill records the roster the association will run on.\n' +
        'Resolve every blocking item, or re-run without --authoritative to rehearse.',
    );
    process.exit(1);
  }

  // Insert-once deletes nothing: a clean replace once the ledger is real would
  // be deleting immutable history.
  const wipe = authoritative ? [] : CLEAN_REPLACE_STATEMENTS;
  const sqlPath = join(tmpdir(), `adr0022-backfill-${randomUUID()}.sql`);
  writeFileSync(
    sqlPath,
    [...wipe, ...plan.statements].join(';\n') + ';\n',
    'utf8',
  );
  try {
    run([
      'd1',
      'execute',
      'DATABASE',
      remote ? '--remote' : '--local',
      '--file',
      sqlPath,
    ]);
  } finally {
    unlinkSync(sqlPath);
  }

  console.log(
    `\nApplied ${plan.statements.length} statements, including ${plan.counts.baselineEvents} baseline events.`,
  );
  if (authoritative) {
    console.log(
      'Insert-once: nothing was deleted, and re-running inserts only what is\n' +
        'missing. Run verify:invariants next — a green gate is the evidence that\n' +
        'this roster is coherent, not the absence of an error here.',
    );
  } else {
    console.log(
      'Rehearsal: this clean-replaced the new tables. The authoritative run\n' +
        '(--authoritative, inside the write-freeze) deletes nothing.',
    );
  }
}

main();
