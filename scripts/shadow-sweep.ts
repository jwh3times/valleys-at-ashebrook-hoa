#!/usr/bin/env node
/**
 * ADR 0022 offline shadow sweep.
 *
 *   node --experimental-strip-types scripts/shadow-sweep.ts --local
 *   node --experimental-strip-types scripts/shadow-sweep.ts --remote --write
 *
 * Derives both authorization contexts for EVERY account and compares them.
 *
 * WHY THIS EXISTS. The flip gate is "zero unexplained mismatches", measured
 * from the request-path shadow — which only ever sees accounts that actually
 * sign in. On a 21-Lot association most accounts will never sign in during a
 * phase-2 window, so "zero mismatches" there could mean three accounts were
 * exercised, and it renders identically to full coverage. This sweep is what
 * turns "no one hit a mismatch" into "no account can produce one".
 *
 * It is not a replacement for request-path shadowing, which proves the
 * derivation works under real middleware. Both must be green.
 *
 * Reads by default; `--write` records mismatches. The comparison itself is
 * always printed.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  CAPABILITY_SQL,
  LOT_SQL,
  toDerivedAccess,
  type CapabilityRow,
} from '../src/server/authz/derive.ts';
import { compareContexts } from '../src/server/authz/shadow-compare.ts';
import { chunkStatements, parseD1Output } from './wrangler-d1.ts';

// The SQL and the mapper are IMPORTED, never copied. A sweep with its own
// implementation would agree with itself and miss the derivation bug it exists
// to catch.

const WRANGLER = join(
  dirname(createRequire(import.meta.url).resolve('wrangler/package.json')),
  'bin',
  'wrangler.js',
);

function wrangler(args: string[]): string {
  return execFileSync(process.execPath, [WRANGLER, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 128 * 1024 * 1024,
  });
}

interface StatementResult<T> {
  results?: T[];
}

/** Conservative budget for the SQL carried by one remote `--command` argument.
 * Windows caps the whole process command line at 32767 characters; leave room
 * for the wrangler arguments around the SQL. */
const REMOTE_COMMAND_BUDGET = 24_000;

function parseStatements<T>(
  raw: string,
  expected: number,
  source: string,
): StatementResult<T>[] {
  const parsed = parseD1Output(raw);
  if (parsed.kind !== 'statements') {
    throw new Error(
      `${source}: expected per-statement query results, got ${parsed.kind}: ${parsed.detail}`,
    );
  }
  if (parsed.statements.length !== expected) {
    // Indexing results[i*2] over a short array would silently derive every
    // account from empty rows, so a count mismatch is fatal, never padded.
    throw new Error(
      `${source}: expected ${expected} statement result(s), got ${parsed.statements.length}`,
    );
  }
  return parsed.statements as StatementResult<T>[];
}

/** Runs many statements and returns one result set per statement, in order,
 * in as few Wrangler invocations as possible — spawning the CLI per account
 * would take minutes.
 *
 * Local goes through `--file`, which the local backend answers with the
 * per-statement query shape. Remote `--file` is D1's IMPORT API — non-JSON
 * progress lines plus one summary object, never per-statement results — so
 * remote goes through `--command` (the QUERY API) in order-preserving chunks
 * sized for the command-line cap. */
function runBatch<T>(
  statements: string[],
  remote: boolean,
): StatementResult<T>[] {
  if (remote) {
    const out: StatementResult<T>[] = [];
    for (const chunk of chunkStatements(statements, REMOTE_COMMAND_BUDGET)) {
      const raw = wrangler([
        'd1',
        'execute',
        'DATABASE',
        '--remote',
        '--json',
        '--command',
        chunk.join(';\n'),
      ]);
      out.push(...parseStatements<T>(raw, chunk.length, 'remote --command'));
    }
    return out;
  }
  const path = join(tmpdir(), `adr0022-sweep-${randomUUID()}.sql`);
  writeFileSync(path, statements.join(';\n') + ';\n', 'utf8');
  try {
    const out = wrangler([
      'd1',
      'execute',
      'DATABASE',
      '--local',
      '--json',
      '--file',
      path,
    ]);
    return parseStatements<T>(out, statements.length, 'local --file');
  } finally {
    unlinkSync(path);
  }
}

const quote = (v: string) => `'${v.replace(/'/g, "''")}'`;

/**
 * `--command`/`--file` carry no parameter binding, so the two shared statements
 * are inlined with quoted literals. Every value substituted here comes from the
 * database's own id columns, and quoting is still applied rather than assumed.
 */
function bind(sql: string, accountId: string, day: string): string {
  return sql.replaceAll('?1', quote(accountId)).replaceAll('?2', quote(day));
}

interface AccountRow {
  id: string;
  role: string | null;
}
interface LinkRow {
  user_id: string;
  property_id: string;
}

function main(): void {
  const argv = process.argv.slice(2);
  const remote = argv.includes('--remote');
  const write = argv.includes('--write');
  if (!remote && !argv.includes('--local')) {
    console.error('Pass --local or --remote.');
    process.exit(2);
  }

  const day =
    argv.find((a) => a.startsWith('--day='))?.split('=')[1] ??
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(
      new Date(),
    );

  console.log(
    `shadow-sweep: ${remote ? 'REMOTE' : 'local'} ${write ? 'WRITE' : 'read only'} day=${day}\n`,
  );

  // The legacy side, for every account at once.
  const [accountsResult, linksResult] = runBatch<AccountRow | LinkRow>(
    [
      'SELECT id, role FROM users',
      `SELECT l.user_id, l.property_id FROM user_property_links l
       JOIN properties p ON p.id = l.property_id AND p.status = 'active'`,
    ],
    remote,
  );
  const accounts = (accountsResult.results ?? []) as AccountRow[];
  const links = (linksResult.results ?? []) as LinkRow[];

  const legacyLots = new Map<string, string[]>();
  for (const l of links) {
    legacyLots.set(l.user_id, [
      ...(legacyLots.get(l.user_id) ?? []),
      l.property_id,
    ]);
  }

  if (accounts.length === 0) {
    console.log('No accounts. Nothing to compare.');
    return;
  }

  // Two statements per account, all in one invocation.
  const statements = accounts.flatMap((a) => [
    bind(CAPABILITY_SQL, a.id, day),
    bind(LOT_SQL, a.id, day),
  ]);
  const results = runBatch<CapabilityRow | { lot_id: string }>(
    statements,
    remote,
  );

  const mismatches: {
    accountId: string;
    legacyRole: string;
    derivedContentTier: string;
    legacyLotCount: number;
    derivedLotCount: number;
  }[] = [];

  accounts.forEach((account, i) => {
    const capabilityRow = (results[i * 2]?.results ?? [])[0] as
      CapabilityRow | undefined;
    const lotIds = (
      (results[i * 2 + 1]?.results ?? []) as { lot_id: string }[]
    ).map((r) => r.lot_id);
    const derived = toDerivedAccess(account.id, capabilityRow, lotIds);

    // The legacy context's own coercion: anything outside the known set — and
    // NULL — reads as visitor.
    const role =
      account.role === 'homeowner' || account.role === 'board'
        ? account.role
        : 'visitor';

    const comparison = compareContexts(
      { role, propertyIds: legacyLots.get(account.id) ?? [] },
      derived,
    );
    if (!comparison.matched) {
      mismatches.push({
        accountId: account.id,
        legacyRole: comparison.legacyRole,
        derivedContentTier: comparison.derivedContentTier,
        legacyLotCount: comparison.legacyLotCount,
        derivedLotCount: comparison.derivedLotCount,
      });
    }
  });

  console.log(`Accounts swept: ${accounts.length}`);
  console.log(`Mismatches:     ${mismatches.length}\n`);

  for (const m of mismatches.slice(0, 25)) {
    console.log(
      `  ${m.accountId}  legacy=${m.legacyRole}(${m.legacyLotCount} lots)  derived=${m.derivedContentTier}(${m.derivedLotCount} lots)`,
    );
  }
  if (mismatches.length > 25) {
    console.log(`  … ${mismatches.length - 25} more`);
  }

  if (mismatches.length > 0) {
    console.log(
      '\nEach row is UNEXPLAINED until an operator classifies it against the\n' +
        'pre-agreed allow-list. Only two classes are permitted: accepted member\n' +
        'access loss, and board callers losing the /api/member pass-through.\n' +
        'Any unexplained mismatch blocks the flip.',
    );
  }

  if (!write) {
    console.log(
      `\nRead only — ${mismatches.length} mismatch row(s) not recorded. Pass --write to record.`,
    );
    return;
  }

  if (mismatches.length === 0) {
    console.log('Nothing to record.');
    return;
  }

  const now = Date.now();
  runBatch(
    mismatches.map(
      (m) =>
        `INSERT INTO cutover_shadow_mismatches
           (id, account_id, source, legacy_role, derived_content_tier,
            legacy_lot_count, derived_lot_count, first_seen_at, last_seen_at, seen_count)
         VALUES (${quote(`sweep:${m.accountId}`)}, ${quote(m.accountId)}, 'sweep',
                 ${quote(m.legacyRole)}, ${quote(m.derivedContentTier)},
                 ${m.legacyLotCount}, ${m.derivedLotCount}, ${now}, ${now}, 1)
         ON CONFLICT (id) DO UPDATE SET
           legacy_role = excluded.legacy_role,
           derived_content_tier = excluded.derived_content_tier,
           legacy_lot_count = excluded.legacy_lot_count,
           derived_lot_count = excluded.derived_lot_count,
           last_seen_at = excluded.last_seen_at,
           seen_count = seen_count + 1`,
    ),
    remote,
  );
  console.log(
    `\nRecorded ${mismatches.length} mismatch row(s) with source='sweep'.`,
  );
}

main();
