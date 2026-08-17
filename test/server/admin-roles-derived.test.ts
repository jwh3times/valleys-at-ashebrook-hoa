import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => legacyAuthContext('board-1', 'board', []),
}));

import { POST } from '../../src/pages/api/admin/roles';
import { getDb } from '../../src/server/db/client';
import { properties, users } from '../../src/server/db/schema';
import { cutoverSettings } from '../../src/server/db/cutover-schema';
import {
  accessGrants,
  boardServiceTerms,
  ownerships,
  parties,
  people,
  personLinks,
  personVerifications,
} from '../../src/server/db/roster-schema';
import { legacyAuthContext } from '../../src/server/authz/context';

/**
 * The board handoff under `cutover_mode = derived` (#221).
 *
 * The problem this closes: after the flip, `users.role` is a column nothing
 * reads for authorization, so the pre-#221 Promote/Demote buttons would have
 * appeared to work while changing nothing — a failure discovered only when
 * somebody could not sign in. Under `derived` the route writes what
 * authorization actually reads (an Access Grant, or its ending) and carries
 * the stored role along as a write-behind mirror in the same batch.
 */

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

/** Children before parents; audit consequences before their roots. */
const CLEAR = [
  'audit_scalar_changes',
  'audit_sensitive_field_changes',
  'board_service_change_subjects',
  'roster_change_subjects',
  'board_service_changes',
  'roster_changes',
  'access_events',
  'identity_events',
  'audit_events',
  'access_grants',
  'person_links',
  'person_verifications',
  'board_service_terms',
  'ownerships',
  'people',
  'parties',
];

beforeEach(async () => {
  const db = getDb(env);
  for (const table of CLEAR) {
    if (table === 'audit_events') {
      await db.run(
        sql.raw('DELETE FROM "audit_events" WHERE correlation_sequence > 0'),
      );
    }
    await db.run(sql.raw(`DELETE FROM "${table}"`));
  }
  await db.delete(properties);
  await db.delete(users);
  await db.delete(cutoverSettings);
  await db
    .insert(cutoverSettings)
    .values({ key: 'cutover_mode', value: 'derived', updatedAt: new Date() });
  for (const id of ['board-1', 'acct-1', 'acct-2']) {
    const now = new Date();
    await db.insert(users).values({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: true,
      role: id === 'board-1' ? 'board' : 'homeowner',
      createdAt: now,
      updatedAt: now,
    });
  }
});

async function seedPerson(id: string) {
  const now = new Date();
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

async function seedLink(accountId: string, personId: string) {
  const now = new Date();
  const db = getDb(env);
  await db.insert(personVerifications).values({
    id: `ver-${accountId}`,
    accountId,
    personId,
    method: 'manual',
    approverAccountId: 'board-1',
    reason: 'manual_board_decision',
    verifiedAt: now,
  });
  await db.insert(personLinks).values({
    id: `link-${accountId}`,
    accountId,
    personId,
    verificationId: `ver-${accountId}`,
    startedAt: now,
  });
}

async function seedTerm(
  id: string,
  personId: string,
  overrides: Partial<{ scheduledEndDay: string }> = {},
) {
  const now = new Date();
  await getDb(env)
    .insert(boardServiceTerms)
    .values({
      id,
      personId,
      qualifyingLotId: null,
      startDay: '2020-01-01',
      scheduledEndDay: overrides.scheduledEndDay ?? '2099-01-01',
      createdAt: now,
      updatedAt: now,
    });
}

/** A live Board grant, started well in the past so ending it today can never
 * trip the `ended_at > started_at` CHECK on a same-millisecond round trip. */
async function seedBoardGrant(id: string, accountId: string, termId: string) {
  await getDb(env)
    .insert(accessGrants)
    .values({
      id,
      accountId,
      grantType: 'board',
      qualifyingBoardTermId: termId,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      grantedByAccountId: 'board-1',
      grantReason: 'board_service',
    });
}

async function seedOwnedLot(lotId: string, personId: string) {
  const now = new Date();
  const db = getDb(env);
  await db.insert(properties).values({
    id: lotId,
    address: `${lotId} Ashebrook Lane`,
    addressNormalized: `${lotId} ashebrook lane`,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(ownerships).values({
    id: `own-${lotId}`,
    ownerPartyId: personId,
    lotId,
    startDay: '2020-01-01',
    createdAt: now,
    updatedAt: now,
  });
}

function post(body: unknown) {
  return POST({
    request: new Request('http://localhost/api/admin/roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never);
}

const roleOf = async (id: string) =>
  (await getDb(env).select().from(users).where(eq(users.id, id)))[0]?.role;

const grantsFor = async (accountId: string) =>
  getDb(env)
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.accountId, accountId));

describe('promote', () => {
  it('grants Board Access, records it, and mirrors the stored role', async () => {
    await seedPerson('per-1');
    await seedLink('acct-1', 'per-1');
    await seedTerm('term-1', 'per-1');

    const res = await post({
      action: 'promote',
      email: 'acct-1@example.test',
    });
    expect(res.status).toBe(204);

    const grants = await grantsFor('acct-1');
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      grantType: 'board',
      qualifyingBoardTermId: 'term-1',
      grantReason: 'board_service',
      grantedByAccountId: 'board-1',
      endedAt: null,
    });
    // The write-behind mirror rides in the same batch.
    expect(await roleOf('acct-1')).toBe('board');

    const db = getDb(env);
    const events = await db.all<{
      event_kind: string;
      requested_action: string;
      outcome: string;
      target_account_id: string;
    }>(
      sql`SELECT e.event_kind, a.requested_action, a.outcome, a.target_account_id
          FROM access_events a JOIN audit_events e ON e.id = a.event_id
          WHERE e.event_kind = 'grant_created'`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      requested_action: 'grant',
      outcome: 'allowed',
      target_account_id: 'acct-1',
    });
    expect(
      await db.all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);
  });

  it('404s an unknown email in either model', async () => {
    const res = await post({ action: 'promote', email: 'nobody@example.test' });
    expect(res.status).toBe(404);
  });

  it('names the missing Person Link and writes nothing', async () => {
    const res = await post({ action: 'promote', email: 'acct-1@example.test' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('not linked to a person');
    expect(await grantsFor('acct-1')).toHaveLength(0);
    // No partial state: the mirror never moves without the grant landing.
    expect(await roleOf('acct-1')).toBe('homeowner');
    expect(await getDb(env).all(sql`SELECT * FROM access_events`)).toHaveLength(
      0,
    );
  });

  it('names the missing Board Term and writes nothing', async () => {
    await seedPerson('per-1');
    await seedLink('acct-1', 'per-1');
    const res = await post({ action: 'promote', email: 'acct-1@example.test' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('no current or scheduled Board Term');
    expect(await grantsFor('acct-1')).toHaveLength(0);
    expect(await roleOf('acct-1')).toBe('homeowner');
  });

  it('does not count a lapsed term as qualifying', async () => {
    await seedPerson('per-1');
    await seedLink('acct-1', 'per-1');
    await seedTerm('term-old', 'per-1', { scheduledEndDay: '2020-06-01' });
    const res = await post({ action: 'promote', email: 'acct-1@example.test' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('no current or scheduled Board Term');
  });

  it('refuses a second promotion while the grant is live', async () => {
    await seedPerson('per-1');
    await seedLink('acct-1', 'per-1');
    await seedTerm('term-1', 'per-1');
    await seedBoardGrant('g-1', 'acct-1', 'term-1');
    const res = await post({ action: 'promote', email: 'acct-1@example.test' });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('This account already holds Board Access');
    expect(await grantsFor('acct-1')).toHaveLength(1);
  });
});

describe('demote', () => {
  async function seedBoardAccount(
    accountId: string,
    personId: string,
    grantId: string,
  ) {
    await seedPerson(personId);
    await seedLink(accountId, personId);
    await seedTerm(`term-${personId}`, personId);
    await seedBoardGrant(grantId, accountId, `term-${personId}`);
    await getDb(env)
      .update(users)
      .set({ role: 'board' })
      .where(eq(users.id, accountId));
  }

  it('ends the grant, records it, and mirrors visitor with no lot authority', async () => {
    await seedBoardAccount('acct-1', 'per-1', 'g-1');
    await seedBoardAccount('acct-2', 'per-2', 'g-2');

    const res = await post({ action: 'demote', userId: 'acct-2' });
    expect(res.status).toBe(204);

    const [grant] = await grantsFor('acct-2');
    expect(grant.endedAt).not.toBeNull();
    expect(grant.endReason).toBe('revoked');
    expect(grant.endedByAccountId).toBe('board-1');
    expect(await roleOf('acct-2')).toBe('visitor');
    // The other board member is untouched.
    expect((await grantsFor('acct-1'))[0].endedAt).toBeNull();

    const db = getDb(env);
    const events = await db.all<{ outcome: string; target_account_id: string }>(
      sql`SELECT a.outcome, a.target_account_id
          FROM access_events a JOIN audit_events e ON e.id = a.event_id
          WHERE e.event_kind = 'grant_revoked'`,
    );
    expect(events).toEqual([
      { outcome: 'allowed', target_account_id: 'acct-2' },
    ]);
    expect(
      await db.all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);
  });

  it('mirrors homeowner when the linked person keeps lot authority', async () => {
    await seedBoardAccount('acct-1', 'per-1', 'g-1');
    await seedBoardAccount('acct-2', 'per-2', 'g-2');
    await seedOwnedLot('lot-2', 'per-2');

    const res = await post({ action: 'demote', userId: 'acct-2' });
    expect(res.status).toBe(204);
    // Demotion stops board access; it must not strip member access too.
    expect(await roleOf('acct-2')).toBe('homeowner');
  });

  it('refuses to end the last account holding Board Access', async () => {
    await seedBoardAccount('acct-1', 'per-1', 'g-1');
    const res = await post({ action: 'demote', userId: 'acct-1' });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('Cannot demote the last board member');
    expect((await grantsFor('acct-1'))[0].endedAt).toBeNull();
    expect(await roleOf('acct-1')).toBe('board');
  });

  it('never empties the board when the final two demotions race', async () => {
    await seedBoardAccount('acct-1', 'per-1', 'g-1');
    await seedBoardAccount('acct-2', 'per-2', 'g-2');
    const [a, b] = await Promise.all([
      post({ action: 'demote', userId: 'acct-1' }),
      post({ action: 'demote', userId: 'acct-2' }),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([204, 409]);
    const live = await getDb(env).all<{ id: string }>(
      sql`SELECT id FROM access_grants WHERE grant_type = 'board' AND ended_at IS NULL`,
    );
    expect(live).toHaveLength(1);
  });

  it('refuses an account with a mirrored role but no grant, pointing at the roster', async () => {
    await seedBoardAccount('acct-1', 'per-1', 'g-1');
    // acct-2 looks board in the legacy column and holds nothing in the model
    // that answers — the exact state the mirror can drift into.
    await getDb(env)
      .update(users)
      .set({ role: 'board' })
      .where(eq(users.id, 'acct-2'));
    const res = await post({ action: 'demote', userId: 'acct-2' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('holds no Board Access to revoke');
    // Silently mirroring the role would have hidden the drift.
    expect(await roleOf('acct-2')).toBe('board');
  });
});
