import { env, applyD1Migrations } from 'cloudflare:test';
import { asc, eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST } from '../../src/pages/api/vote';
import type { AuthContext } from '../../src/server/authz/guards';
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
  proxies,
  settings,
  userPropertyLinks,
  users,
} from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date('2026-08-05T12:00:00Z');
const voteUrl = 'http://localhost/api/vote';
const homeowner: AuthContext = {
  userId: 'caller-user',
  role: 'homeowner',
  propertyIds: ['property-own', 'property-no-snapshot'],
};

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(ballotChoices);
  await db.delete(ballots);
  await db.delete(memberVotes);
  await db.delete(proxies);
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

  await db.insert(users).values({
    id: 'caller-user',
    name: 'Home Owner',
    email: 'caller@example.test',
    emailVerified: true,
    role: 'homeowner',
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(properties)
    .values([
      property('property-own', '1 Ashebrook Lane', 70),
      property('property-proxy', '2 Ashebrook Lane', 30),
      property('property-unheld', '3 Ashebrook Lane', 40),
      property('property-holder-unlinked', '4 Ashebrook Lane', 50),
      property('property-no-snapshot', '5 Ashebrook Lane', 60),
    ]);
  await db
    .insert(userPropertyLinks)
    .values([
      link('link-own', 'property-own'),
      link('link-no-snapshot', 'property-no-snapshot'),
    ]);
  await db
    .insert(owners)
    .values([
      owner('owner-own', 'property-own', 'Active Caller'),
      owner('owner-inactive', 'property-own', 'Inactive Caller', 'inactive'),
      owner('owner-proxy-grantor', 'property-proxy', 'Proxy Grantor'),
      owner('owner-unheld-grantor', 'property-unheld', 'Unheld Grantor'),
      owner(
        'owner-holder-unlinked',
        'property-holder-unlinked',
        'Unlinked Holder',
      ),
      owner('owner-no-snapshot', 'property-no-snapshot', 'No Snapshot Owner'),
    ]);
  await db
    .insert(meetings)
    .values([
      meeting('meeting-open', 'member', 'draft', 'homeowner'),
      meeting('meeting-other', 'member', 'draft', 'public'),
      meeting('meeting-board-tier', 'member', 'draft', 'board'),
      meeting('meeting-approved', 'member', 'approved', 'public'),
    ]);
  await db
    .insert(elections)
    .values([
      election(
        'election-open',
        'meeting-open',
        'conducted',
        'open',
        'homeowner',
      ),
      election('election-closed', null, 'conducted', 'closed', 'public'),
      election('election-recorded', null, 'recorded', 'open', 'public'),
      election(
        'election-board-tier',
        'meeting-board-tier',
        'conducted',
        'open',
        'board',
      ),
      election('election-foreign', null, 'conducted', 'open', 'public'),
    ]);
  await db
    .insert(candidates)
    .values([
      candidate('candidate-one', 'election-open', 1),
      candidate('candidate-two', 'election-open', 2),
      candidate('candidate-three', 'election-open', 3),
      candidate('candidate-withdrawn', 'election-open', 4, true),
      candidate('candidate-closed', 'election-closed', 1),
      candidate('candidate-recorded', 'election-recorded', 1),
      candidate('candidate-board-tier', 'election-board-tier', 1),
      candidate('candidate-foreign', 'election-foreign', 1),
    ]);
  await db
    .insert(electionEligibility)
    .values([
      eligibility('election-open', 'property-own', 7),
      eligibility('election-open', 'property-proxy', 3),
      eligibility('election-open', 'property-unheld', 4),
      eligibility('election-closed', 'property-own', 7),
      eligibility('election-closed', 'property-unheld', 4),
      eligibility('election-recorded', 'property-own', 7),
      eligibility('election-board-tier', 'property-own', 7),
      eligibility('election-foreign', 'property-own', 7),
    ]);
  await db
    .insert(motions)
    .values([
      motion('motion-open', 'meeting-open', 1, 'open'),
      motion('motion-closed', 'meeting-open', 2, 'closed'),
      motion('motion-board-tier', 'meeting-board-tier', 1, 'open'),
      motion('motion-approved', 'meeting-approved', 1, 'open'),
    ]);
  await db
    .insert(motionEligibility)
    .values([
      motionEligibilityRow('motion-open', 'property-own', 5),
      motionEligibilityRow('motion-open', 'property-proxy', 2),
      motionEligibilityRow('motion-open', 'property-unheld', 4),
      motionEligibilityRow('motion-closed', 'property-own', 5),
      motionEligibilityRow('motion-board-tier', 'property-own', 5),
      motionEligibilityRow('motion-approved', 'property-own', 5),
    ]);
  await db.insert(proxies).values([
    proxy('proxy-election', 'property-proxy', 'owner-proxy-grantor', {
      electionId: 'election-open',
      holderOwnerId: 'owner-own',
    }),
    proxy('proxy-meeting', 'property-proxy', 'owner-proxy-grantor', {
      meetingId: 'meeting-open',
      holderOwnerId: 'owner-own',
    }),
    proxy('proxy-wrong-scope', 'property-proxy', 'owner-proxy-grantor', {
      meetingId: 'meeting-other',
      holderOwnerId: 'owner-own',
    }),
    proxy('proxy-unheld', 'property-unheld', 'owner-unheld-grantor', {
      electionId: 'election-open',
      holderOwnerId: 'owner-holder-unlinked',
    }),
    proxy('proxy-unheld-closed', 'property-unheld', 'owner-unheld-grantor', {
      electionId: 'election-closed',
      holderOwnerId: 'owner-holder-unlinked',
    }),
  ]);
  await setVotingSettings(true, true);
});

describe('POST /api/vote gate and parsing', () => {
  it('keeps flag, exact-origin, media-type, and auth ordering', async () => {
    await setVotingSettings(false, true);
    expect(
      (
        await callVote(validBallot(), {
          origin: 'https://evil.test',
          contentType: 'text/plain',
          ctx: null,
        })
      ).status,
    ).toBe(404);

    await setVotingSettings(true, false);
    expect(
      (
        await callVote(validBallot(), {
          origin: 'https://evil.test',
          contentType: 'text/plain',
          ctx: null,
        })
      ).status,
    ).toBe(404);

    await setVotingSettings(true, true);
    expect(
      (
        await callVote(validBallot(), {
          origin: 'https://evil.test',
          contentType: 'text/plain',
          ctx: null,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await callVote(validBallot(), {
          contentType: 'text/plain',
          ctx: null,
        })
      ).status,
    ).toBe(415);
    expect((await callVote(validBallot(), { ctx: null })).status).toBe(401);
  });

  it('returns 400 for malformed JSON after the gate passes', async () => {
    const response = await callVote(undefined, { rawBody: '{' });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Malformed JSON body');
  });
});

describe('POST /api/vote ballot casting', () => {
  it('casts an anonymous-choice ballot with frozen snapshot weights', async () => {
    const response = await callVote(validBallot());
    expect(response.status).toBe(204);

    const ballotRows = await getDb(env)
      .select()
      .from(ballots)
      .where(eq(ballots.electionId, 'election-open'));
    expect(ballotRows).toHaveLength(1);
    expect(ballotRows[0]).toMatchObject({
      electionId: 'election-open',
      propertyId: 'property-own',
      weight: 7,
      castByOwnerId: 'owner-own',
      proxyId: null,
    });

    const choiceRows = await getDb(env)
      .select({
        electionId: ballotChoices.electionId,
        candidateId: ballotChoices.candidateId,
        weight: ballotChoices.weight,
      })
      .from(ballotChoices)
      .where(eq(ballotChoices.electionId, 'election-open'))
      .orderBy(asc(ballotChoices.candidateId));
    expect(choiceRows).toEqual([
      {
        electionId: 'election-open',
        candidateId: 'candidate-one',
        weight: 7,
      },
      {
        electionId: 'election-open',
        candidateId: 'candidate-two',
        weight: 7,
      },
    ]);
  });

  it.each([
    ['election-scoped', 'proxy-election'],
    ['meeting-scoped', 'proxy-meeting'],
  ])('casts through a %s proxy held by the caller', async (_label, proxyId) => {
    const response = await callVote({
      ...validBallot(),
      propertyId: 'property-proxy',
      candidateIds: ['candidate-one'],
      castByOwnerId: null,
      proxyId,
    });
    expect(response.status).toBe(204);

    const ballotRows = await getDb(env)
      .select()
      .from(ballots)
      .where(eq(ballots.electionId, 'election-open'));
    expect(ballotRows[0]).toMatchObject({
      propertyId: 'property-proxy',
      weight: 3,
      castByOwnerId: null,
      proxyId,
    });
  });

  it('returns 404 before validating an unknown or out-of-tier election', async () => {
    expect(
      (
        await callVote({
          ...validBallot(),
          electionId: 'does-not-exist',
          candidateIds: ['does-not-exist'],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await callVote({
          ...validBallot(),
          electionId: 'election-board-tier',
          candidateIds: ['does-not-exist'],
        })
      ).status,
    ).toBe(404);
  });

  it('returns 400 for owner and candidate shape errors before lifecycle errors', async () => {
    expect(
      (
        await callVote({
          ...validBallot(),
          electionId: 'election-closed',
          candidateIds: ['candidate-closed'],
          castByOwnerId: 'owner-proxy-grantor',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await callVote({
          ...validBallot(),
          castByOwnerId: 'owner-inactive',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await callVote({
          ...validBallot(),
          candidateIds: ['candidate-withdrawn'],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await callVote({
          ...validBallot(),
          candidateIds: ['candidate-foreign'],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await callVote({
          ...validBallot(),
          candidateIds: ['candidate-one', 'candidate-two', 'candidate-three'],
        })
      ).status,
    ).toBe(400);
  });

  it('returns 403 for an ineligible lot or a caller without current lot authority', async () => {
    expect(
      (
        await callVote({
          ...validBallot(),
          propertyId: 'property-no-snapshot',
          castByOwnerId: 'owner-no-snapshot',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await callVote({
          ...validBallot(),
          propertyId: 'property-proxy',
          castByOwnerId: 'owner-proxy-grantor',
        })
      ).status,
    ).toBe(403);
  });

  it('returns 409 for an invalid proxy scope before checking lifecycle', async () => {
    expect(
      (
        await callVote({
          ...validBallot(),
          propertyId: 'property-proxy',
          castByOwnerId: null,
          proxyId: 'proxy-wrong-scope',
        })
      ).status,
    ).toBe(409);
  });

  it('returns 403 for a scoped proxy not held through a caller-linked lot before lifecycle', async () => {
    expect(
      (
        await callVote({
          ...validBallot(),
          electionId: 'election-closed',
          propertyId: 'property-unheld',
          candidateIds: ['candidate-closed'],
          castByOwnerId: null,
          proxyId: 'proxy-unheld-closed',
        })
      ).status,
    ).toBe(403);
  });

  it('returns 409 for recorded, closed, and duplicate ballots', async () => {
    expect(
      (
        await callVote({
          ...validBallot(),
          electionId: 'election-recorded',
          candidateIds: ['candidate-recorded'],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await callVote({
          ...validBallot(),
          electionId: 'election-closed',
          candidateIds: ['candidate-closed'],
        })
      ).status,
    ).toBe(409);

    expect((await callVote(validBallot())).status).toBe(204);
    expect((await callVote(validBallot())).status).toBe(409);
  });
});

describe('POST /api/vote motion casting', () => {
  it('casts an attributable motion vote with the frozen snapshot weight', async () => {
    const response = await callVote(validMotionVote());
    expect(response.status).toBe(204);
    const rows = await getDb(env)
      .select()
      .from(memberVotes)
      .where(eq(memberVotes.motionId, 'motion-open'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      propertyId: 'property-own',
      castByOwnerId: 'owner-own',
      proxyId: null,
      choice: 'yes',
      weight: 5,
    });
  });

  it('casts a motion vote through a meeting-scoped proxy', async () => {
    const response = await callVote({
      ...validMotionVote(),
      propertyId: 'property-proxy',
      choice: 'abstain',
      castByOwnerId: null,
      proxyId: 'proxy-meeting',
    });
    expect(response.status).toBe(204);
    const rows = await getDb(env)
      .select()
      .from(memberVotes)
      .where(eq(memberVotes.motionId, 'motion-open'));
    expect(rows[0]).toMatchObject({
      propertyId: 'property-proxy',
      castByOwnerId: null,
      proxyId: 'proxy-meeting',
      choice: 'abstain',
      weight: 2,
    });
  });

  it('returns 404 for unknown or out-of-tier motions', async () => {
    expect(
      (await callVote({ ...validMotionVote(), motionId: 'does-not-exist' }))
        .status,
    ).toBe(404);
    expect(
      (
        await callVote({
          ...validMotionVote(),
          motionId: 'motion-board-tier',
        })
      ).status,
    ).toBe(404);
  });

  it('returns 409 for closed/non-draft lifecycle and a second vote', async () => {
    expect(
      (await callVote({ ...validMotionVote(), motionId: 'motion-closed' }))
        .status,
    ).toBe(409);
    expect(
      (await callVote({ ...validMotionVote(), motionId: 'motion-approved' }))
        .status,
    ).toBe(409);

    expect((await callVote(validMotionVote())).status).toBe(204);
    expect((await callVote(validMotionVote())).status).toBe(409);
  });
});

function validBallot() {
  return {
    action: 'castBallot',
    electionId: 'election-open',
    propertyId: 'property-own',
    candidateIds: ['candidate-one', 'candidate-two'],
    castByOwnerId: 'owner-own',
    proxyId: null,
  };
}

function validMotionVote() {
  return {
    action: 'castMotionVote',
    motionId: 'motion-open',
    propertyId: 'property-own',
    choice: 'yes',
    castByOwnerId: 'owner-own',
    proxyId: null,
  };
}

async function callVote(
  body: unknown,
  options: {
    origin?: string | null;
    contentType?: string | null;
    ctx?: AuthContext | null;
    rawBody?: string;
  } = {},
): Promise<Response> {
  const headers = new Headers();
  const origin =
    options.origin === undefined ? 'http://localhost' : options.origin;
  const contentType =
    options.contentType === undefined
      ? 'application/json'
      : options.contentType;
  if (origin !== null) headers.set('origin', origin);
  if (contentType !== null) headers.set('content-type', contentType);
  const request = new Request(voteUrl, {
    method: 'POST',
    headers,
    body: options.rawBody ?? JSON.stringify(body),
  });
  return POST({
    request,
    locals: {
      authContext: options.ctx === undefined ? homeowner : options.ctx,
    },
  } as never);
}

async function setVotingSettings(
  officialMode: boolean,
  liveVotingEnabled: boolean,
): Promise<void> {
  const db = getDb(env);
  await db.delete(settings).where(eq(settings.key, 'site'));
  await db.insert(settings).values({
    key: 'site',
    value: JSON.stringify({ officialMode, liveVotingEnabled }),
    updatedAt: now,
  });
}

function property(id: string, address: string, voteWeight: number) {
  return {
    id,
    address,
    addressNormalized: address.toLowerCase(),
    status: 'active' as const,
    voteWeight,
    createdAt: now,
    updatedAt: now,
  };
}

function link(id: string, propertyId: string) {
  return {
    id,
    userId: 'caller-user',
    propertyId,
    verifiedAt: now,
    method: 'board_manual' as const,
  };
}

function owner(
  id: string,
  propertyId: string,
  fullName: string,
  status: 'active' | 'inactive' = 'active',
) {
  return {
    id,
    propertyId,
    fullName,
    status,
    createdAt: now,
    updatedAt: now,
  };
}

function meeting(
  id: string,
  body: 'member' | 'board',
  status: 'draft' | 'approved',
  visibility: 'public' | 'homeowner' | 'board',
) {
  return {
    id,
    body,
    kind: 'regular' as const,
    date: '2026-10-01',
    title: `Meeting ${id}`,
    status,
    visibility,
    createdBy: 'board-user',
    createdAt: now,
    updatedAt: now,
  };
}

function election(
  id: string,
  meetingId: string | null,
  source: 'recorded' | 'conducted',
  status: 'draft' | 'open' | 'closed',
  visibility: 'public' | 'homeowner' | 'board',
) {
  return {
    id,
    meetingId,
    title: `Election ${id}`,
    seats: 2,
    electionDate: '2026-10-01',
    source,
    status,
    visibility,
    createdBy: 'board-user',
    createdAt: now,
    updatedAt: now,
  };
}

function candidate(
  id: string,
  electionId: string,
  sequence: number,
  withdrawn = false,
) {
  return {
    id,
    electionId,
    fullName: `Candidate ${id}`,
    sequence,
    votes: null,
    won: false,
    withdrawn,
    createdAt: now,
  };
}

function eligibility(electionId: string, propertyId: string, weight: number) {
  return { electionId, propertyId, weight };
}

function motion(
  id: string,
  meetingId: string,
  sequence: number,
  votingState: 'none' | 'open' | 'closed',
) {
  return {
    id,
    meetingId,
    sequence,
    text: `Motion ${id}`,
    votingState,
    outcome: 'tabled' as const,
    createdBy: 'board-user',
    createdAt: now,
    updatedAt: now,
  };
}

function motionEligibilityRow(
  motionId: string,
  propertyId: string,
  weight: number,
) {
  return { motionId, propertyId, weight };
}

function proxy(
  id: string,
  propertyId: string,
  grantorOwnerId: string,
  occasion:
    | { meetingId: string; holderOwnerId: string }
    | { electionId: string; holderOwnerId: string },
) {
  return {
    id,
    propertyId,
    grantorOwnerId,
    holderName: `Holder ${id}`,
    holderOwnerId: occasion.holderOwnerId,
    meetingId: 'meetingId' in occasion ? occasion.meetingId : null,
    electionId: 'electionId' in occasion ? occasion.electionId : null,
    createdBy: 'board-user',
    createdAt: now,
    updatedAt: now,
  };
}
