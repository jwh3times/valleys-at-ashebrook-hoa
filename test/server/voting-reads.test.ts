import { env, applyD1Migrations } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  OpenElectionVotingItem,
  OpenVotingItem,
} from '../../src/lib/types';
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
  userPropertyLinks,
} from '../../src/server/db/schema';
import { users } from '../../src/server/db/auth-schema';
import {
  fetchElectionsFor,
  fetchMeetingFor,
} from '../../src/server/content/reads';
import { fetchOpenVotingFor } from '../../src/server/content/voting-reads';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date('2026-08-05T12:00:00Z');

// propertyIds is deliberately left EMPTY. getAuthContext populates it by
// inner-joining `properties` and filtering to status = 'active', so a lot
// deactivated after an occasion opened would be missing from it in
// production. fetchOpenVotingFor must resolve lots from user_property_links
// instead (ADR 0020's frozen electorate), and seeding an empty set here is
// what proves it no longer reads this field.
const homeowner: AuthContext = {
  userId: 'homeowner-user',
  role: 'homeowner',
  propertyIds: [],
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
  await db.delete(owners);
  await db.delete(userPropertyLinks);
  await db.delete(properties);
  await db.delete(users);

  await db.insert(users).values({
    id: 'homeowner-user',
    name: 'Home Owner',
    email: 'homeowner@example.test',
    emailVerified: true,
    role: 'homeowner',
    createdAt: now,
    updatedAt: now,
  });

  await db
    .insert(properties)
    .values([
      property('property-own', '1 Ashebrook Lane', 70),
      property('property-held', '2 Ashebrook Lane', 30),
      property('property-meeting', '3 Ashebrook Lane', 40),
      property('property-no-snapshot', '4 Ashebrook Lane', 50),
      property('property-unrepresented', '5 Ashebrook Lane', 90),
    ]);
  await db.insert(userPropertyLinks).values({
    id: 'link-own',
    userId: 'homeowner-user',
    propertyId: 'property-own',
    verifiedAt: now,
    method: 'otp_email',
  });
  await db
    .insert(owners)
    .values([
      owner('owner-one', 'property-own', 'Alex Owner'),
      owner('owner-two', 'property-own', 'Blair Owner'),
      owner('owner-inactive', 'property-own', 'Inactive Owner', 'inactive'),
      owner('grantor-held', 'property-held', 'Casey Grantor'),
      owner('grantor-meeting', 'property-meeting', 'Dana Grantor'),
      owner('grantor-no-snapshot', 'property-no-snapshot', 'Emery Grantor'),
      owner(
        'grantor-unrepresented',
        'property-unrepresented',
        'Finley Grantor',
      ),
    ]);
  await db
    .insert(meetings)
    .values([
      meeting('meeting-visible', 'member', 'draft', 'homeowner'),
      meeting('meeting-board-tier', 'member', 'draft', 'board'),
      meeting('meeting-approved', 'member', 'approved', 'public'),
      meeting('meeting-board-body', 'board', 'draft', 'public'),
    ]);
  await db
    .insert(elections)
    .values([
      election(
        'election-visible',
        'meeting-visible',
        'conducted',
        'open',
        'homeowner',
      ),
      election(
        'election-board-tier',
        'meeting-board-tier',
        'conducted',
        'open',
        'board',
      ),
      election('election-recorded', null, 'recorded', 'open', 'public'),
      election('election-draft', null, 'conducted', 'draft', 'public'),
    ]);
  await db
    .insert(candidates)
    .values([
      candidate('selected', 'election-visible', 'Jordan Candidate', 1),
      candidate(
        'withdrawn',
        'election-visible',
        'Withdrawn Candidate',
        2,
        true,
      ),
      candidate('board-candidate', 'election-board-tier', 'Board Candidate', 1),
    ]);
  await db
    .insert(motions)
    .values([
      motion('motion-visible', 'meeting-visible', 'open'),
      motion('motion-board-tier', 'meeting-board-tier', 'open'),
      motion('motion-approved', 'meeting-approved', 'open'),
      motion('motion-board-body', 'meeting-board-body', 'open'),
    ]);
  await db.insert(electionEligibility).values([
    { electionId: 'election-visible', propertyId: 'property-own', weight: 7 },
    { electionId: 'election-visible', propertyId: 'property-held', weight: 3 },
    {
      electionId: 'election-visible',
      propertyId: 'property-meeting',
      weight: 4,
    },
    {
      electionId: 'election-visible',
      propertyId: 'property-unrepresented',
      weight: 9,
    },
    {
      electionId: 'election-board-tier',
      propertyId: 'property-own',
      weight: 7,
    },
  ]);
  await db.insert(motionEligibility).values([
    { motionId: 'motion-visible', propertyId: 'property-own', weight: 7 },
    { motionId: 'motion-visible', propertyId: 'property-held', weight: 3 },
    { motionId: 'motion-visible', propertyId: 'property-meeting', weight: 4 },
    {
      motionId: 'motion-visible',
      propertyId: 'property-unrepresented',
      weight: 9,
    },
    { motionId: 'motion-board-tier', propertyId: 'property-own', weight: 7 },
  ]);
  await db.insert(proxies).values([
    proxy(
      'proxy-own-meeting',
      'property-own',
      'owner-one',
      'Blair Owner',
      'owner-two',
      {
        meetingId: 'meeting-visible',
      },
    ),
    proxy(
      'proxy-held-election',
      'property-held',
      'grantor-held',
      'Alex Owner',
      'owner-one',
      {
        electionId: 'election-visible',
      },
    ),
    proxy(
      'proxy-held-meeting',
      'property-held',
      'grantor-held',
      'Blair Owner',
      'owner-two',
      {
        meetingId: 'meeting-visible',
      },
    ),
    proxy(
      'proxy-meeting-only',
      'property-meeting',
      'grantor-meeting',
      'Alex Owner',
      'owner-one',
      { meetingId: 'meeting-visible' },
    ),
    proxy(
      'proxy-no-snapshot',
      'property-no-snapshot',
      'grantor-no-snapshot',
      'Alex Owner',
      'owner-one',
      { electionId: 'election-visible' },
    ),
    proxy(
      'proxy-inactive-holder',
      'property-unrepresented',
      'grantor-unrepresented',
      'Inactive Owner',
      'owner-inactive',
      { meetingId: 'meeting-visible' },
    ),
  ]);
  await db.insert(ballots).values([
    {
      id: 'ballot-own',
      electionId: 'election-visible',
      propertyId: 'property-own',
      weight: 7,
      castByOwnerId: 'owner-one',
      recordedAt: now,
    },
    {
      id: 'ballot-meeting',
      electionId: 'election-visible',
      propertyId: 'property-meeting',
      weight: 4,
      proxyId: 'proxy-meeting-only',
      recordedAt: now,
    },
  ]);
  await db.insert(ballotChoices).values({
    id: 'choice-secret',
    electionId: 'election-visible',
    candidateId: 'selected',
    weight: 7,
  });
  await db.insert(memberVotes).values({
    id: 'member-vote-held',
    motionId: 'motion-visible',
    propertyId: 'property-held',
    castByOwnerId: null,
    weight: 3,
    choice: 'yes',
    proxyId: 'proxy-held-meeting',
  });

  // Current roster state has drifted since open; the projection must use the
  // immutable snapshot above and must not re-qualify a snapshotted lot by its
  // current status or weight.
  await db
    .update(properties)
    .set({ status: 'inactive', voteWeight: 700 })
    .where(eq(properties.id, 'property-own'));
});

describe('fetchOpenVotingFor', () => {
  it('combines own-lot and valid held-proxy authority into deduplicated snapshot lots', async () => {
    const items: OpenVotingItem[] = await fetchOpenVotingFor(env, homeowner);
    const electionItem = items.find(
      (item): item is OpenElectionVotingItem =>
        item.kind === 'election' && item.id === 'election-visible',
    );
    const motionItem = items.find(
      (item) => item.kind === 'motion' && item.id === 'motion-visible',
    );

    expect(electionItem?.candidates).toEqual([
      {
        id: 'selected',
        fullName: 'Jordan Candidate',
        statementMd: 'Candidate statement',
      },
    ]);
    expect(electionItem?.lots).toEqual([
      {
        propertyId: 'property-own',
        address: '1 Ashebrook Lane',
        weight: 7,
        hasCast: true,
        ownerOptions: [
          { id: 'owner-one', fullName: 'Alex Owner' },
          { id: 'owner-two', fullName: 'Blair Owner' },
        ],
        proxyOptions: [
          {
            id: 'proxy-own-meeting',
            holderName: 'Blair Owner',
            grantingAddress: '1 Ashebrook Lane',
          },
        ],
      },
      {
        propertyId: 'property-held',
        address: '2 Ashebrook Lane',
        weight: 3,
        hasCast: false,
        ownerOptions: [],
        proxyOptions: [
          {
            id: 'proxy-held-election',
            holderName: 'Alex Owner',
            grantingAddress: '2 Ashebrook Lane',
          },
          {
            id: 'proxy-held-meeting',
            holderName: 'Blair Owner',
            grantingAddress: '2 Ashebrook Lane',
          },
        ],
      },
      {
        propertyId: 'property-meeting',
        address: '3 Ashebrook Lane',
        weight: 4,
        hasCast: true,
        ownerOptions: [],
        proxyOptions: [
          {
            id: 'proxy-meeting-only',
            holderName: 'Alex Owner',
            grantingAddress: '3 Ashebrook Lane',
          },
        ],
      },
    ]);
    expect(motionItem?.lots.map((lot) => lot.propertyId)).toEqual([
      'property-own',
      'property-held',
      'property-meeting',
    ]);
    expect(
      motionItem?.lots.find((lot) => lot.propertyId === 'property-held'),
    ).toMatchObject({ weight: 3, hasCast: true });
  });

  it('applies tier and lifecycle gates to elections and motions', async () => {
    const homeownerItems = await fetchOpenVotingFor(env, homeowner);
    expect(homeownerItems.map((item) => `${item.kind}:${item.id}`)).toEqual([
      'election:election-visible',
      'motion:motion-visible',
    ]);

    const boardItems = await fetchOpenVotingFor(env, {
      ...homeowner,
      role: 'board',
    });
    expect(boardItems.map((item) => `${item.kind}:${item.id}`).sort()).toEqual([
      'election:election-board-tier',
      'election:election-visible',
      'motion:motion-board-tier',
      'motion:motion-visible',
    ]);
  });

  it('exposes only per-lot receipt state, never choices, tallies, or correlation metadata', async () => {
    const items = await fetchOpenVotingFor(env, homeowner);
    const json = JSON.stringify(items);

    expect(json).not.toContain('candidateId":"selected');
    expect(json).not.toContain('votes');
    expect(json).not.toContain('ballotChoices');
    expect(json).not.toContain('recordedAt');
    expect(json).not.toContain('"choice"');

    expect(await fetchElectionsFor(env, 'board')).toEqual([]);
    expect(await fetchMeetingFor(env, 'board', 'meeting-visible')).toBeNull();
  });

  it('keeps a lot votable after it is deactivated mid-occasion, and keeps the proxies held for other lots', async () => {
    // The shared beforeEach already deactivates property-own AFTER the
    // occasion opened. ADR 0020 says the frozen snapshot decides eligibility,
    // and the cast path has always honoured that — but the read model used
    // AuthContext.propertyIds, which excludes inactive lots, so the page and
    // POST /api/vote disagreed. Worse, losing the only own lot also emptied
    // the caller's held-proxy list via the no-lots early return, so a lot
    // going inactive silently removed authority over an unrelated lot.
    const own = await getDb(env)
      .select({ status: properties.status })
      .from(properties)
      .where(eq(properties.id, 'property-own'));
    expect(own[0].status).toBe('inactive');

    const items = await fetchOpenVotingFor(env, homeowner);
    const election = items.find(
      (item): item is OpenElectionVotingItem =>
        item.kind === 'election' && item.id === 'election-visible',
    );

    // The deactivated own lot is still offered, at its FROZEN weight (7),
    // not the 700 the roster now says.
    const ownLot = election?.lots.find((l) => l.propertyId === 'property-own');
    expect(ownLot?.weight).toBe(7);
    // And the proxy held for a different lot survived with it.
    expect(election?.lots.some((l) => l.propertyId === 'property-held')).toBe(
      true,
    );
  });

  it('returns no open voting items when the caller has no verified lots', async () => {
    expect(
      await fetchOpenVotingFor(env, {
        userId: 'unverified-user',
        role: 'homeowner',
        propertyIds: [],
      }),
    ).toEqual([]);
  });
});

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
    date: id.includes('board-tier') ? '2026-10-02' : '2026-10-01',
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
  status: 'draft' | 'open',
  visibility: 'public' | 'homeowner' | 'board',
) {
  return {
    id,
    meetingId,
    title: `Election ${id}`,
    seats: 2,
    electionDate: id.includes('board-tier') ? '2026-10-02' : '2026-10-01',
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
  fullName: string,
  sequence: number,
  withdrawn = false,
) {
  return {
    id,
    electionId,
    fullName,
    statementMd: 'Candidate statement',
    sequence,
    withdrawn,
    createdAt: now,
  };
}

function motion(
  id: string,
  meetingId: string,
  votingState: 'open' | 'closed' | 'none',
) {
  return {
    id,
    meetingId,
    sequence: 1,
    text: `Motion ${id}`,
    votingState,
    outcome: 'tabled' as const,
    createdBy: 'board-user',
    createdAt: now,
    updatedAt: now,
  };
}

function proxy(
  id: string,
  propertyId: string,
  grantorOwnerId: string,
  holderName: string,
  holderOwnerId: string,
  occasion: { meetingId: string } | { electionId: string },
) {
  return {
    id,
    propertyId,
    grantorOwnerId,
    holderName,
    holderOwnerId,
    meetingId: 'meetingId' in occasion ? occasion.meetingId : null,
    electionId: 'electionId' in occasion ? occasion.electionId : null,
    createdBy: 'board-user',
    createdAt: now,
    updatedAt: now,
  };
}
