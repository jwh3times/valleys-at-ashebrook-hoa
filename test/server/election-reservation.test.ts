import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { elections, candidates } from '../../src/server/db/schema';
import {
  RESERVATION_SENTINELS,
  reservationGuard,
  runReservedBatch,
} from '../../src/server/content/election-reservation';
import { truncateAll, seedElection, seedCandidate } from './fixtures';

/**
 * The reservation protocol, tested directly rather than only through the
 * three routes that use it. Before the seam existed this was reachable only
 * by monkey-patching `env.DATABASE.batch` from inside a route test — which is
 * why `pauseNextBatch` was copied into three files.
 */

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  await truncateAll();
  await seedElection('e1', { status: 'closed', source: 'recorded' });
  await seedCandidate('c1', 'e1', { votes: null });
});

const sentinel = RESERVATION_SENTINELS.tallies;

function reserveFrom(status: string) {
  return env.DATABASE.prepare(
    `UPDATE elections SET status = ? WHERE id = ? AND status = ? RETURNING id`,
  ).bind(sentinel, 'e1', status);
}

const release = () =>
  env.DATABASE.prepare(
    `UPDATE elections SET status = 'closed' WHERE id = ? AND status = ? RETURNING id`,
  ).bind('e1', sentinel);

function setVotes(guardSql: string, guardBinds: string[]) {
  return env.DATABASE.prepare(
    `UPDATE candidates SET votes = 7 WHERE id = ? AND ${guardSql}`,
  ).bind('c1', ...guardBinds);
}

async function statusOf() {
  const rows = await getDb(env)
    .select({ status: elections.status })
    .from(elections)
    .where(eq(elections.id, 'e1'));
  return rows[0].status;
}

async function votesOf() {
  const rows = await getDb(env)
    .select({ votes: candidates.votes })
    .from(candidates)
    .where(eq(candidates.id, 'c1'));
  return rows[0].votes;
}

describe('reservationGuard', () => {
  it('binds the election and the sentinel, in that order', () => {
    const guard = reservationGuard('e1', sentinel);
    expect(guard.sql).toContain('EXISTS');
    expect(guard.binds).toEqual(['e1', sentinel]);
  });
});

describe('runReservedBatch', () => {
  it('commits the children and releases when the reservation wins', async () => {
    const guard = reservationGuard('e1', sentinel);
    const committed = await runReservedBatch(
      env.DATABASE,
      reserveFrom('closed'),
      [setVotes(guard.sql, guard.binds)],
      release(),
    );

    expect(committed).toBe(true);
    expect(await votesOf()).toBe(7);
    // The sentinel is never left behind.
    expect(await statusOf()).toBe('closed');
  });

  it('writes nothing and reports failure when the reservation loses', async () => {
    // Something else moved the election first, so the reservation matches no
    // row — and every child, gated on a sentinel that was never written,
    // is a no-op too.
    const guard = reservationGuard('e1', sentinel);
    const committed = await runReservedBatch(
      env.DATABASE,
      reserveFrom('draft'), // the election is 'closed', so this matches nothing
      [setVotes(guard.sql, guard.binds)],
      release(),
    );

    expect(committed).toBe(false);
    expect(await votesOf()).toBeNull();
    expect(await statusOf()).toBe('closed');
  });

  it('treats a child that changes no rows as success', async () => {
    // A full replace with nothing to write is legitimate; only the ends
    // decide whether the transition committed.
    const guard = reservationGuard('e1', sentinel);
    const committed = await runReservedBatch(
      env.DATABASE,
      reserveFrom('closed'),
      [
        env.DATABASE.prepare(
          `UPDATE candidates SET votes = 7 WHERE id = 'no-such-candidate' AND ${guard.sql}`,
        ).bind(...guard.binds),
      ],
      release(),
    );

    expect(committed).toBe(true);
    expect(await votesOf()).toBeNull();
    expect(await statusOf()).toBe('closed');
  });

  it('a release that cannot match STRANDS the sentinel — the reason for the release rule', async () => {
    // D1 rolls back a batch on an error, NOT on a statement that matches zero
    // rows. So if the release carries any predicate that can fail, the
    // sentinel commits into elections.status, where no reader expects a value
    // outside ElectionStatus.
    //
    // This is unreachable in production precisely because all three callers
    // condition the release on `id = ? AND status = <sentinel>` and nothing
    // else — which the reservation set one statement earlier in the same
    // transaction. The test exists to keep that rule honest: it fails loudly
    // if someone narrows a release.
    const committed = await runReservedBatch(
      env.DATABASE,
      reserveFrom('closed'),
      [],
      env.DATABASE.prepare(
        `UPDATE elections SET status = 'closed' WHERE id = ? AND status = 'never' RETURNING id`,
      ).bind('e1'),
    );

    expect(committed).toBe(false);
    expect(await statusOf()).toBe(sentinel);
  });
});
