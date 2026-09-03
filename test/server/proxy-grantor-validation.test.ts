import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => legacyAuthContext('board-user', 'board', []),
}));

import { POST as meetingsPost } from '../../src/pages/api/admin/meetings';
import { POST as motionsPost } from '../../src/pages/api/admin/motions';
import { POST as electionsPost } from '../../src/pages/api/admin/elections';

import { POST as votePost } from '../../src/pages/api/vote';
import { legacyAuthContext } from '../../src/server/authz/context';
import type { AuthContext } from '../../src/server/authz/guards';
import { getDb } from '../../src/server/db/client';
import {
  ballotChoices,
  ballots,
  electionEligibility,
  memberAttendance,
  memberVotes,
  motionEligibility,
  proxies,
  settings,
  userPropertyLinks,
  users,
} from '../../src/server/db/schema';
import { ownerships } from '../../src/server/db/roster-schema';
import { associationDateIso } from '../../src/lib/format';
import * as fx from './fixtures';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const GRANTOR_REFUSAL =
  'Proxy grantor did not hold authority for this lot on the occasion date';

const meetingsUrl = 'http://localhost/api/admin/meetings';
const motionsUrl = 'http://localhost/api/admin/motions';
const electionsUrl = 'http://localhost/api/admin/elections';
const voteUrl = 'http://localhost/api/vote';

const now = fx.now;

/**
 * Association-day arithmetic, never UTC midnight: `new Date().toISOString()`
 * lands on the previous day in America/New_York for most of the evening, which
 * is exactly the skew that broke the 3b fixtures in CI.
 */
function associationDayPlus(days: number): string {
  const base = new Date(`${associationDateIso()}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return associationDateIso(base);
}

const holderCaller: AuthContext = legacyAuthContext(
  'holder-user',
  'homeowner',
  ['property-own'],
);
const buyerCaller: AuthContext = legacyAuthContext('buyer-user', 'homeowner', [
  'property-buyer',
]);

function req(url: string, body: unknown) {
  return {
    request: new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never;
}

async function callVote(body: unknown, ctx: AuthContext): Promise<Response> {
  return votePost({
    request: new Request(voteUrl, {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    locals: { authContext: ctx },
  } as never);
}

/**
 * End the grantor's Ownership — the transfer this suite is about — and answer
 * how many rows moved.
 *
 * Before #248 part 2 this flipped `owners.status` through the legacy Owners
 * route. Authority now lives on the roster, and the transfer is written
 * directly rather than through `/api/admin/roster-ownerships` on purpose: that
 * route's own behavior (its audit correlation and the transfer-effects engine)
 * is transfer-effects.test.ts's subject, while THIS suite is about what the
 * proxy guards do once authority is gone, however it went. Writing the state
 * directly also makes the interleaving tests below a test of the casting
 * predicate rather than of another route's batch.
 *
 * By default `endDay` is today. Tests may supply an occasion day to exercise
 * the end-exclusive boundary (`day < end_day`).
 */
async function endGrantorOwnership(
  personId: string,
  endDay = associationDateIso(),
): Promise<number> {
  const result = await getDb(env)
    .update(ownerships)
    .set({ endDay, updatedAt: new Date() })
    .where(eq(ownerships.ownerPartyId, personId));
  return result.meta.changes;
}

beforeEach(async () => {
  await fx.truncateAll();
  const db = getDb(env);
  await db.delete(users);

  await db.insert(users).values([
    {
      id: 'holder-user',
      name: 'Proxy Holder',
      email: 'holder@example.test',
      emailVerified: true,
      role: 'homeowner',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'buyer-user',
      name: 'Lot Buyer',
      email: 'buyer@example.test',
      emailVerified: true,
      role: 'homeowner',
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(settings).values({
    key: 'site',
    value: JSON.stringify({ officialMode: true, liveVotingEnabled: true }),
    updatedAt: now,
  });

  // property-own is the holder's own lot; property-proxy is the lot whose
  // owner signed a proxy over to that holder; property-buyer changes hands
  // mid-election.
  await fx.seedProperty('property-own');
  await fx.seedProperty('property-proxy');
  await fx.seedProperty('property-buyer');
  await db.insert(userPropertyLinks).values([
    {
      id: 'link-holder',
      userId: 'holder-user',
      propertyId: 'property-own',
      verifiedAt: now,
      method: 'board_manual',
    },
    {
      id: 'link-buyer',
      userId: 'buyer-user',
      propertyId: 'property-buyer',
      verifiedAt: now,
      method: 'board_manual',
    },
  ]);
  await fx.seedLotAuthority('owner-holder', 'property-own');
  await fx.seedLotAuthority('owner-grantor', 'property-proxy');
  // The seller held property-buyer when the election opened; the buyer owns it
  // now. Both Ownerships exist, only one is current — #248 part 2 makes that
  // an ended interval rather than an `owners.status` flag.
  await fx.seedLotAuthority('owner-seller', 'property-buyer', {
    endDay: '2020-01-01',
  });
  await fx.seedLotAuthority('owner-buyer', 'property-buyer');

  // Live-voting occasion: an open conducted election held at a draft member
  // meeting that also carries an open motion.
  await fx.seedMeeting('meeting-live', {
    date: associationDayPlus(7),
    visibility: 'homeowner',
    createdBy: 'board-user',
  });
  await fx.seedElection('election-live', {
    meetingId: 'meeting-live',
    electionDate: associationDayPlus(7),
    source: 'conducted',
    status: 'open',
    visibility: 'homeowner',
    createdBy: 'board-user',
  });
  await fx.seedCandidate('candidate-live', 'election-live', { sequence: 1 });
  await fx.seedMotion('motion-live', 'meeting-live', {
    votingState: 'open',
    outcome: 'tabled',
    createdBy: 'board-user',
  });
  await db.insert(electionEligibility).values([
    { electionId: 'election-live', propertyId: 'property-proxy', weight: 3 },
    { electionId: 'election-live', propertyId: 'property-buyer', weight: 4 },
  ]);
  await db.insert(motionEligibility).values([
    { motionId: 'motion-live', propertyId: 'property-proxy', weight: 3 },
    { motionId: 'motion-live', propertyId: 'property-buyer', weight: 4 },
  ]);
  await fx.seedProxy('proxy-live-meeting', {
    propertyId: 'property-proxy',
    grantorPersonId: 'owner-grantor',
    holderPersonId: 'owner-holder',
    meetingId: 'meeting-live',
    createdBy: 'board-user',
  });

  // Record-keeping occasion: a separate draft meeting with a motion that has
  // never opened, plus a standalone recorded election.
  await fx.seedMeeting('meeting-record', {
    date: associationDayPlus(-7),
    createdBy: 'board-user',
  });
  await fx.seedMotion('motion-record', 'meeting-record', {
    createdBy: 'board-user',
  });
  await fx.seedElection('election-record', {
    meetingId: 'meeting-record',
    electionDate: associationDayPlus(-3),
    status: 'draft',
    createdBy: 'board-user',
  });
  await fx.seedProxy('proxy-record-meeting', {
    propertyId: 'property-proxy',
    grantorPersonId: 'owner-grantor',
    holderPersonId: 'owner-holder',
    meetingId: 'meeting-record',
    createdBy: 'board-user',
  });
  await fx.seedProxy('proxy-record-election', {
    propertyId: 'property-proxy',
    grantorPersonId: 'owner-grantor',
    holderPersonId: 'owner-holder',
    electionId: 'election-record',
    createdBy: 'board-user',
  });
});

describe('grantor re-validation on the record-keeping routes', () => {
  it('setMemberAttendance accepts a proxy whose grantor is still an active owner', async () => {
    const response = await meetingsPost(
      req(meetingsUrl, {
        action: 'setMemberAttendance',
        meetingId: 'meeting-record',
        entries: [
          {
            propertyId: 'property-proxy',
            present: true,
            proxyId: 'proxy-record-meeting',
          },
        ],
      }),
    );
    expect(response.status).toBe(204);
    const rows = await getDb(env).select().from(memberAttendance);
    expect(rows).toHaveLength(1);
    expect(rows[0].proxyId).toBe('proxy-record-meeting');
  });

  it('setMemberAttendance accepts a proxy whose grantor sold after the meeting', async () => {
    expect(await endGrantorOwnership('owner-grantor')).toBe(1);
    const response = await meetingsPost(
      req(meetingsUrl, {
        action: 'setMemberAttendance',
        meetingId: 'meeting-record',
        entries: [
          {
            propertyId: 'property-proxy',
            present: true,
            proxyId: 'proxy-record-meeting',
          },
        ],
      }),
    );
    expect(response.status).toBe(204);
    const rows = await getDb(env).select().from(memberAttendance);
    expect(rows).toHaveLength(1);
    expect(rows[0].proxyId).toBe('proxy-record-meeting');
  });

  it('setMemberAttendance refuses a proxy whose grantor sold on the meeting day', async () => {
    expect(
      await endGrantorOwnership('owner-grantor', associationDayPlus(-7)),
    ).toBe(1);
    const response = await meetingsPost(
      req(meetingsUrl, {
        action: 'setMemberAttendance',
        meetingId: 'meeting-record',
        entries: [
          {
            propertyId: 'property-proxy',
            present: true,
            proxyId: 'proxy-record-meeting',
          },
        ],
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toBe(GRANTOR_REFUSAL);
    expect(await getDb(env).select().from(memberAttendance)).toHaveLength(0);
  });

  it('setMemberVotes accepts a proxy whose grantor is still an active owner', async () => {
    const response = await motionsPost(
      req(motionsUrl, {
        action: 'setMemberVotes',
        motionId: 'motion-record',
        entries: [
          {
            propertyId: 'property-proxy',
            choice: 'yes',
            proxyId: 'proxy-record-meeting',
          },
        ],
      }),
    );
    expect(response.status).toBe(204);
    const rows = await getDb(env).select().from(memberVotes);
    expect(rows).toHaveLength(1);
    expect(rows[0].proxyId).toBe('proxy-record-meeting');
  });

  it('setMemberVotes accepts a proxy whose grantor sold after the meeting', async () => {
    expect(await endGrantorOwnership('owner-grantor')).toBe(1);
    const response = await motionsPost(
      req(motionsUrl, {
        action: 'setMemberVotes',
        motionId: 'motion-record',
        entries: [
          {
            propertyId: 'property-proxy',
            choice: 'yes',
            proxyId: 'proxy-record-meeting',
          },
        ],
      }),
    );
    expect(response.status).toBe(204);
    const rows = await getDb(env).select().from(memberVotes);
    expect(rows).toHaveLength(1);
    expect(rows[0].proxyId).toBe('proxy-record-meeting');
  });

  it('setMemberVotes refuses a proxy whose grantor sold on the meeting day', async () => {
    expect(
      await endGrantorOwnership('owner-grantor', associationDayPlus(-7)),
    ).toBe(1);
    const response = await motionsPost(
      req(motionsUrl, {
        action: 'setMemberVotes',
        motionId: 'motion-record',
        entries: [
          {
            propertyId: 'property-proxy',
            choice: 'yes',
            proxyId: 'proxy-record-meeting',
          },
        ],
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toBe(GRANTOR_REFUSAL);
    expect(await getDb(env).select().from(memberVotes)).toHaveLength(0);
  });

  it('setBallots accepts a proxy whose grantor is still an active owner', async () => {
    const response = await electionsPost(
      req(electionsUrl, {
        action: 'setBallots',
        electionId: 'election-record',
        entries: [
          { propertyId: 'property-proxy', proxyId: 'proxy-record-election' },
        ],
      }),
    );
    expect(response.status).toBe(204);
    const rows = await getDb(env).select().from(ballots);
    expect(rows).toHaveLength(1);
    expect(rows[0].proxyId).toBe('proxy-record-election');
  });

  it('setBallots accepts a proxy whose grantor sold after the election', async () => {
    expect(await endGrantorOwnership('owner-grantor')).toBe(1);
    const response = await electionsPost(
      req(electionsUrl, {
        action: 'setBallots',
        electionId: 'election-record',
        entries: [
          { propertyId: 'property-proxy', proxyId: 'proxy-record-election' },
        ],
      }),
    );
    expect(response.status).toBe(204);
    const rows = await getDb(env).select().from(ballots);
    expect(rows).toHaveLength(1);
    expect(rows[0].proxyId).toBe('proxy-record-election');
  });

  it('setBallots refuses a proxy whose grantor sold on the election day', async () => {
    expect(
      await endGrantorOwnership('owner-grantor', associationDayPlus(-3)),
    ).toBe(1);
    const response = await electionsPost(
      req(electionsUrl, {
        action: 'setBallots',
        electionId: 'election-record',
        entries: [
          { propertyId: 'property-proxy', proxyId: 'proxy-record-election' },
        ],
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toBe(GRANTOR_REFUSAL);
    expect(await getDb(env).select().from(ballots)).toHaveLength(0);
  });

  it('uses the election day for a meeting-scoped proxy covering that election', async () => {
    // Authority still held on the meeting day (-7) but ended before the
    // election day (-3), so validating against the meeting would accept it.
    expect(
      await endGrantorOwnership('owner-grantor', associationDayPlus(-5)),
    ).toBe(1);
    const response = await electionsPost(
      req(electionsUrl, {
        action: 'setBallots',
        electionId: 'election-record',
        entries: [
          { propertyId: 'property-proxy', proxyId: 'proxy-record-meeting' },
        ],
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toBe(GRANTOR_REFUSAL);
    expect(await getDb(env).select().from(ballots)).toHaveLength(0);
  });

  it('names the grantor problem rather than a lot or occasion mismatch', async () => {
    // The three 409s share a status code, so the message is the only thing
    // telling a board member which rule refused the entry.
    expect(
      await endGrantorOwnership('owner-grantor', associationDayPlus(-7)),
    ).toBe(1);
    const grantor = await meetingsPost(
      req(meetingsUrl, {
        action: 'setMemberAttendance',
        meetingId: 'meeting-record',
        entries: [
          {
            propertyId: 'property-proxy',
            present: true,
            proxyId: 'proxy-record-meeting',
          },
        ],
      }),
    );
    expect(await grantor.text()).toBe(GRANTOR_REFUSAL);
    const wrongLot = await meetingsPost(
      req(meetingsUrl, {
        action: 'setMemberAttendance',
        meetingId: 'meeting-record',
        entries: [
          {
            propertyId: 'property-own',
            present: true,
            proxyId: 'proxy-record-meeting',
          },
        ],
      }),
    );
    expect(await wrongLot.text()).toBe('Proxy is for a different lot');
  });
});

describe('grantor re-validation on the live cast path', () => {
  function proxyBallot() {
    return {
      action: 'castBallot',
      electionId: 'election-live',
      propertyId: 'property-proxy',
      candidateIds: ['candidate-live'],
      castByPersonId: null,
      proxyId: 'proxy-live-meeting',
    };
  }

  function proxyMotionVote() {
    return {
      action: 'castMotionVote',
      motionId: 'motion-live',
      propertyId: 'property-proxy',
      choice: 'yes',
      castByPersonId: null,
      proxyId: 'proxy-live-meeting',
    };
  }

  it('casts a proxy ballot while the grantor still holds the lot', async () => {
    const response = await callVote(proxyBallot(), holderCaller);
    expect(response.status).toBe(204);
    const rows = await getDb(env)
      .select()
      .from(ballots)
      .where(eq(ballots.electionId, 'election-live'));
    expect(rows).toHaveLength(1);
    expect(rows[0].proxyId).toBe('proxy-live-meeting');
  });

  it('refuses a proxy ballot once the grantor is no longer active', async () => {
    expect(await endGrantorOwnership('owner-grantor')).toBe(1);
    const response = await callVote(proxyBallot(), holderCaller);
    expect(response.status).toBe(409);
    expect(await response.text()).toBe(GRANTOR_REFUSAL);
    expect(await getDb(env).select().from(ballots)).toHaveLength(0);
    expect(await getDb(env).select().from(ballotChoices)).toHaveLength(0);
  });

  it('casts a proxy motion vote while the grantor still holds the lot', async () => {
    const response = await callVote(proxyMotionVote(), holderCaller);
    expect(response.status).toBe(204);
    const rows = await getDb(env).select().from(memberVotes);
    expect(rows).toHaveLength(1);
    expect(rows[0].proxyId).toBe('proxy-live-meeting');
  });

  it('refuses a proxy motion vote once the grantor is no longer active', async () => {
    expect(await endGrantorOwnership('owner-grantor')).toBe(1);
    const response = await callVote(proxyMotionVote(), holderCaller);
    expect(response.status).toBe(409);
    expect(await response.text()).toBe(GRANTOR_REFUSAL);
    expect(await getDb(env).select().from(memberVotes)).toHaveLength(0);
  });
});

describe('a buyer who acquires a lot mid-election', () => {
  it('casts on the frozen eligibility of a lot with no ballot yet', async () => {
    // Eligibility was frozen at open against property-buyer while the seller
    // held it. Nothing about the transfer touches that snapshot: the Lot is
    // eligible at weight 4 either way, and the buyer's Ownership is current at
    // cast time, so the Lot's voice survives the sale.
    const response = await callVote(
      {
        action: 'castBallot',
        electionId: 'election-live',
        propertyId: 'property-buyer',
        candidateIds: ['candidate-live'],
        castByPersonId: 'owner-buyer',
        proxyId: null,
      },
      buyerCaller,
    );
    expect(response.status).toBe(204);
    const rows = await getDb(env)
      .select()
      .from(ballots)
      .where(eq(ballots.propertyId, 'property-buyer'));
    expect(rows).toHaveLength(1);
    expect(rows[0].weight).toBe(4);
    expect(rows[0].castByPersonId).toBe('owner-buyer');
  });

  it('refuses the departed seller on the same lot', async () => {
    // The control for the test above: the Lot still counts, but the seller no
    // longer acts for it.
    const response = await callVote(
      {
        action: 'castBallot',
        electionId: 'election-live',
        propertyId: 'property-buyer',
        candidateIds: ['candidate-live'],
        castByPersonId: 'owner-seller',
        proxyId: null,
      },
      buyerCaller,
    );
    expect(response.status).toBe(400);
    expect(await getDb(env).select().from(ballots)).toHaveLength(0);
  });
});

describe('a proxy cast racing an ownership change', () => {
  function proxyBallot() {
    return {
      action: 'castBallot',
      electionId: 'election-live',
      propertyId: 'property-proxy',
      candidateIds: ['candidate-live'],
      castByPersonId: null,
      proxyId: 'proxy-live-meeting',
    };
  }

  it('refuses an in-flight cast when the ownership change commits first', async () => {
    // The cast's preflight passed while the grantor was still active; the
    // authority re-check inside the mutation SQL is what has to catch this.
    const barrier = fx.pauseNextBatch();
    try {
      const castPromise = callVote(proxyBallot(), holderCaller);
      await barrier.reached;
      expect(await endGrantorOwnership('owner-grantor')).toBe(1);
      barrier.release();
      const response = await castPromise;
      expect(response.status).toBe(409);
      expect(await response.text()).not.toBe('');
    } finally {
      barrier.release();
      barrier.restore();
    }

    // No partial write on either side: the transfer landed, the cast did not.
    expect(await getDb(env).select().from(ballots)).toHaveLength(0);
    expect(await getDb(env).select().from(ballotChoices)).toHaveLength(0);
    const grantorRows = await getDb(env)
      .select({ endDay: ownerships.endDay })
      .from(ownerships)
      .where(eq(ownerships.ownerPartyId, 'owner-grantor'));
    expect(grantorRows[0].endDay).toBe(associationDateIso());
  });

  it('lets the ownership change succeed when the cast commits first', async () => {
    const response = await callVote(proxyBallot(), holderCaller);
    expect(response.status).toBe(204);

    expect(await endGrantorOwnership('owner-grantor')).toBe(1);

    // The cast was valid when it was made and is not retroactively undone;
    // the transfer is recorded alongside it.
    const ballotRows = await getDb(env).select().from(ballots);
    expect(ballotRows).toHaveLength(1);
    expect(ballotRows[0].proxyId).toBe('proxy-live-meeting');
    expect(await getDb(env).select().from(ballotChoices)).toHaveLength(1);
    const grantorRows = await getDb(env)
      .select({ endDay: ownerships.endDay })
      .from(ownerships)
      .where(eq(ownerships.ownerPartyId, 'owner-grantor'));
    expect(grantorRows[0].endDay).toBe(associationDateIso());

    // And the now-stale proxy confers nothing on the next occasion.
    const later = await callVote(
      {
        action: 'castMotionVote',
        motionId: 'motion-live',
        propertyId: 'property-proxy',
        choice: 'yes',
        castByPersonId: null,
        proxyId: 'proxy-live-meeting',
      },
      holderCaller,
    );
    expect(later.status).toBe(409);
    expect(await later.text()).toBe(GRANTOR_REFUSAL);
  });

  it('keeps the proxy row itself intact through both orderings', async () => {
    // Deletion is the entire revocation model and is deliberately NOT what a
    // lapsed grantor triggers — the record stands, only its effect stops.
    expect(await endGrantorOwnership('owner-grantor')).toBe(1);
    const rows = await getDb(env)
      .select()
      .from(proxies)
      .where(eq(proxies.id, 'proxy-live-meeting'));
    expect(rows).toHaveLength(1);
  });
});
