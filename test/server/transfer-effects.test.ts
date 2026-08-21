import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/auth-schema';
import { associationDateIso } from '../../src/lib/format';
import {
  ballotChoices,
  memberAttendance,
  memberVotes,
  motions,
} from '../../src/server/db/schema';
import { parties, people, ownerships } from '../../src/server/db/roster-schema';
import {
  now,
  seedBallot,
  seedCandidate,
  seedElection,
  seedMeeting,
  seedMotion,
  seedProperty,
  seedProxy,
  truncateAll,
} from './fixtures';
import { POST } from '../../src/pages/api/admin/roster-ownerships';
import { DELETE as PROXY_DELETE } from '../../src/pages/api/admin/proxies';

/**
 * ADR 0022 phase 3d (#220): transfer-time effects, per #204's resolution.
 *
 * The claims under test are the ones #204 argues for rather than assumes: an
 * OPEN member-motion vote is the single stored action a transfer reverses (and
 * the buyer may then cast); a CLOSED motion is untouched; a conducted Ballot
 * stands permanently with only a turnout-scoped flag while `ballot_choices`
 * stays byte-identical; the backdated discovery window really starts on the
 * Effective Day; and a void supersedes the flags without reversing one stored
 * consequence.
 *
 * BALLOT SECRECY: this file reads `ballot_choices` in exactly one place, to
 * prove the feature most tempted to touch them does not.
 */

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () =>
    (
      await importActual<typeof import('../../src/server/authz/context')>()
    ).legacyAuthContext('board-1', 'board', []),
}));

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

// Association-day arithmetic, never UTC midnight: a `new Date().toISOString()`
// day here fails every CI run between UTC and Eastern midnight (the 3b lesson).
const day = (offset: number): string =>
  associationDateIso(new Date(Date.now() + offset * 86_400_000));
const TODAY = day(0);

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
  'contact_methods',
  'organizations',
];

// `ownerships`, `people`, and `parties` are deliberately NOT in the list above:
// the proxies record cites a Person since #248 part 2, so they can only be
// cleared once the app tables are, which is what truncateAll() does — and it
// already clears all three in the right order.

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
  await db.insert(users).values({
    id: 'board-1',
    name: 'board-1',
    email: 'board-1@example.test',
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  });
});

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

async function seedOwnership(id: string, ownerPartyId: string, lotId: string) {
  await getDb(env).insert(ownerships).values({
    id,
    ownerPartyId,
    lotId,
    startDay: '2025-01-01',
    createdAt: now,
    updatedAt: now,
  });
}

function req(body: unknown): never {
  return {
    request: new Request('http://localhost/api/admin/roster-ownerships', {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  } as never;
}

interface FlagRow {
  id: string;
  category: string;
  status: string;
  source_event_id: string;
  resolution_code: string | null;
  resolved_at: number | null;
  impacted_proxy_id: string | null;
  impacted_member_attendance_id: string | null;
  impacted_member_vote_id: string | null;
  impacted_motion_id: string | null;
  impacted_ballot_id: string | null;
  impacted_event_id: string | null;
}

async function flags(): Promise<FlagRow[]> {
  return getDb(env).all<FlagRow>(
    sql`SELECT * FROM review_flags ORDER BY category, opened_at`,
  );
}

async function integrityClean() {
  const db = getDb(env);
  expect(await db.all(sql`SELECT * FROM audit_integrity_violations_v`)).toEqual(
    [],
  );
  expect(
    await db.all(sql`SELECT * FROM board_eligibility_violations_v`),
  ).toEqual([]);
}

/** A lot with one recorded Person owner and one legacy owner row (the latter
 * only because `proxies.grantor_person_id` still points at the legacy roster). */
async function seedTransferrableLot() {
  await seedProperty('lot-1');
  await seedPerson('per-1');
  await seedOwnership('osh-1', 'per-1', 'lot-1');
}

describe('vote reset on transfer', () => {
  it("deletes the seller's open-motion vote, advances the revision, and flags the motion", async () => {
    await seedTransferrableLot();
    await seedMeeting('mtg-1', { body: 'member', date: TODAY });
    await seedMotion('mot-1', 'mtg-1', {
      votingState: 'open',
      votingRevision: 3,
    });
    const db = getDb(env);
    await db.insert(memberVotes).values({
      id: 'mv-1',
      motionId: 'mot-1',
      propertyId: 'lot-1',
      weight: 2,
      choice: 'no',
    });

    const res = await POST(
      req({ action: 'end', ownershipId: 'osh-1', endDay: TODAY }),
    );
    expect(res.status).toBe(204);

    expect(
      await db.all(sql`SELECT id FROM member_votes WHERE id = 'mv-1'`),
    ).toEqual([]);
    const [motion] = await db.all<{ voting_revision: number }>(
      sql`SELECT voting_revision FROM motions WHERE id = 'mot-1'`,
    );
    expect(motion.voting_revision).toBe(4);

    const open = await flags();
    expect(open).toHaveLength(1);
    expect(open[0].category).toBe('vote_reset_on_transfer');
    expect(open[0].impacted_motion_id).toBe('mot-1');
    expect(open[0].status).toBe('open');
    expect(open[0].impacted_member_vote_id).toBeNull();

    // The flag's cause is the transfer's own root event, and the opening
    // event is a caused, automatic `review` event naming it.
    const [root] = await db.all<{ id: string; event_kind: string }>(
      sql`SELECT id, event_kind FROM audit_events WHERE correlation_sequence = 0`,
    );
    expect(root.event_kind).toBe('ownership_ended');
    expect(open[0].source_event_id).toBe(root.id);

    const [opened] = await db.all<{
      id: string;
      event_kind: string;
      family: string;
      actor_kind: string;
      automatic_cause: string | null;
      causing_event_id: string | null;
    }>(
      sql`SELECT e.id, e.event_kind, e.family, e.actor_kind, e.automatic_cause, e.causing_event_id
          FROM audit_events e JOIN review_events v ON v.event_id = e.id
          WHERE v.review_flag_id = ${open[0].id}`,
    );
    expect(opened.event_kind).toBe('review_flag_opened');
    expect(opened.family).toBe('review');
    expect(opened.actor_kind).toBe('automatic');
    expect(opened.automatic_cause).toBe('ownership_ended');
    expect(opened.causing_event_id).toBe(root.id);

    // The deleted fact survives where it belongs: the immutable ledger.
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

    // Re-enfranchisement, not silencing: the buyer's vote now fits.
    await db.insert(memberVotes).values({
      id: 'mv-2',
      motionId: 'mot-1',
      propertyId: 'lot-1',
      weight: 2,
      choice: 'yes',
    });
    expect(
      await db.all(sql`SELECT id FROM member_votes WHERE motion_id = 'mot-1'`),
    ).toEqual([{ id: 'mv-2' }]);

    await integrityClean();
  });

  it('leaves a closed motion and its recorded vote untouched', async () => {
    await seedTransferrableLot();
    // Dated well before the window, so the retrospective pass has no claim on
    // it either — the assertion is about the reset, not about discovery.
    await seedMeeting('mtg-1', { body: 'member', date: day(-30) });
    await seedMotion('mot-1', 'mtg-1', {
      votingState: 'closed',
      votingRevision: 3,
    });
    const db = getDb(env);
    await db.insert(memberVotes).values({
      id: 'mv-1',
      motionId: 'mot-1',
      propertyId: 'lot-1',
      weight: 1,
      choice: 'yes',
    });

    const res = await POST(
      req({ action: 'end', ownershipId: 'osh-1', endDay: TODAY }),
    );
    expect(res.status).toBe(204);

    const [vote] = await db.all<{ choice: string }>(
      sql`SELECT choice FROM member_votes WHERE id = 'mv-1'`,
    );
    expect(vote.choice).toBe('yes');
    const [motion] = await db.all<{ voting_revision: number }>(
      sql`SELECT voting_revision FROM motions WHERE id = 'mot-1'`,
    );
    expect(motion.voting_revision).toBe(3);
    expect(await flags()).toEqual([]);
    await integrityClean();
  });

  it('does not reset a vote when the transfer is voided rather than recorded', async () => {
    await seedTransferrableLot();
    await seedMeeting('mtg-1', { body: 'member', date: day(-30) });
    await seedMotion('mot-1', 'mtg-1', {
      votingState: 'open',
      votingRevision: 1,
    });
    const db = getDb(env);
    await db.insert(memberVotes).values({
      id: 'mv-1',
      motionId: 'mot-1',
      propertyId: 'lot-1',
      weight: 1,
      choice: 'abstain',
    });

    const res = await POST(req({ action: 'void', ownershipId: 'osh-1' }));
    expect(res.status).toBe(204);

    expect(
      await db.all(sql`SELECT id FROM member_votes WHERE id = 'mv-1'`),
    ).toEqual([{ id: 'mv-1' }]);
    const [motion] = await db.all<{ voting_revision: number }>(
      sql`SELECT voting_revision FROM motions WHERE id = 'mot-1'`,
    );
    expect(motion.voting_revision).toBe(1);
    expect(
      (await flags()).filter((f) => f.category === 'vote_reset_on_transfer'),
    ).toEqual([]);
    await integrityClean();
  });
});

describe('retrospective discovery window', () => {
  it('finds activity on the effective day and ignores the day before it', async () => {
    await seedTransferrableLot();
    const effectiveDay = day(-10);
    await seedMeeting('mtg-on', { body: 'member', date: effectiveDay });
    await seedMeeting('mtg-before', { body: 'member', date: day(-11) });
    const db = getDb(env);
    await db.insert(memberAttendance).values([
      {
        id: 'ma-on',
        meetingId: 'mtg-on',
        propertyId: 'lot-1',
        present: true,
      },
      {
        id: 'ma-before',
        meetingId: 'mtg-before',
        propertyId: 'lot-1',
        present: true,
      },
    ]);

    const res = await POST(
      req({ action: 'end', ownershipId: 'osh-1', endDay: effectiveDay }),
    );
    expect(res.status).toBe(204);

    const rows = await flags();
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('intervening_action_backdated');
    expect(rows[0].impacted_member_attendance_id).toBe('ma-on');
    await integrityClean();
  });

  it('flags a member vote that survives the transfer, distinctly from a reset', async () => {
    await seedTransferrableLot();
    const effectiveDay = day(-5);
    await seedMeeting('mtg-1', { body: 'member', date: effectiveDay });
    // `none` is neither open (resettable) nor a live session: an ordinary
    // board-entered vote inside the backdated window.
    await seedMotion('mot-1', 'mtg-1', { votingState: 'none' });
    const db = getDb(env);
    await db.insert(memberVotes).values({
      id: 'mv-1',
      motionId: 'mot-1',
      propertyId: 'lot-1',
      weight: 1,
      choice: 'yes',
    });

    const res = await POST(
      req({ action: 'end', ownershipId: 'osh-1', endDay: effectiveDay }),
    );
    expect(res.status).toBe(204);

    const rows = await flags();
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('intervening_action_backdated');
    expect(rows[0].impacted_member_vote_id).toBe('mv-1');
    expect(
      await db.all(sql`SELECT id FROM member_votes WHERE id = 'mv-1'`),
    ).toEqual([{ id: 'mv-1' }]);
    await integrityClean();
  });
});

describe('conducted ballots', () => {
  it('flags the turnout ballot only, leaving every ballot choice byte-identical', async () => {
    await seedTransferrableLot();
    await seedElection('elec-1', { source: 'conducted', status: 'open' });
    await seedCandidate('cand-1', 'elec-1');
    await seedCandidate('cand-2', 'elec-1', { sequence: 1 });
    await seedBallot('bal-1', 'elec-1', 'lot-1');
    const db = getDb(env);
    await db.insert(ballotChoices).values([
      { id: 'bc-1', electionId: 'elec-1', candidateId: 'cand-1', weight: 1 },
      { id: 'bc-2', electionId: 'elec-1', candidateId: 'cand-2', weight: 1 },
    ]);
    const before = await db.all(sql`SELECT * FROM ballot_choices ORDER BY id`);

    const res = await POST(
      req({ action: 'end', ownershipId: 'osh-1', endDay: TODAY }),
    );
    expect(res.status).toBe(204);

    const rows = await flags();
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('ballot_final_after_transfer');
    expect(rows[0].impacted_ballot_id).toBe('bal-1');

    expect(await db.all(sql`SELECT * FROM ballot_choices ORDER BY id`)).toEqual(
      before,
    );
    // No produced flag or review event reaches a choice: the flag's only
    // impacted reference is the turnout row, and the ledger carries none.
    expect(rows[0].impacted_member_vote_id).toBeNull();
    expect(
      await db.all(
        sql`SELECT * FROM audit_scalar_changes WHERE field_key LIKE '%candidate%' OR field_key LIKE '%choice%'`,
      ),
    ).toEqual([]);
    await integrityClean();
  });
});

describe('forward pass and idempotency', () => {
  it('opens exactly one flag for a proxy whose occasion is still upcoming', async () => {
    await seedTransferrableLot();
    await seedMeeting('mtg-next', { body: 'member', date: day(7) });
    // Granted just now AND pending: two passes reach it, one flag results.
    await seedProxy('px-1', {
      propertyId: 'lot-1',
      grantorPersonId: 'per-1',
      meetingId: 'mtg-next',
    });

    const res = await POST(
      req({ action: 'end', ownershipId: 'osh-1', endDay: TODAY }),
    );
    expect(res.status).toBe(204);

    const rows = await flags();
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('authority_lost_pending_occasion');
    expect(rows[0].impacted_proxy_id).toBe('px-1');
    await integrityClean();
  });

  it('opens a NEW flag for the same proxy under a second, distinct transfer', async () => {
    await seedTransferrableLot();
    await seedMeeting('mtg-next', { body: 'member', date: day(7) });
    await seedProxy('px-1', {
      propertyId: 'lot-1',
      grantorPersonId: 'per-1',
      meetingId: 'mtg-next',
    });
    await seedPerson('per-2');
    await seedOwnership('osh-2', 'per-2', 'lot-1');

    expect(
      (await POST(req({ action: 'end', ownershipId: 'osh-1', endDay: TODAY })))
        .status,
    ).toBe(204);
    expect(
      (await POST(req({ action: 'end', ownershipId: 'osh-2', endDay: TODAY })))
        .status,
    ).toBe(204);

    const rows = (await flags()).filter((f) => f.impacted_proxy_id === 'px-1');
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.source_event_id)).size).toBe(2);
    expect(rows.every((r) => r.status === 'open')).toBe(true);
    await integrityClean();
  });
});

describe('flags never freeze the record they reference', () => {
  it("deleting a flagged proxy still works and unsets the flag's reference", async () => {
    // The review pass caught this as the RESTRICT trap: with a writer, a
    // RESTRICT FK would have turned proxy revocation — "the whole revocation
    // model" — into a permanent 500 the moment the forward pass flagged the
    // proxy. Migration 0027 makes the legacy-record references SET NULL, so
    // revocation proceeds and the flag survives with its ledger context.
    await seedTransferrableLot();
    await seedMeeting('mtg-next', { body: 'member', date: day(7) });
    await seedProxy('px-1', {
      propertyId: 'lot-1',
      grantorPersonId: 'per-1',
      meetingId: 'mtg-next',
    });
    expect(
      (await POST(req({ action: 'end', ownershipId: 'osh-1', endDay: TODAY })))
        .status,
    ).toBe(204);
    expect((await flags())[0].impacted_proxy_id).toBe('px-1');

    const del = await PROXY_DELETE({
      request: new Request('http://localhost/api/admin/proxies', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'px-1' }),
      }),
    } as never);
    expect(del.status).toBe(204);

    const rows = await flags();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('open');
    expect(rows[0].impacted_proxy_id).toBeNull();
    await integrityClean();
  });
});

describe('recorded elections', () => {
  it('flags a recorded ballot as backdated activity, never as final', async () => {
    // `ballot_final_after_transfer` is #204's irreversible CONDUCTED case. A
    // recorded election's board-entered rows are freely replaceable through
    // setBallots, so an in-window one is ordinary backdated activity.
    await seedTransferrableLot();
    await seedElection('elec-rec', { source: 'recorded', status: 'draft' });
    await seedBallot('bal-rec', 'elec-rec', 'lot-1');

    const res = await POST(
      req({ action: 'end', ownershipId: 'osh-1', endDay: TODAY }),
    );
    expect(res.status).toBe(204);

    const rows = (await flags()).filter(
      (f) => f.impacted_ballot_id === 'bal-rec',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('intervening_action_backdated');
    await integrityClean();
  });
});

describe('void', () => {
  it('supersedes the transfer flags without reversing one stored consequence', async () => {
    await seedTransferrableLot();
    await seedMeeting('mtg-1', { body: 'member', date: day(-30) });
    await seedMotion('mot-1', 'mtg-1', {
      votingState: 'open',
      votingRevision: 0,
    });
    await seedMeeting('mtg-next', { body: 'member', date: day(7) });
    await seedProxy('px-1', {
      propertyId: 'lot-1',
      grantorPersonId: 'per-1',
      meetingId: 'mtg-next',
    });
    const db = getDb(env);
    await db.insert(memberVotes).values({
      id: 'mv-1',
      motionId: 'mot-1',
      propertyId: 'lot-1',
      weight: 1,
      choice: 'yes',
    });

    expect(
      (await POST(req({ action: 'end', ownershipId: 'osh-1', endDay: TODAY })))
        .status,
    ).toBe(204);
    const opened = await flags();
    expect(opened).toHaveLength(2);
    const openedIds = new Set(opened.map((f) => f.id));

    expect(
      (await POST(req({ action: 'void', ownershipId: 'osh-1' }))).status,
    ).toBe(204);

    const after = await flags();
    for (const flag of after.filter((f) => openedIds.has(f.id))) {
      expect(flag.status).toBe('resolved');
      expect(flag.resolution_code).toBe('superseded');
      expect(flag.resolved_at).not.toBeNull();
    }

    // Every supersession is itself immutable history.
    const superseded = await db.all<{ resolution_code: string | null }>(
      sql`SELECT v.resolution_code FROM audit_events e
          JOIN review_events v ON v.event_id = e.id
          WHERE e.event_kind = 'review_flag_superseded'`,
    );
    expect(superseded).toHaveLength(2);
    expect(superseded.every((s) => s.resolution_code === 'superseded')).toBe(
      true,
    );

    // Derived things recompute; stored things never reverse. The reset vote
    // stays deleted and the revision stays advanced.
    expect(
      await db.all(sql`SELECT id FROM member_votes WHERE id = 'mv-1'`),
    ).toEqual([]);
    const [motion] = await db
      .select({ votingRevision: motions.votingRevision })
      .from(motions);
    expect(motion.votingRevision).toBe(1);
    await integrityClean();
  });
});
