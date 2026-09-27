import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => callerContext('b', 'board', []),
}));

import { POST as electionPost } from '../../src/pages/api/admin/elections';
import { POST as meetingPost } from '../../src/pages/api/admin/meetings';
import { POST as motionPost } from '../../src/pages/api/admin/motions';
import {
  fetchAdminElections,
  fetchAdminMeeting,
} from '../../src/server/content/reads';
import { eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { ballots } from '../../src/server/db/schema';
import { callerContext } from './caller-context';
import {
  req,
  truncateAll,
  seedElection,
  seedProperty,
  seedBallot,
  seedLotAuthority,
  seedProxy,
  seedCandidate,
  seedMeeting,
  seedMotion,
} from './fixtures';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});
beforeEach(truncateAll);

const electionUrl = 'http://localhost/api/admin/elections';
const meetingUrl = 'http://localhost/api/admin/meetings';
const motionUrl = 'http://localhost/api/admin/motions';
const lotIds = Array.from({ length: 150 }, (_, i) => `lot-${i}`);

async function seedLots() {
  for (const id of lotIds) await seedProperty(id, { voteWeight: 2 });
}

it('replaces a 150-lot register, preserving retained ballot identity and clearing omitted lots', async () => {
  await seedLots();
  await seedElection('e');
  await seedProperty('omitted');
  await seedBallot('removed', 'e', 'omitted');
  await seedBallot('retained', 'e', lotIds[0]);
  const entries = lotIds.map((propertyId) => ({ propertyId }));
  expect(
    (
      await electionPost(
        req(electionUrl, 'POST', {
          action: 'setBallots',
          electionId: 'e',
          entries,
        }),
      )
    ).status,
  ).toBe(204);
  const [election] = await fetchAdminElections(env);
  expect(election.ballots).toHaveLength(150);
  const [retained] = await getDb(env)
    .select()
    .from(ballots)
    .where(eq(ballots.id, 'retained'));
  expect(retained?.propertyId).toBe(lotIds[0]);
  expect(
    election.ballots?.find((ballot) => ballot.propertyId === lotIds[149])
      ?.weight,
  ).toBe(2);
  expect(
    election.ballots?.some((ballot) => ballot.propertyId === 'omitted'),
  ).toBe(false);
  expect(
    (
      await electionPost(
        req(electionUrl, 'POST', {
          action: 'setBallots',
          electionId: 'e',
          entries: [],
        }),
      )
    ).status,
  ).toBe(204);
  expect((await fetchAdminElections(env))[0].ballots).toEqual([]);
});
it('records 150 distinct casters and rejects unknown or duplicate lots without replacing the register', async () => {
  await seedLots();
  await seedElection('e');
  for (const id of lotIds) await seedLotAuthority(`person-${id}`, id);
  const entries = lotIds.map((propertyId) => ({
    propertyId,
    castByPersonId: `person-${propertyId}`,
  }));
  const submit = (value: unknown[]) =>
    electionPost(
      req(electionUrl, 'POST', {
        action: 'setBallots',
        electionId: 'e',
        entries: value,
      }),
    );
  expect((await submit(entries)).status).toBe(204);
  await seedMeeting('m');
  await seedMotion('motion', 'm');
  expect(
    (
      await meetingPost(
        req(meetingUrl, 'POST', {
          action: 'setMemberAttendance',
          meetingId: 'm',
          entries: entries.map((entry) => ({
            propertyId: entry.propertyId,
            representedByPersonId: entry.castByPersonId,
            present: true,
          })),
        }),
      )
    ).status,
  ).toBe(204);
  expect(
    (
      await motionPost(
        req(motionUrl, 'POST', {
          action: 'setMemberVotes',
          motionId: 'motion',
          entries: entries.map((entry) => ({ ...entry, choice: 'yes' })),
        }),
      )
    ).status,
  ).toBe(204);
  const meeting = await fetchAdminMeeting(env, 'm');
  expect(meeting?.memberAttendance).toHaveLength(150);
  expect(meeting?.motions[0].memberVotes).toHaveLength(150);
  const before = (await fetchAdminElections(env))[0].ballots;
  const unknown = await submit([
    ...entries.slice(0, -1),
    { propertyId: 'unknown' },
  ]);
  expect(unknown.status).toBe(400);
  expect(await unknown.text()).toBe('Unknown property in entries');
  const unknownPerson = await submit([
    ...entries.slice(0, -1),
    { propertyId: lotIds[149], castByPersonId: 'unknown' },
  ]);
  expect(unknownPerson.status).toBe(400);
  expect(await unknownPerson.text()).toBe('Unknown castByPersonId in entries');
  expect((await submit([...entries, entries[0]])).status).toBe(409);
  expect((await fetchAdminElections(env))[0].ballots).toEqual(before);
});

it('records 150 candidate tallies and restores omitted tallies to null while preserving zero', async () => {
  await seedElection('e');
  const ids = Array.from({ length: 150 }, (_, i) => `candidate-${i}`);
  for (const [sequence, id] of ids.entries())
    await seedCandidate(id, 'e', { sequence });
  const entries = ids.map((candidateId) => ({ candidateId, votes: 3 }));
  expect(
    (
      await electionPost(
        req(electionUrl, 'POST', {
          action: 'setTallies',
          electionId: 'e',
          entries,
        }),
      )
    ).status,
  ).toBe(204);
  expect(
    (await fetchAdminElections(env))[0].candidates.every(
      (candidate) => candidate.votes === 3,
    ),
  ).toBe(true);
  expect(
    (
      await electionPost(
        req(electionUrl, 'POST', {
          action: 'setTallies',
          electionId: 'e',
          entries: [{ candidateId: ids[0], votes: 0 }],
        }),
      )
    ).status,
  ).toBe(204);
  const candidates = (await fetchAdminElections(env))[0].candidates;
  expect(candidates.find((candidate) => candidate.id === ids[0])?.votes).toBe(
    0,
  );
  expect(
    candidates.filter((candidate) => candidate.votes === null),
  ).toHaveLength(149);
});

it('records 150 meeting proxies across attendance, member votes, and a linked election', async () => {
  await seedLots();
  await seedMeeting('m');
  await seedMotion('motion', 'm');
  await seedElection('e', { meetingId: 'm' });
  for (const propertyId of lotIds) {
    await seedLotAuthority(`person-${propertyId}`, propertyId);
    await seedProxy(`proxy-${propertyId}`, {
      propertyId,
      grantorPersonId: `person-${propertyId}`,
      meetingId: 'm',
    });
  }
  const entries = lotIds.map((propertyId) => ({
    propertyId,
    proxyId: `proxy-${propertyId}`,
    present: true,
  }));
  expect(
    (
      await meetingPost(
        req(meetingUrl, 'POST', {
          action: 'setMemberAttendance',
          meetingId: 'm',
          entries,
        }),
      )
    ).status,
  ).toBe(204);
  expect(
    (
      await motionPost(
        req(motionUrl, 'POST', {
          action: 'setMemberVotes',
          motionId: 'motion',
          entries: entries.map((entry) => ({ ...entry, choice: 'yes' })),
        }),
      )
    ).status,
  ).toBe(204);
  expect(
    (
      await electionPost(
        req(electionUrl, 'POST', {
          action: 'setBallots',
          electionId: 'e',
          entries,
        }),
      )
    ).status,
  ).toBe(204);
  const meeting = await fetchAdminMeeting(env, 'm');
  expect(meeting?.memberAttendance).toHaveLength(150);
  expect(meeting?.motions[0].memberVotes).toHaveLength(150);
  expect((await fetchAdminElections(env))[0].ballots).toHaveLength(150);
  const invalidProxy = await electionPost(
    req(electionUrl, 'POST', {
      action: 'setBallots',
      electionId: 'e',
      entries: [
        ...entries.slice(0, -1),
        { propertyId: lotIds[149], proxyId: 'missing' },
      ],
    }),
  );
  expect(invalidProxy.status).toBe(400);
  expect(await invalidProxy.text()).toBe('Unknown proxyId in entries');
  expect((await fetchAdminElections(env))[0].ballots).toHaveLength(150);
});
