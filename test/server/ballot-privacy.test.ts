import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import {
  ballots,
  electionEligibility,
  motionEligibility,
  settings,
  userPropertyLinks,
  users,
} from '../../src/server/db/schema';
import { parties, people, ownerships } from '../../src/server/db/roster-schema';
import { associationDateIso } from '../../src/lib/format';
import { legacyAuthContext } from '../../src/server/authz/context';
import type { AuthContext } from '../../src/server/authz/guards';
import {
  now,
  seedCandidate,
  seedElection,
  seedMeeting,
  seedMotion,
  seedOwner,
  seedProperty,
  truncateAll,
} from './fixtures';
import { POST as ownershipPost } from '../../src/pages/api/admin/roster-ownerships';
import { POST as votePost } from '../../src/pages/api/vote';
import { GET as reviewFlagsGet } from '../../src/pages/api/admin/review-flags';
import type { ReviewFlagRow } from '../../src/pages/api/admin/review-flags';

/**
 * The ballot-privacy suite (#206's "outlives the migration" pair, #220's
 * acceptance criterion, #204's "Ballot secrecy boundary").
 *
 * The claim under test is a NEGATIVE one, which is why it needs a runtime half
 * as well as `test/unit/ballot-privacy-boundary.test.ts`'s static scan: a
 * transfer over a Lot that has cast a conducted Ballot must leave every
 * `ballot_choices` row byte-identical, reach the identity-linked turnout row
 * and nothing further, and produce no event, delta, flag, or register response
 * carrying a choice id or a candidate id anywhere in it.
 *
 * Everything here goes through real writers: the ballot is cast through
 * `POST /api/vote`, the member-motion vote too, the transfer through
 * `POST /api/admin/roster-ownerships`, and the queue is read through
 * `GET /api/admin/review-flags`. A hand-seeded choice row would prove nothing
 * about what the cast path and the discovery engine actually do.
 *
 * BALLOT SECRECY: this file reads `ballot_choices` deliberately, and is the
 * only kind of code that may — proving the rows are untouched is the one use
 * that serves secrecy rather than breaching it. `src/` is held to the opposite
 * rule by the static scan.
 */

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

// Association-day arithmetic, never UTC midnight (the 3b CI skew lesson).
const day = (offset: number): string =>
  associationDateIso(new Date(Date.now() + offset * 86_400_000));
const TODAY = day(0);

const VOTER: AuthContext = legacyAuthContext('voter-1', 'homeowner', ['lot-1']);
const BOARD: AuthContext = legacyAuthContext('board-1', 'board', []);

/** Candidate ids chosen to be distinctive: the ledger scans below are
 * substring searches over whole-table dumps, and a generic id would make an
 * absence assertion accidentally weak. */
const CANDIDATE_IDS = ['candidate-alpha', 'candidate-beta'];

/**
 * Every ledger table a roster command can write. The privacy assertion is a
 * scan of ALL their columns rather than of the columns we expect to be
 * populated: a choice id leaking through a free-text or evidence column is
 * exactly the failure a targeted assertion would miss.
 */
const LEDGER_TABLES = [
  'audit_events',
  'roster_changes',
  'roster_change_subjects',
  'board_service_changes',
  'board_service_change_subjects',
  'audit_scalar_changes',
  'audit_sensitive_field_changes',
  'identity_events',
  'access_events',
  'review_events',
  'review_flags',
];

// Children before parents; the ledger's consequences before their roots.
const CLEAR = [
  'audit_scalar_changes',
  'audit_sensitive_field_changes',
  'board_service_change_subjects',
  'roster_change_subjects',
  'board_service_changes',
  'roster_changes',
  'identity_events',
  'access_events',
  'review_events',
  'redaction_tasks',
  'roster_redactions',
  'review_flags',
  'audit_events',
  'access_grants',
  'board_office_assignments',
  'board_service_terms',
  'person_links',
  'person_verifications',
  'representation_lots',
  'representations',
  'ownerships',
  'contact_methods',
  'organizations',
  'people',
  'parties',
];

beforeEach(async () => {
  const db = getDb(env);
  for (const table of CLEAR) {
    if (table === 'audit_events') {
      // Self-referential causing_event_id is RESTRICT: consequences first.
      await db.run(
        sql.raw('DELETE FROM "audit_events" WHERE correlation_sequence > 0'),
      );
    }
    await db.run(sql.raw(`DELETE FROM "${table}"`));
  }
  await truncateAll();
  await db.run(sql.raw('DELETE FROM users'));
  await db.insert(users).values([account('board-1'), account('voter-1')]);
  // Both flags literal-true: the cast path's SQL requires it, and the reset
  // deliberately does not (an open motion is open while casting is paused).
  await db.insert(settings).values({
    key: 'site',
    value: JSON.stringify({ officialMode: true, liveVotingEnabled: true }),
    updatedAt: now,
  });
});

function account(id: string) {
  return {
    id,
    name: id,
    email: `${id}@example.test`,
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  };
}

async function seedPerson(id: string) {
  const db = getDb(env);
  await db
    .insert(parties)
    .values({ id, kind: 'person', createdAt: now, updatedAt: now });
  await db.insert(people).values({
    partyId: id,
    partyKind: 'person',
    fullName: `Person ${id}`,
    nameNormalized: `person ${id}`,
    updatedAt: now,
  });
}

/**
 * One Lot the seller both owns in the new model (what the transfer ends) and
 * owns in the legacy roster (what the cast path's authority SQL reads), with
 * the caller verified for it.
 */
async function seedVotingLot() {
  const db = getDb(env);
  await seedProperty('lot-1');
  await seedOwner('own-1', 'lot-1');
  await seedPerson('per-1');
  await db.insert(ownerships).values({
    id: 'osh-1',
    ownerPartyId: 'per-1',
    lotId: 'lot-1',
    startDay: '2025-01-01',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(userPropertyLinks).values({
    id: 'link-1',
    userId: 'voter-1',
    propertyId: 'lot-1',
    verifiedAt: now,
    method: 'board_manual',
  });
}

async function callVote(body: unknown): Promise<Response> {
  return votePost({
    request: new Request('http://localhost/api/vote', {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    locals: { authContext: VOTER },
  } as never);
}

async function endOwnership(endDay: string): Promise<Response> {
  return ownershipPost({
    request: new Request('http://localhost/api/admin/roster-ownerships', {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'end', ownershipId: 'osh-1', endDay }),
    }),
    locals: { authContext: BOARD },
  } as never);
}

/**
 * Opens a conducted election with frozen eligibility and casts the Lot's
 * ballot through the real cast path, so the retained choice rows are the ones
 * the writer actually produces.
 */
async function castConductedBallot(): Promise<void> {
  await seedElection('elec-1', {
    source: 'conducted',
    status: 'open',
    visibility: 'public',
    seats: 2,
    electionDate: TODAY,
  });
  await seedCandidate(CANDIDATE_IDS[0], 'elec-1', { sequence: 0 });
  await seedCandidate(CANDIDATE_IDS[1], 'elec-1', { sequence: 1 });
  await getDb(env)
    .insert(electionEligibility)
    .values({ electionId: 'elec-1', propertyId: 'lot-1', weight: 3 });

  const res = await callVote({
    action: 'castBallot',
    electionId: 'elec-1',
    propertyId: 'lot-1',
    candidateIds: CANDIDATE_IDS,
    castByPersonId: 'own-1',
    proxyId: null,
  });
  expect(res.status).toBe(204);
}

interface ChoiceRow {
  id: string;
  election_id: string;
  candidate_id: string;
  weight: number;
}

/** The whole choice table, ordered, for the byte-identity comparison. */
async function choiceRows(): Promise<ChoiceRow[]> {
  return getDb(env).all<ChoiceRow>(
    sql`SELECT * FROM ballot_choices ORDER BY id`,
  );
}

interface FlagRow {
  id: string;
  category: string;
  status: string;
  source_event_id: string;
  impacted_proxy_id: string | null;
  impacted_member_attendance_id: string | null;
  impacted_member_vote_id: string | null;
  impacted_motion_id: string | null;
  impacted_ballot_id: string | null;
  impacted_board_term_id: string | null;
  impacted_access_grant_id: string | null;
  impacted_event_id: string | null;
}

async function flags(): Promise<FlagRow[]> {
  return getDb(env).all<FlagRow>(
    sql`SELECT * FROM review_flags ORDER BY category`,
  );
}

/** Every row of every ledger table, serialized — the haystack for the absence
 * assertions. */
async function ledgerDump(): Promise<string> {
  const db = getDb(env);
  const out: Record<string, unknown[]> = {};
  for (const table of LEDGER_TABLES) {
    out[table] = await db.all(sql.raw(`SELECT * FROM "${table}"`));
  }
  return JSON.stringify(out);
}

function expectNoChoiceReference(haystack: string, choiceIds: string[]): void {
  for (const id of [...choiceIds, ...CANDIDATE_IDS]) {
    expect(haystack).not.toContain(id);
  }
  expect(haystack).not.toContain('ballot_choices');
}

async function integrityClean(): Promise<void> {
  const db = getDb(env);
  expect(await db.all(sql`SELECT * FROM audit_integrity_violations_v`)).toEqual(
    [],
  );
  expect(
    await db.all(sql`SELECT * FROM board_eligibility_violations_v`),
  ).toEqual([]);
}

describe('a transfer over a conducted election', () => {
  it('leaves every ballot choice byte-identical and reaches only the turnout row', async () => {
    await seedVotingLot();
    await castConductedBallot();

    const db = getDb(env);
    const before = await choiceRows();
    expect(before).toHaveLength(2);
    const choiceIds = before.map((row) => row.id);
    const [ballot] = await db.select({ id: ballots.id }).from(ballots);

    expect((await endOwnership(TODAY)).status).toBe(204);

    // (a) The retained ballot box is untouched — not re-weighted, not
    // re-pointed, not deleted. #204: a transfer changes who may act for a Lot,
    // never whether the Lot counts, and a conducted Ballot stands permanently.
    expect(await choiceRows()).toEqual(before);

    // (b) The one flag reaches the identity-linked turnout row and stops.
    const rows = await flags();
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('ballot_final_after_transfer');
    expect(rows[0].impacted_ballot_id).toBe(ballot.id);
    for (const row of rows) {
      expect([null, ballot.id]).toContain(row.impacted_ballot_id);
      // Nothing else on the flag names a record for this election either.
      expect(row.impacted_member_vote_id).toBeNull();
      expect(row.impacted_motion_id).toBeNull();
      expect(row.impacted_proxy_id).toBeNull();
    }

    // (c) No ledger row the command wrote carries a choice or candidate id in
    // ANY column — scanned as a whole-table dump rather than column by column.
    expectNoChoiceReference(await ledgerDump(), choiceIds);
    await integrityClean();
  });

  it('exposes the ballot to the review-flags register as a turnout reference only', async () => {
    await seedVotingLot();
    await castConductedBallot();
    const choiceIds = (await choiceRows()).map((row) => row.id);
    const [ballot] = await getDb(env).select({ id: ballots.id }).from(ballots);

    expect((await endOwnership(TODAY)).status).toBe(204);

    const response = await reviewFlagsGet({
      request: new Request('http://localhost/api/admin/review-flags'),
      locals: { authContext: BOARD },
    } as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ReviewFlagRow[];

    expect(body).toHaveLength(1);
    expect(body[0].category).toBe('ballot_final_after_transfer');
    expect(body[0].impacted).toEqual({ kind: 'ballot', id: ballot.id });

    // The queue is the surface a human reads, so it is the surface most likely
    // to grow a "helpful" join. Nothing anywhere in the response carries a
    // choice id, a candidate id, or the choice table's name.
    expectNoChoiceReference(JSON.stringify(body), choiceIds);
    await integrityClean();
  });
});

describe('the member-motion vote reset beside a conducted ballot', () => {
  it('records the reset vote choice and weight while naming no ballot choice', async () => {
    await seedVotingLot();
    await castConductedBallot();
    await seedMeeting('mtg-1', {
      body: 'member',
      date: TODAY,
      visibility: 'public',
    });
    await seedMotion('mot-1', 'mtg-1', {
      votingState: 'open',
      votingRevision: 0,
    });
    const db = getDb(env);
    await db
      .insert(motionEligibility)
      .values({ motionId: 'mot-1', propertyId: 'lot-1', weight: 2 });
    expect(
      (
        await callVote({
          action: 'castMotionVote',
          motionId: 'mot-1',
          propertyId: 'lot-1',
          choice: 'no',
          castByPersonId: 'own-1',
          proxyId: null,
        })
      ).status,
    ).toBe(204);

    const before = await choiceRows();
    const choiceIds = before.map((row) => row.id);

    expect((await endOwnership(TODAY)).status).toBe(204);

    const rows = await flags();
    expect(rows.map((r) => r.category)).toEqual([
      'ballot_final_after_transfer',
      'vote_reset_on_transfer',
    ]);
    const reset = rows[1];
    expect(reset.impacted_motion_id).toBe('mot-1');
    expect(reset.impacted_ballot_id).toBeNull();

    // The MEMBER-MOTION vote's choice and weight are recorded as deltas, and
    // that is legal and deliberate: member votes are attributable and
    // board-correctable by design (#204), so the deleted fact survives in the
    // immutable ledger. The asymmetry with the conducted ballot is the whole
    // point — one is correctable, the other is secret and final.
    const [opened] = await db.all<{ id: string }>(
      sql`SELECT e.id FROM audit_events e
          JOIN review_events v ON v.event_id = e.id
          WHERE v.review_flag_id = ${reset.id}`,
    );
    const scalars = await db.all<{
      field_key: string;
      value_type: string;
      old_text: string | null;
      old_integer: number | null;
      new_text: string | null;
      new_integer: number | null;
    }>(
      sql`SELECT field_key, value_type, old_text, old_integer, new_text, new_integer
          FROM audit_scalar_changes WHERE event_id = ${opened.id}
          ORDER BY field_key`,
    );
    expect(scalars).toHaveLength(2);
    expect(scalars[0]).toMatchObject({
      field_key: 'choice',
      value_type: 'text',
      old_text: 'no',
      new_text: null,
    });
    expect(scalars[1]).toMatchObject({
      field_key: 'weight',
      value_type: 'integer',
      old_integer: 2,
      new_integer: null,
    });

    // ...and NO election choice data appears anywhere the reset wrote. The
    // motion's `choice` delta is a member-motion choice; a ballot choice id or
    // candidate id in the same dump would be the violation.
    expectNoChoiceReference(await ledgerDump(), choiceIds);
    expect(await choiceRows()).toEqual(before);
    await integrityClean();
  });
});
