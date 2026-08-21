import { env, applyD1Migrations } from 'cloudflare:test';
import { asc, eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as electionsPost } from '../../src/pages/api/admin/elections';
import { POST as motionsPost } from '../../src/pages/api/admin/motions';
import type { CastBallotInput, CastMotionVoteInput } from '../../src/lib/types';
import type { AuthContext } from '../../src/server/authz/guards';
import {
  castElectionBallot,
  castMotionVote,
} from '../../src/server/content/voting';
import { getDb } from '../../src/server/db/client';
import {
  ballotChoices,
  ballots,
  candidates,
  electionEligibility,
  elections,
  meetings,
  memberVotes,
  motionEligibility,
  motions,
  owners,
  properties,
  settings,
  userPropertyLinks,
  users,
} from '../../src/server/db/schema';
import { legacyAuthContext } from '../../src/server/authz/context';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date('2026-08-05T12:00:00Z');
const homeowner: AuthContext = legacyAuthContext('caller-user', 'homeowner', [
  'property-own',
]);
const board: AuthContext = legacyAuthContext('board-user', 'board', []);

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(ballotChoices);
  await db.delete(ballots);
  await db.delete(memberVotes);
  await db.delete(electionEligibility);
  await db.delete(candidates);
  await db.delete(elections);
  await db.delete(motionEligibility);
  await db.delete(motions);
  await db.delete(meetings);
  await db.delete(userPropertyLinks);
  await db.delete(owners);
  await db.delete(properties);
  await db.delete(settings);
  await db.delete(users);

  await db.insert(settings).values({
    key: 'site',
    value: JSON.stringify({ officialMode: true, liveVotingEnabled: true }),
    updatedAt: now,
  });
  await db.insert(users).values({
    id: 'caller-user',
    name: 'Home Owner',
    email: 'caller-concurrency@example.test',
    emailVerified: true,
    role: 'homeowner',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(properties).values({
    id: 'property-own',
    address: '1 Ashebrook Lane',
    addressNormalized: '1 ashebrook lane',
    status: 'active',
    voteWeight: 70,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(userPropertyLinks).values({
    id: 'link-own',
    userId: 'caller-user',
    propertyId: 'property-own',
    verifiedAt: now,
    method: 'board_manual',
  });
  await db.insert(owners).values({
    id: 'owner-own',
    propertyId: 'property-own',
    fullName: 'Home Owner',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(meetings).values({
    id: 'meeting-open',
    body: 'member',
    kind: 'regular',
    date: '2026-10-01',
    title: 'Open member meeting',
    status: 'draft',
    visibility: 'homeowner',
    createdBy: 'board-user',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(elections).values([
    {
      id: 'election-open',
      meetingId: 'meeting-open',
      title: 'Open conducted election',
      seats: 2,
      electionDate: '2026-10-01',
      source: 'conducted',
      status: 'open',
      visibility: 'homeowner',
      createdBy: 'board-user',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'election-foreign',
      title: 'Foreign conducted election',
      seats: 1,
      electionDate: '2026-10-01',
      source: 'conducted',
      status: 'open',
      visibility: 'homeowner',
      createdBy: 'board-user',
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db
    .insert(candidates)
    .values([
      candidate('candidate-one', 'election-open', 1),
      candidate('candidate-two', 'election-open', 2),
      candidate('candidate-foreign', 'election-foreign', 1),
    ]);
  await db.insert(electionEligibility).values({
    electionId: 'election-open',
    propertyId: 'property-own',
    weight: 7,
  });
  await db.insert(motions).values({
    id: 'motion-open',
    meetingId: 'meeting-open',
    sequence: 1,
    text: 'Open member motion',
    votingState: 'open',
    outcome: 'tabled',
    createdBy: 'board-user',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(motionEligibility).values({
    motionId: 'motion-open',
    propertyId: 'property-own',
    weight: 5,
  });
});

describe('atomic election casting', () => {
  it('leaves turnout and choices empty when one candidate is foreign', async () => {
    const result = await castElectionBallot(env, homeowner, {
      ...ballotInput(),
      candidateIds: ['candidate-one', 'candidate-foreign'],
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(await ballotCount('election-open')).toBe(0);
    expect(await choiceCount('election-open')).toBe(0);
  });

  it('serializes two casts for the same property to one complete ballot', async () => {
    const responses = await Promise.all([castBallot(), castBallot()]);
    expect(responses.sort((a, b) => a - b)).toEqual([204, 409]);
    expect(await ballotCount('election-open')).toBe(1);
    expect(await choiceCount('election-open')).toBe(2);
  });

  it('serializes cast versus close to one of two complete states and closes with final sums', async () => {
    const [cast, close] = await Promise.all([castBallot(), closeElection()]);
    expect(close).toBe(204);
    const observed = {
      cast,
      ballots: await ballotCount('election-open'),
      choices: await choiceCount('election-open'),
    };
    expect([
      { cast: 204, ballots: 1, choices: 2 },
      { cast: 409, ballots: 0, choices: 0 },
    ]).toContainEqual(observed);

    const totals = await getDb(env)
      .select({ id: candidates.id, votes: candidates.votes })
      .from(candidates)
      .where(eq(candidates.electionId, 'election-open'))
      .orderBy(asc(candidates.id));
    expect(totals).toEqual(
      cast === 204
        ? [
            { id: 'candidate-one', votes: 7 },
            { id: 'candidate-two', votes: 7 },
          ]
        : [
            { id: 'candidate-one', votes: 0 },
            { id: 'candidate-two', votes: 0 },
          ],
    );
  });

  it('serializes cast versus the global pause to one of two complete states', async () => {
    const [cast] = await Promise.all([castBallot(), pauseVoting()]);
    const observed = {
      cast,
      ballots: await ballotCount('election-open'),
      choices: await choiceCount('election-open'),
    };
    expect([
      { cast: 204, ballots: 1, choices: 2 },
      { cast: 409, ballots: 0, choices: 0 },
    ]).toContainEqual(observed);
  });
});

describe('atomic motion casting', () => {
  it('serializes two casts for the same property to one vote', async () => {
    const responses = await Promise.all([castMotion(), castMotion()]);
    expect(responses.sort((a, b) => a - b)).toEqual([204, 409]);
    expect(await motionVoteCount('motion-open')).toBe(1);
  });

  it('serializes cast versus close without accepting a vote after close', async () => {
    const [cast, close] = await Promise.all([castMotion(), closeMotion()]);
    expect(close).toBe(204);
    expect([
      { cast: 204, votes: 1 },
      { cast: 409, votes: 0 },
    ]).toContainEqual({
      cast,
      votes: await motionVoteCount('motion-open'),
    });
  });

  it('serializes cast versus the global pause to one of two complete states', async () => {
    const [cast] = await Promise.all([castMotion(), pauseVoting()]);
    expect([
      { cast: 204, votes: 1 },
      { cast: 409, votes: 0 },
    ]).toContainEqual({
      cast,
      votes: await motionVoteCount('motion-open'),
    });
  });
});

function ballotInput(): CastBallotInput {
  return {
    action: 'castBallot',
    electionId: 'election-open',
    propertyId: 'property-own',
    candidateIds: ['candidate-one', 'candidate-two'],
    castByPersonId: 'owner-own',
    proxyId: null,
  };
}

function motionInput(): CastMotionVoteInput {
  return {
    action: 'castMotionVote',
    motionId: 'motion-open',
    propertyId: 'property-own',
    choice: 'yes',
    castByPersonId: 'owner-own',
    proxyId: null,
  };
}

async function castBallot(): Promise<number> {
  const result = await castElectionBallot(env, homeowner, ballotInput());
  return result.ok ? 204 : result.status;
}

async function castMotion(): Promise<number> {
  const result = await castMotionVote(env, homeowner, motionInput());
  return result.ok ? 204 : result.status;
}

async function closeElection(): Promise<number> {
  const response = await electionsPost({
    request: new Request('http://localhost/api/admin/elections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'close', id: 'election-open' }),
    }),
    locals: { authContext: board },
  } as never);
  return response.status;
}

async function closeMotion(): Promise<number> {
  const response = await motionsPost({
    request: new Request('http://localhost/api/admin/motions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'closeVoting', id: 'motion-open' }),
    }),
    locals: { authContext: board },
  } as never);
  return response.status;
}

async function pauseVoting(): Promise<void> {
  await getDb(env)
    .update(settings)
    .set({
      value: JSON.stringify({
        officialMode: true,
        liveVotingEnabled: false,
      }),
      updatedAt: new Date(),
    })
    .where(eq(settings.key, 'site'));
}

async function ballotCount(electionId: string): Promise<number> {
  return env.DATABASE.prepare(
    'SELECT COUNT(*) AS count FROM ballots WHERE election_id = ?',
  )
    .bind(electionId)
    .first<number>('count')
    .then((count) => count ?? 0);
}

async function choiceCount(electionId: string): Promise<number> {
  return env.DATABASE.prepare(
    'SELECT COUNT(*) AS count FROM ballot_choices WHERE election_id = ?',
  )
    .bind(electionId)
    .first<number>('count')
    .then((count) => count ?? 0);
}

async function motionVoteCount(motionId: string): Promise<number> {
  return env.DATABASE.prepare(
    'SELECT COUNT(*) AS count FROM member_votes WHERE motion_id = ?',
  )
    .bind(motionId)
    .first<number>('count')
    .then((count) => count ?? 0);
}

function candidate(id: string, electionId: string, sequence: number) {
  return {
    id,
    electionId,
    fullName: `Candidate ${id}`,
    sequence,
    votes: null,
    won: false,
    withdrawn: false,
    createdAt: now,
  };
}
