import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../src/server/db/client';
import { parties } from '../../src/server/db/roster-schema';
import {
  INVARIANT_CHECKS,
  VIOLATION_SAMPLE_LIMIT,
  formatInvariantRun,
  runInvariants,
  type InvariantRun,
} from '../../src/server/db/invariants';
import { runScheduledJobs } from '../../src/server/scheduled';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  await getDb(env).delete(parties);
});

/** A Party with no `people`/`organizations` child row. The parent-to-child
 * direction is unenforceable in schema, which is exactly why an invariant
 * check exists for it — so it is the cheapest violation to seed, and it
 * touches no other check. */
async function seedSubtypelessParty(id: string): Promise<void> {
  await getDb(env).insert(parties).values({
    id,
    kind: 'person',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe('runInvariants', () => {
  it('runs every check through the D1 binding', async () => {
    const run = await runInvariants(env);

    // The point of this assertion is coverage, not the verdict: a check whose
    // SQL the binding rejects — a PRAGMA the CLI's Wrangler path allows but
    // the binding does not, say — errors rather than returning zero rows, and
    // must never be mistaken for green.
    expect(run.results.map((r) => r.name)).toEqual(
      INVARIANT_CHECKS.map((c) => c.name),
    );
    expect(run.results.filter((r) => r.status === 'errored')).toEqual([]);
    expect(run.ran).toBe(INVARIANT_CHECKS.length);
  });

  it('reports a clean database as healthy', async () => {
    const run = await runInvariants(env);

    expect(run.healthy).toBe(true);
    expect(run.violated).toBe(0);
    expect(run.results.every((r) => r.status === 'ok')).toBe(true);
  });

  it('names the violated check and samples its rows', async () => {
    await seedSubtypelessParty('party-no-subtype');

    const run = await runInvariants(env);
    const violated = run.results.filter((r) => r.status === 'violated');

    expect(run.healthy).toBe(false);
    expect(violated.map((r) => r.name)).toEqual(['party_subtype_completeness']);
    expect(violated[0].rowCount).toBe(1);
    expect(violated[0].sample).toEqual([
      { id: 'party-no-subtype', kind: 'person' },
    ]);
  });
});

describe('formatInvariantRun', () => {
  it('summarises a healthy run in one line', async () => {
    const lines = formatInvariantRun(await runInvariants(env));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      `${INVARIANT_CHECKS.length} checks run, 0 pending, 0 violated, 0 errored`,
    );
  });

  it('reports a violation with its meaning and rows', async () => {
    await seedSubtypelessParty('party-no-subtype');

    const lines = formatInvariantRun(await runInvariants(env));

    expect(lines[0]).toBe(
      '[invariants] VIOLATED party_subtype_completeness — 1 row(s): a Party has no subtype row, or rows in both subtypes',
    );
    expect(lines[1]).toBe(
      '[invariants]   {"id":"party-no-subtype","kind":"person"}',
    );
    expect(lines.at(-1)).toContain('1 violated');
  });

  it('truncates a large violation rather than logging every row', () => {
    const run: InvariantRun = {
      results: [
        {
          name: 'ownership_overlap',
          meaning: 'two overlapping ownerships rows share owner + lot',
          status: 'violated',
          rowCount: 25,
          sample: Array.from({ length: VIOLATION_SAMPLE_LIMIT }, (_, i) => ({
            a_id: `a${i}`,
          })),
        },
      ],
      ran: 1,
      pending: 0,
      violated: 1,
      errored: 0,
      healthy: false,
    };

    const lines = formatInvariantRun(run);

    expect(lines).toHaveLength(1 + VIOLATION_SAMPLE_LIMIT + 1 + 1);
    expect(lines.at(-2)).toBe(
      `[invariants]   … ${25 - VIOLATION_SAMPLE_LIMIT} more`,
    );
  });

  it('reports a check that could not run as errored, never as green', () => {
    const lines = formatInvariantRun({
      results: [
        {
          name: 'audit_integrity_violations',
          meaning: 'the audit integrity view reported a violation',
          status: 'errored',
          error: 'no such view: audit_integrity_violations_v',
        },
      ],
      ran: 1,
      pending: 0,
      violated: 0,
      errored: 1,
      healthy: false,
    });

    expect(lines[0]).toContain('ERRORED audit_integrity_violations');
    expect(lines.at(-1)).toContain('1 errored');
  });
});

describe('the scheduled job', () => {
  it('completes quietly when the invariants hold', async () => {
    await expect(runScheduledJobs(env)).resolves.toBeUndefined();
  });

  it('fails the invocation when an invariant is violated', async () => {
    await seedSubtypelessParty('party-no-subtype');

    await expect(runScheduledJobs(env)).rejects.toThrow(
      /scheduled job failed: invariants/,
    );
  });
});
