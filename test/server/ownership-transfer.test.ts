import { seedAccountLink } from './roster-fixtures';
import {
  pauseNextBatch,
  seedMeeting,
  seedMotion,
  seedElection,
  seedBallot,
} from './fixtures';
import {
  memberVotes,
  motionEligibility,
  ballots,
  lots,
} from '../../src/server/db/schema';
import { deriveAccess } from '../../src/server/authz/derive';
import { auditEvents } from '../../src/server/db/audit-schema';
import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { POST } from '../../src/pages/api/admin/roster-ownerships';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/auth-schema';
import {
  boardTerms,
  boardOfficeAssignments,
  accessGrants,
  parties,
  organizations,
  representations,
  ownerships,
} from '../../src/server/db/roster-schema';
import { fetchAdminRoster } from '../../src/server/roster/reads';
import { associationDateIso } from '../../src/lib/format';
import type { OwnershipTransferPreview } from '../../src/lib/ownership-transfer';
import { callerContext } from './caller-context';
import {
  req,
  truncateAll,
  seedProperty,
  seedLotAuthority,
  seedPerson,
} from './fixtures';

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () =>
    role === null ? null : callerContext('board', role, []),
}));
afterEach(() => vi.restoreAllMocks());
let role: 'board' | 'visitor' | null = 'board';
beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});
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
  'board_terms',
  'person_links',
  'person_verifications',
  'representation_lots',
  'representations',
  'contact_methods',
  'organizations',
];
beforeEach(async () => {
  role = 'board';
  await env.DATABASE.prepare('DELETE FROM cutover_settings').run();
  for (const table of CLEAR) {
    if (table === 'audit_events')
      await env.DATABASE.prepare(
        'DELETE FROM audit_events WHERE correlation_sequence > 0',
      ).run();
    await env.DATABASE.prepare(`DELETE FROM "${table}"`).run();
  }
  await getDb(env).update(parties).set({ consolidatedIntoPartyId: null });
  await truncateAll();
  await getDb(env)
    .insert(users)
    .values({
      id: 'board',
      name: 'Board operator',
      email: 'board@example.test',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  await seedPerson('operator');
  await seedAccountLink('board', 'operator');
  await getDb(env)
    .insert(accessGrants)
    .values({
      id: 'operator-grant',
      accountId: 'board',
      grantType: 'system_admin',
      startedAt: new Date('2025-01-01'),
      grantReason: 'technical_administration',
    });
  await seedProperty('lot');
  await seedLotAuthority('seller', 'lot', { startDay: '2025-01-01' });
  await seedPerson('buyer');
});
const url = 'http://localhost/api/admin/roster-ownerships';
const today = associationDateIso();
const input = {
  lotId: 'lot',
  departingOwnershipIds: ['seller-lot-own'],
  incomingPartyIds: ['buyer'],
  effectiveDay: today,
};
async function preview(
  value: Record<string, unknown> = input,
): Promise<OwnershipTransferPreview> {
  const response = await POST(
    req(url, 'POST', { action: 'previewTransfer', ...value }),
  );
  if (response.status !== 200) throw new Error(await response.text());
  return response.json();
}
it('previews without writing then transfers both sides while preserving another co-owner', async () => {
  await seedLotAuthority('co-owner', 'lot');
  await getDb(env)
    .update(lots)
    .set({ platLotNumber: '12' })
    .where(eq(lots.id, 'lot'));
  const before = await fetchAdminRoster(env, today);
  const review = await preview();
  expect(review.departing).toEqual([
    { id: 'seller', displayName: 'Person seller' },
  ]);
  expect(review.incoming).toEqual([
    { id: 'buyer', displayName: 'Person buyer' },
  ]);
  expect(review.retained).toEqual([
    { id: 'co-owner', displayName: 'Person co-owner' },
  ]);
  expect(await fetchAdminRoster(env, today)).toEqual(before);
  const result = await POST(
    req(url, 'POST', {
      action: 'transfer',
      ...input,
      previewToken: review.token,
    }),
  );
  expect(await result.text()).toContain('ownershipIds');
  expect(result.status).toBe(200);
  const after = await fetchAdminRoster(env, today);
  expect(after.lots.find((lot) => lot.id === 'lot')?.platLotNumber).toBe('12');
  expect(
    after.ownerships.find((row) => row.ownerPartyId === 'seller')?.endDay,
  ).toBe(today);
  expect(
    after.ownerships.find((row) => row.ownerPartyId === 'buyer')?.startDay,
  ).toBe(today);
  expect(
    after.ownerships.find((row) => row.ownerPartyId === 'co-owner'),
  ).toEqual(before.ownerships.find((row) => row.ownerPartyId === 'co-owner'));
});
it('rejects a stale preview without adding the incoming owner', async () => {
  const review = await preview();
  await getDb(env)
    .update(ownerships)
    .set({ endDay: today })
    .where(eq(ownerships.id, 'seller-lot-own'));
  const response = await POST(
    req(url, 'POST', {
      action: 'transfer',
      ...input,
      previewToken: review.token,
    }),
  );
  expect(response.status).toBe(409);
  expect(
    (await fetchAdminRoster(env, today)).ownerships.some(
      (row) => row.ownerPartyId === 'buyer',
    ),
  ).toBe(false);
});

async function commit(value: Record<string, unknown>, token: string) {
  return POST(
    req(url, 'POST', { action: 'transfer', ...value, previewToken: token }),
  );
}
async function account(id: string, personId: string) {
  await getDb(env)
    .insert(users)
    .values({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  await seedAccountLink(id, personId);
}
async function service() {
  const now = new Date();
  await getDb(env).insert(boardTerms).values({
    id: 'term',
    personId: 'seller',
    qualifyingLotId: 'lot',
    startDay: '2026-01-01',
    scheduledEndDay: '2099-01-01',
    createdAt: now,
    updatedAt: now,
  });
  await getDb(env).insert(boardOfficeAssignments).values({
    id: 'office',
    boardTermId: 'term',
    personId: 'seller',
    office: 'president',
    startDay: '2026-01-02',
    createdAt: now,
    updatedAt: now,
  });
  await getDb(env)
    .insert(accessGrants)
    .values({
      id: 'grant',
      accountId: 'board',
      grantType: 'board',
      qualifyingBoardTermId: 'term',
      startedAt: new Date('2026-01-02'),
      grantReason: 'board_service',
    });
}
it('reports Lot Authority loss separately from Member Access retained through another Lot', async () => {
  await account('seller-account', 'seller');
  await account('buyer-account', 'buyer');
  await seedProperty('other');
  await seedLotAuthority('seller', 'other');
  const review = await preview();
  expect(review.access).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        personId: 'seller',
        lotAuthority: 'lost',
        memberAccess: 'retained',
      }),
      expect.objectContaining({
        personId: 'buyer',
        lotAuthority: 'gained',
        memberAccess: 'gained',
      }),
    ]),
  );
  expect((await commit(input, review.token)).status).toBe(200);
  expect((await deriveAccess(env, 'seller-account', today)).lotIds).toEqual([
    'other',
  ]);
  expect((await deriveAccess(env, 'buyer-account', today)).lotIds).toEqual([
    'lot',
  ]);
  expect(
    await getDb(env).all('SELECT * FROM audit_integrity_violations_v'),
  ).toEqual([]);
});
it('ends the term, office, and Board Access when the departing owner loses qualification', async () => {
  await service();
  const review = await preview();
  expect(review.boardTerms).toEqual([
    expect.objectContaining({
      termId: 'term',
      action: 'end',
      offices: ['president'],
      boardGrantsEnding: 1,
    }),
  ]);
  expect((await commit(input, review.token)).status).toBe(200);
  expect((await getDb(env).select().from(boardTerms))[0].actualEndDay).toBe(
    today,
  );
  expect(
    (await getDb(env).select().from(boardOfficeAssignments))[0].endDay,
  ).toBe(today);
  expect(
    (
      await getDb(env)
        .select()
        .from(accessGrants)
        .where(eq(accessGrants.id, 'grant'))
    )[0].endedAt,
  ).not.toBeNull();
  expect(
    await getDb(env).all('SELECT * FROM audit_integrity_violations_v'),
  ).toEqual([]);
});
it('preserves service through an explicitly selected qualifying-Lot substitution', async () => {
  await service();
  await seedProperty('other');
  await seedLotAuthority('seller', 'other');
  const value = {
    ...input,
    substitutions: [{ termId: 'term', qualifyingLotId: 'other' }],
  };
  const review = await preview(value);
  expect(review.boardTerms[0]).toMatchObject({
    action: 'substitute',
    substituteLotId: 'other',
    boardGrantsEnding: 0,
  });
  expect((await commit(value, review.token)).status).toBe(200);
  expect((await getDb(env).select().from(boardTerms))[0]).toMatchObject({
    qualifyingLotId: 'other',
    actualEndDay: null,
  });
  expect(
    (
      await getDb(env)
        .select()
        .from(accessGrants)
        .where(eq(accessGrants.id, 'grant'))
    )[0].endedAt,
  ).toBeNull();
});
it('evaluates service against the final state when the departing owner represents an incoming organization', async () => {
  await service();
  const now = new Date();
  await getDb(env).insert(parties).values({
    id: 'org',
    kind: 'organization',
    createdAt: now,
    updatedAt: now,
  });
  await getDb(env).insert(organizations).values({
    partyId: 'org',
    partyKind: 'organization',
    legalName: 'Example Holdings',
    nameNormalized: 'example holdings',
    updatedAt: now,
  });
  await getDb(env).insert(representations).values({
    id: 'rep',
    representativePersonId: 'seller',
    organizationPartyId: 'org',
    scopeKind: 'organization',
    startDay: '2025-01-01',
    createdAt: now,
    updatedAt: now,
  });
  const value = { ...input, incomingPartyIds: ['org'] };
  const review = await preview(value);
  expect(review.authorityLost).toEqual([]);
  expect(review.boardTerms).toEqual([]);
  expect((await commit(value, review.token)).status).toBe(200);
  expect(
    (await getDb(env).select().from(boardTerms))[0].actualEndDay,
  ).toBeNull();
  expect(
    (
      await getDb(env)
        .select()
        .from(accessGrants)
        .where(eq(accessGrants.id, 'grant'))
    )[0].endedAt,
  ).toBeNull();
});
it('resets open member-motion votes once and preserves closed outcomes, turnout, and frozen weights', async () => {
  await seedMeeting('meeting');
  await seedMotion('open', 'meeting', { votingState: 'open', sequence: 1 });
  await seedMotion('closed', 'meeting', { votingState: 'closed', sequence: 2 });
  await getDb(env)
    .insert(motionEligibility)
    .values([
      { motionId: 'open', propertyId: 'lot', weight: 4 },
      { motionId: 'closed', propertyId: 'lot', weight: 4 },
    ]);
  await getDb(env)
    .insert(memberVotes)
    .values([
      {
        id: 'v-open',
        motionId: 'open',
        propertyId: 'lot',
        weight: 4,
        choice: 'yes',
      },
      {
        id: 'v-closed',
        motionId: 'closed',
        propertyId: 'lot',
        weight: 4,
        choice: 'no',
      },
    ]);
  await seedElection('e', { source: 'conducted' });
  await seedBallot('ballot', 'e', 'lot');
  const snapshots = await getDb(env).select().from(motionEligibility);
  const turnout = await getDb(env).select().from(ballots);
  const review = await preview();
  expect(review.resetMotionIds).toEqual(['open']);
  expect((await commit(input, review.token)).status).toBe(200);
  expect(
    (await getDb(env).select().from(memberVotes)).map((row) => row.id),
  ).toEqual(['v-closed']);
  expect(await getDb(env).select().from(motionEligibility)).toEqual(snapshots);
  expect(await getDb(env).select().from(ballots)).toEqual(turnout);
});
it('rolls back every transfer write when state changes after commit preflight', async () => {
  const review = await preview();
  const pause = pauseNextBatch();
  const response = commit(input, review.token);
  await pause.reached;
  await getDb(env)
    .update(lots)
    .set({ address: 'Changed synthetic address' })
    .where(eq(lots.id, 'lot'));
  pause.release();
  expect((await response).status).toBe(409);
  const rows = (await fetchAdminRoster(env, today)).ownerships;
  expect(rows).toHaveLength(1);
  expect(rows[0].endDay).toBeNull();
  expect(await getDb(env).select().from(auditEvents)).toEqual([]);
});
it.each([
  [
    'duplicate departure',
    { departingOwnershipIds: ['seller-lot-own', 'seller-lot-own'] },
    400,
  ],
  ['duplicate arrival', { incomingPartyIds: ['buyer', 'buyer'] }, 400],
  ['same owner', { incomingPartyIds: ['seller'] }, 400],
  ['future date', { effectiveDay: '2099-01-01' }, 400],
  ['empty interval', { effectiveDay: '2025-01-01' }, 400],
  ['missing owner', { incomingPartyIds: ['missing'] }, 404],
  ['missing Lot', { lotId: 'missing' }, 404],
] as const)('rejects %s without writing', async (_, overrides, status) => {
  const before = await fetchAdminRoster(env, today);
  const response = await POST(
    req(url, 'POST', { action: 'previewTransfer', ...input, ...overrides }),
  );
  expect(response.status).toBe(status);
  expect(await fetchAdminRoster(env, today)).toEqual(before);
});
it('requires a fresh preview after input edits and rejects a repeated successful commit', async () => {
  const review = await preview();
  expect(
    (await commit({ ...input, effectiveDay: '2026-01-10' }, review.token))
      .status,
  ).toBe(409);
  expect((await commit(input, review.token)).status).toBe(200);
  expect((await commit(input, review.token)).status).toBe(409);
  expect((await fetchAdminRoster(env, today)).ownerships).toHaveLength(2);
});
it.each([['previewTransfer'], ['transfer']])(
  'gates %s by board access and the write freeze',
  async (action) => {
    role = null;
    expect((await POST(req(url, 'POST', { action, ...input }))).status).toBe(
      401,
    );
    role = 'visitor';
    expect((await POST(req(url, 'POST', { action, ...input }))).status).toBe(
      403,
    );
    role = 'board';
    await env.DATABASE.prepare(
      "INSERT INTO cutover_settings (key,value,updated_at) VALUES ('write_freeze','on',1)",
    ).run();
    expect((await POST(req(url, 'POST', { action, ...input }))).status).toBe(
      503,
    );
  },
);

it('transfers multiple departing and incoming owners on a backdated effective day', async () => {
  await seedLotAuthority('second-seller', 'lot');
  await seedPerson('second-buyer');
  const value = {
    ...input,
    departingOwnershipIds: ['seller-lot-own', 'second-seller-lot-own'],
    incomingPartyIds: ['buyer', 'second-buyer'],
    effectiveDay: '2026-06-01',
  };
  const review = await preview(value);
  expect((await commit(value, review.token)).status).toBe(200);
  const rows = (await fetchAdminRoster(env, today)).ownerships;
  expect(rows.filter((row) => row.endDay === '2026-06-01')).toHaveLength(2);
  expect(
    rows.filter((row) => row.startDay === '2026-06-01' && row.current),
  ).toHaveLength(2);
  const events = await getDb(env).select().from(auditEvents);
  expect(new Set(events.map((event) => event.correlationId)).size).toBe(1);
  expect(
    events.filter((event) => event.eventKind === 'ownership_ended'),
  ).toHaveLength(2);
  expect(
    events.filter((event) => event.eventKind === 'ownership_created'),
  ).toHaveLength(2);
  expect(
    await getDb(env).all('SELECT * FROM audit_integrity_violations_v'),
  ).toEqual([]);
});
it('rejects an incoming owner whose earlier Ownership overlaps the effective day', async () => {
  await seedLotAuthority('buyer', 'lot', {
    startDay: '2025-01-01',
    endDay: '2026-07-01',
  });
  const response = await POST(
    req(url, 'POST', {
      action: 'previewTransfer',
      ...input,
      effectiveDay: '2026-06-01',
    }),
  );
  expect(response.status).toBe(409);
  expect(await response.text()).toContain('overlapping');
});
it('rejects retired Lots and consolidated incoming parties', async () => {
  await getDb(env)
    .update(lots)
    .set({ retiredAt: new Date(), retiredDay: today, status: 'inactive' })
    .where(eq(lots.id, 'lot'));
  expect(
    (await POST(req(url, 'POST', { action: 'previewTransfer', ...input })))
      .status,
  ).toBe(409);
  await getDb(env)
    .update(lots)
    .set({ retiredAt: null, retiredDay: null, status: 'active' })
    .where(eq(lots.id, 'lot'));
  await getDb(env)
    .update(parties)
    .set({ consolidatedIntoPartyId: 'seller' })
    .where(eq(parties.id, 'buyer'));
  const response = await POST(
    req(url, 'POST', { action: 'previewTransfer', ...input }),
  );
  expect(response.status).toBe(409);
  expect(await response.text()).toContain('consolidated');
});

it('rolls back ownerships, service, access, votes, and audit when a late audit write fails', async () => {
  await service();
  await seedMeeting('meeting');
  await seedMotion('open', 'meeting', { votingState: 'open', sequence: 1 });
  await getDb(env).insert(memberVotes).values({
    id: 'vote',
    motionId: 'open',
    propertyId: 'lot',
    weight: 1,
    choice: 'yes',
  });
  const beforeRoster = await fetchAdminRoster(env, today);
  const beforeGrants = await getDb(env).select().from(accessGrants);
  const beforeVotes = await getDb(env).select().from(memberVotes);
  const review = await preview();
  // Fail only after ownership, service, access, and voting changes have run.
  // Earlier audit statements in the same correlation must roll back too.
  await env.DATABASE.prepare(
    `CREATE TRIGGER fail_transfer_audit
    BEFORE INSERT ON audit_events
    WHEN NEW.event_kind = 'ownership_created'
      AND EXISTS (SELECT 1 FROM ownerships WHERE owner_party_id = 'buyer')
      AND EXISTS (SELECT 1 FROM board_terms WHERE id = 'term' AND actual_end_day IS NOT NULL)
      AND EXISTS (SELECT 1 FROM access_grants WHERE id = 'grant' AND ended_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM member_votes WHERE id = 'vote')
    BEGIN SELECT RAISE(ABORT, 'forced late transfer failure'); END`,
  ).run();
  try {
    await expect(commit(input, review.token)).rejects.toThrow(
      'forced late transfer failure',
    );
    expect(await fetchAdminRoster(env, today)).toEqual(beforeRoster);
    expect(await getDb(env).select().from(accessGrants)).toEqual(beforeGrants);
    expect(await getDb(env).select().from(memberVotes)).toEqual(beforeVotes);
    expect(await getDb(env).select().from(auditEvents)).toEqual([]);
    for (const table of [
      'roster_changes',
      'board_service_changes',
      'access_events',
      'review_flags',
    ]) {
      expect(
        (
          await env.DATABASE.prepare(
            `SELECT COUNT(*) AS count FROM ${table}`,
          ).first<{ count: number }>()
        )?.count,
      ).toBe(0);
    }
  } finally {
    await env.DATABASE.prepare('DROP TRIGGER fail_transfer_audit').run();
  }
});
