#!/usr/bin/env node
/**
 * ADR 0022 migration invariant gate.
 *
 * Runs after every migration and at every phase transition, and on demand
 * whenever an operator wants an answer about local or remote D1. A non-empty
 * result BLOCKS the transition — this is a gate with an exit code, not a
 * report.
 *
 * The checks themselves live in `src/server/db/invariants.ts`, shared with the
 * Worker's daily scheduled run (#240, per #206: the checks that gate a
 * migration are exactly the checks that catch drift afterwards). This file is
 * only the Wrangler-subprocess way of reaching a database — which is why it,
 * and not the scheduled job, is what can point at `--remote` from a laptop.
 *
 * Usage:
 *   npx tsx scripts/verify-invariants.ts --local
 *   npx tsx scripts/verify-invariants.ts --remote
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseD1Output, withRetry } from './wrangler-d1.ts';
import {
  INVARIANT_CHECKS,
  VIOLATION_SAMPLE_LIMIT,
} from '../src/server/db/invariants.ts';

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

/** Total tries per check. Wrangler on Node 26/Windows intermittently dies AT
 * EXIT with a libuv assertion after the query already completed, so a first
 * failure is usually a phantom; a persistent failure still reports red. A gate
 * that flakes is not a gate. */
const QUERY_ATTEMPTS = 3;

function runQuery(sql: string, remote: boolean): unknown[] {
  const out = withRetry(
    () =>
      execFileSync(
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
      ),
    QUERY_ATTEMPTS,
    {
      // A failed spawn whose stdout carries wrangler's `--json` error object
      // is a real answer — a SQL error, a missing table — not the exit-crash
      // flake; retrying it would repeat a deterministic failure. Everything
      // else (empty stdout, partial output, even a complete result set from a
      // process that then died at exit) is worth another try.
      shouldRetry: (error) => {
        const stdout = (error as { stdout?: unknown } | null)?.stdout;
        if (typeof stdout !== 'string' || stdout.trim() === '') return true;
        const kind = parseD1Output(stdout).kind;
        return kind !== 'unrecognized' && kind !== 'import-summary';
      },
      onRetry: (attempt, error) => {
        const line = String(
          error instanceof Error ? error.message : error,
        ).split('\n')[0];
        console.error(
          `    ↻ transient subprocess failure (attempt ${attempt}/${QUERY_ATTEMPTS}): ${line}`,
        );
      },
    },
  );
  // A check whose output is not a one-statement result set must read as a
  // failed query, never as zero rows — zero rows is this gate's GREEN.
  const parsed = parseD1Output(out);
  if (parsed.kind !== 'statements' || parsed.statements.length !== 1) {
    throw new Error(
      `expected one statement result, got ${
        parsed.kind === 'statements'
          ? `${parsed.statements.length} results`
          : `${parsed.kind}: ${parsed.detail}`
      }`,
    );
  }
  return parsed.statements[0].results ?? [];
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

  for (const check of INVARIANT_CHECKS) {
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
    for (const row of rows.slice(0, VIOLATION_SAMPLE_LIMIT))
      console.error(`      ${JSON.stringify(row)}`);
    if (rows.length > VIOLATION_SAMPLE_LIMIT)
      console.error(`      … ${rows.length - VIOLATION_SAMPLE_LIMIT} more`);
  }

  console.log(
    `\n${INVARIANT_CHECKS.length - pending} checks run, ${pending} pending, ${failures} failed.`,
  );
  if (failures > 0) {
    console.error('\nBLOCKED: fix these before the phase transition.');
    process.exit(1);
  }
  console.log('All invariants hold.');
}

main();
