import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import {
  fetchAdminMeeting,
  fetchMeetingFor,
} from '../../src/server/content/reads';
import { getDb } from '../../src/server/db/client';
import {
  boardAttendance,
  boardVotes,
  memberAttendance,
  memberVotes,
  motionEligibility,
} from '../../src/server/db/schema';
import * as fx from './fixtures';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});
beforeEach(fx.truncateAll);

// Observe the real D1 boundary, including rows transferred, without mocking SQL.
function observeReads() {
  let roundTrips = 0;
  const reads: { sql: string; rows: unknown[][] }[] = [];
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const queries = new WeakMap<D1PreparedStatement, string>();
  function wrap(
    statement: D1PreparedStatement,
    query: string,
  ): D1PreparedStatement {
    const wrapped = new Proxy(statement, {
      get(target, key) {
        if (key === 'bind')
          return (...values: unknown[]) => wrap(target.bind(...values), query);
        if (key === 'raw')
          return async (...args: unknown[]) => {
            roundTrips++;
            const rows = await Reflect.apply(
              target.raw.bind(target),
              target,
              args,
            );
            reads.push({ sql: query, rows });
            return rows;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    originals.set(wrapped, statement);
    queries.set(wrapped, query);
    return wrapped;
  }
  const database = new Proxy(env.DATABASE, {
    get(target, key) {
      if (key === 'prepare')
        return (query: string) => wrap(target.prepare(query), query);
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          roundTrips++;
          const results = await target.batch<Record<string, unknown>>(
            statements.map((s) => originals.get(s) ?? s),
          );
          results.forEach((result, index) =>
            reads.push({
              sql: queries.get(statements[index]) ?? '',
              rows: result.results.map((row) => Object.values(row)),
            }),
          );
          return results;
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    env: { ...env, DATABASE: database },
    reads,
    roundTrips: () => roundTrips,
  };
}

it('reads a populated meeting in two D1 calls and transfers only its referenced names and lots', async () => {
  const db = getDb(env);
  for (const id of [
    'attendee',
    'mover',
    'second',
    'voter',
    'representative',
    'caster',
    'unrelated',
  ]) {
    await fx.seedPerson(
      id,
      id === 'second'
        ? { fullName: null, nameNormalized: null, nameRedactedAt: new Date() }
        : {},
    );
  }
  await fx.seedProperty('present-lot', { voteWeight: 9 });
  await fx.seedProperty('voting-lot', { voteWeight: 11, status: 'inactive' });
  await fx.seedProperty('unrelated-lot', { voteWeight: 13 });
  await fx.seedMeeting('shown', { status: 'approved', visibility: 'public' });
  await fx.seedMeeting('hidden', { status: 'draft', visibility: 'board' });
  await fx.seedMotion('shown-motion', 'shown', {
    moverPersonId: 'mover',
    secondPersonId: 'second',
  });
  await fx.seedMotion('hidden-motion', 'hidden', {
    moverPersonId: 'unrelated',
  });
  await db.insert(boardAttendance).values({
    id: 'attendance',
    meetingId: 'shown',
    personId: 'attendee',
    present: true,
  });
  await db.insert(boardVotes).values({
    id: 'vote',
    motionId: 'shown-motion',
    personId: 'voter',
    choice: 'yes',
  });
  await db.insert(memberAttendance).values({
    id: 'member-attendance',
    meetingId: 'shown',
    propertyId: 'present-lot',
    representedByPersonId: 'representative',
    present: true,
  });
  await db.insert(memberVotes).values([
    {
      id: 'member-vote',
      motionId: 'shown-motion',
      propertyId: 'voting-lot',
      castByPersonId: 'caster',
      weight: 3,
      choice: 'yes',
    },
    {
      id: 'hidden-vote',
      motionId: 'hidden-motion',
      propertyId: 'unrelated-lot',
      castByPersonId: 'unrelated',
      weight: 13,
      choice: 'no',
    },
  ]);
  await db
    .insert(motionEligibility)
    .values({ motionId: 'shown-motion', propertyId: 'voting-lot', weight: 3 });

  const observed = observeReads();
  const detail = await fetchMeetingFor(observed.env, 'visitor', 'shown');
  expect(observed.roundTrips()).toBeLessThanOrEqual(2);
  expect(detail?.attendance[0].fullName).toBe('Person attendee');
  expect(detail?.memberAttendance[0]).toMatchObject({
    representedByName: 'Person representative',
    weight: 9,
  });
  expect(detail?.motions[0]).toMatchObject({
    moverName: 'Person mover',
    secondName: 'Resident second',
    eligibleCount: 1,
    eligibleWeight: 3,
    eligibilityFrozen: true,
  });
  expect(detail?.motions[0].votes[0].fullName).toBe('Person voter');
  expect(detail?.motions[0].memberVotes[0]).toMatchObject({
    castByName: 'Person caster',
    weight: 3,
  });
  expect(detail?.totalActiveWeight).toBe(22);
  const names = observed.reads.find((r) => /from "people"/.test(r.sql));
  expect(names?.rows.map((r) => r[0]).sort()).toEqual([
    'attendee',
    'caster',
    'mover',
    'representative',
    'second',
    'voter',
  ]);
  const addresses = observed.reads.find((r) =>
    r.sql.startsWith('select "id", "address", "vote_weight" from "lots"'),
  );
  expect(addresses?.rows.map((r) => r[0]).sort()).toEqual([
    'present-lot',
    'voting-lot',
  ]);
});

it('keeps the D1 call bound for an empty meeting and returns empty detail with zero active weight', async () => {
  await fx.seedMeeting('empty');
  const observed = observeReads();
  const detail = await fetchAdminMeeting(observed.env, 'empty');
  expect(observed.roundTrips()).toBeLessThanOrEqual(2);
  expect(detail).toMatchObject({
    attendance: [],
    memberAttendance: [],
    motions: [],
    totalActiveWeight: 0,
  });
});

it('does not assemble a hidden meeting or query its related rows', async () => {
  await fx.seedMeeting('hidden', { status: 'draft', visibility: 'board' });
  const observed = observeReads();
  expect(await fetchMeetingFor(observed.env, 'board', 'hidden')).toBeNull();
  expect(observed.roundTrips()).toBe(1);
  expect(observed.reads).toHaveLength(1);
});

it('keeps the call budget when a meeting has more motions than D1 permits scalar binds', async () => {
  await fx.seedMeeting('long-meeting', {
    status: 'approved',
    visibility: 'public',
  });
  for (let sequence = 1; sequence <= 105; sequence++) {
    await fx.seedMotion(`motion-${sequence}`, 'long-meeting', { sequence });
  }
  const observed = observeReads();
  const detail = await fetchMeetingFor(observed.env, 'visitor', 'long-meeting');
  expect(observed.roundTrips()).toBeLessThanOrEqual(2);
  expect(detail?.motions).toHaveLength(105);
  expect(detail?.motions[104]).toMatchObject({
    sequence: 105,
    eligibleCount: 0,
    eligibleWeight: 0,
    eligibilityFrozen: false,
  });
});
