import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => legacyAuthContext('board-1', 'board', []),
}));

import { POST } from '../../src/pages/api/admin/members';
import { getDb } from '../../src/server/db/client';
import {
  manualApprovalQueue,
  properties,
  userPropertyLinks,
  users,
} from '../../src/server/db/schema';
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
 * The Members surface re-pointed on the cutover flag (#221).
 *
 * `revoke` is the mode-branched action: under `legacy` it writes the stored
 * role and property links exactly as it always has; under `derived` the thing
 * revoked is the account's Person Link — ended together with every Access
 * Grant it supports, through the shared identity machinery — with the legacy
 * role and links carried along as write-behind mirrors in the same batch.
 *
 * `approve` and `deny` are deliberately NOT branched: they act only on the
 * old manual approval queue, write-dead since v0.10.0, whose remaining rows
 * are pre-v0.10.0 leftovers that must stay actionable.
 */

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

async function setMode(value: 'legacy' | 'derived') {
  const db = getDb(env);
  await db.delete(cutoverSettings);
  await db
    .insert(cutoverSettings)
    .values({ key: 'cutover_mode', value, updatedAt: new Date() });
}

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
  await db.delete(manualApprovalQueue);
  await db.delete(userPropertyLinks);
  await db.delete(properties);
  await db.delete(users);
  await setMode('legacy');
  for (const id of ['board-1', 'acct-1']) {
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

async function seedLot(id: string) {
  const now = new Date();
  await getDb(env)
    .insert(properties)
    .values({
      id,
      address: `${id} Ashebrook Lane`,
      addressNormalized: `${id} ashebrook lane`,
      createdAt: now,
      updatedAt: now,
    });
}

async function seedLegacyLink(accountId: string, lotId: string) {
  await getDb(env)
    .insert(userPropertyLinks)
    .values({
      id: `upl-${accountId}-${lotId}`,
      userId: accountId,
      propertyId: lotId,
      verifiedAt: new Date(),
      method: 'otp_email',
    });
}

async function seedPersonLink(accountId: string, personId: string) {
  const now = new Date();
  const db = getDb(env);
  await db
    .insert(parties)
    .values({ id: personId, kind: 'person', createdAt: now, updatedAt: now });
  await db.insert(people).values({
    partyId: personId,
    partyKind: 'person',
    fullName: `Person ${personId}`,
    nameNormalized: `person ${personId}`,
    updatedAt: now,
  });
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

async function seedOwnership(personId: string, lotId: string) {
  const now = new Date();
  await getDb(env)
    .insert(ownerships)
    .values({
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
    request: new Request('http://localhost/api/admin/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never);
}

const roleOf = async (id: string) =>
  (await getDb(env).select().from(users).where(eq(users.id, id)))[0]?.role;

describe('revoke under legacy', () => {
  it('clears the stored role and the property links', async () => {
    await seedLot('lot-1');
    await seedLegacyLink('acct-1', 'lot-1');
    const res = await post({ action: 'revoke', userId: 'acct-1' });
    expect(res.status).toBe(204);
    expect(await roleOf('acct-1')).toBe('visitor');
    expect(
      await getDb(env)
        .select()
        .from(userPropertyLinks)
        .where(eq(userPropertyLinks.userId, 'acct-1')),
    ).toHaveLength(0);
    // Nothing in the new model is touched before the flip.
    expect(await getDb(env).all(sql`SELECT * FROM audit_events`)).toHaveLength(
      0,
    );
  });

  it('refuses a board member and points at the board surface', async () => {
    await getDb(env)
      .update(users)
      .set({ role: 'board' })
      .where(eq(users.id, 'acct-1'));
    const res = await post({ action: 'revoke', userId: 'acct-1' });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(
      'Cannot demote a board member here; use Board members.',
    );
    expect(await roleOf('acct-1')).toBe('board');
  });
});

describe('revoke under derived', () => {
  it('ends the Person Link, records it, and mirrors role and links', async () => {
    await setMode('derived');
    await seedLot('lot-1');
    await seedLegacyLink('acct-1', 'lot-1');
    await seedPersonLink('acct-1', 'per-1');
    await seedOwnership('per-1', 'lot-1');

    const res = await post({ action: 'revoke', userId: 'acct-1' });
    expect(res.status).toBe(204);

    const db = getDb(env);
    const [link] = await db
      .select()
      .from(personLinks)
      .where(eq(personLinks.id, 'link-acct-1'));
    expect(link.endedAt).not.toBeNull();
    expect(link.endReason).toBe('no_longer_qualifies');
    expect(link.endedByAccountId).toBe('board-1');

    // Write-behind mirrors, in the same batch.
    expect(await roleOf('acct-1')).toBe('visitor');
    expect(
      await db
        .select()
        .from(userPropertyLinks)
        .where(eq(userPropertyLinks.userId, 'acct-1')),
    ).toHaveLength(0);

    const events = await db.all<{ reason_code: string; kind: string }>(
      sql`SELECT i.reason_code, e.event_kind AS kind
          FROM identity_events i JOIN audit_events e ON e.id = i.event_id`,
    );
    expect(events).toEqual([
      { reason_code: 'no_longer_qualifies', kind: 'person_link_ended' },
    ]);
    expect(
      await db.all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);
  });

  it('ends the Access Grants the link supported', async () => {
    await setMode('derived');
    await seedPersonLink('acct-1', 'per-1');
    await getDb(env)
      .insert(accessGrants)
      .values({
        id: 'g-sa',
        accountId: 'acct-1',
        grantType: 'system_admin',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        grantedByAccountId: 'board-1',
        grantReason: 'technical_administration',
      });
    // A second administrator, so the last-administrator refusal is not what
    // this case is testing.
    await getDb(env)
      .insert(accessGrants)
      .values({
        id: 'g-sa-2',
        accountId: 'board-1',
        grantType: 'system_admin',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        grantedByAccountId: 'board-1',
        grantReason: 'technical_administration',
      });

    const res = await post({ action: 'revoke', userId: 'acct-1' });
    expect(res.status).toBe(204);
    const [grant] = await getDb(env)
      .select()
      .from(accessGrants)
      .where(eq(accessGrants.id, 'g-sa'));
    expect(grant.endedAt).not.toBeNull();
    expect(grant.endReason).toBe('person_link_ended');
  });

  it('refuses when it would strip the last System Administrator', async () => {
    await setMode('derived');
    await seedPersonLink('acct-1', 'per-1');
    await getDb(env)
      .insert(accessGrants)
      .values({
        id: 'g-sa',
        accountId: 'acct-1',
        grantType: 'system_admin',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        grantedByAccountId: 'board-1',
        grantReason: 'technical_administration',
      });
    const res = await post({ action: 'revoke', userId: 'acct-1' });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(
      'Cannot revoke the last System Administrator',
    );
    const [link] = await getDb(env)
      .select()
      .from(personLinks)
      .where(eq(personLinks.id, 'link-acct-1'));
    expect(link.endedAt).toBeNull();
  });

  it('refuses an account holding Board Access, whatever the stored role says', async () => {
    await setMode('derived');
    await seedPersonLink('acct-1', 'per-1');
    const now = new Date();
    await getDb(env).insert(boardServiceTerms).values({
      id: 'term-1',
      personId: 'per-1',
      qualifyingLotId: null,
      startDay: '2020-01-01',
      scheduledEndDay: '2099-01-01',
      createdAt: now,
      updatedAt: now,
    });
    await getDb(env)
      .insert(accessGrants)
      .values({
        id: 'g-board',
        accountId: 'acct-1',
        grantType: 'board',
        qualifyingBoardTermId: 'term-1',
        startedAt: new Date('2026-01-01T00:00:00Z'),
        grantedByAccountId: 'board-1',
        grantReason: 'board_service',
      });
    // The stored role still says homeowner — the refusal must come from the
    // model that answers, not from the mirror.
    const res = await post({ action: 'revoke', userId: 'acct-1' });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(
      'Cannot demote a board member here; use Board members.',
    );
    const [link] = await getDb(env)
      .select()
      .from(personLinks)
      .where(eq(personLinks.id, 'link-acct-1'));
    expect(link.endedAt).toBeNull();
  });

  it('refuses an unlinked account rather than silently mirroring', async () => {
    await setMode('derived');
    await seedLot('lot-1');
    await seedLegacyLink('acct-1', 'lot-1');
    const res = await post({ action: 'revoke', userId: 'acct-1' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('not linked to a person');
    expect(await roleOf('acct-1')).toBe('homeowner');
    expect(
      await getDb(env)
        .select()
        .from(userPropertyLinks)
        .where(eq(userPropertyLinks.userId, 'acct-1')),
    ).toHaveLength(1);
  });

  it('still refuses a stored board member', async () => {
    await setMode('derived');
    await getDb(env)
      .update(users)
      .set({ role: 'board' })
      .where(eq(users.id, 'acct-1'));
    const res = await post({ action: 'revoke', userId: 'acct-1' });
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(
      'Cannot demote a board member here; use Board members.',
    );
  });
});

describe('the leftover manual approval queue', () => {
  async function seedQueueRow() {
    await getDb(env).insert(manualApprovalQueue).values({
      id: 'q-1',
      userId: 'acct-1',
      claimedAddress: '1 Ashebrook Lane',
      reason: 'address_not_found',
      status: 'pending',
      createdAt: new Date(),
    });
  }

  it('approves a pre-v0.10.0 leftover in either mode', async () => {
    for (const mode of ['legacy', 'derived'] as const) {
      await getDb(env).delete(manualApprovalQueue);
      await getDb(env).delete(userPropertyLinks);
      await getDb(env).delete(properties);
      await getDb(env)
        .update(users)
        .set({ role: 'visitor' })
        .where(eq(users.id, 'acct-1'));
      await setMode(mode);
      await seedLot('lot-1');
      await seedQueueRow();

      const res = await post({
        action: 'approve',
        queueId: 'q-1',
        propertyId: 'lot-1',
      });
      expect(res.status).toBe(204);
      expect(await roleOf('acct-1')).toBe('homeowner');
      const [row] = await getDb(env)
        .select()
        .from(manualApprovalQueue)
        .where(eq(manualApprovalQueue.id, 'q-1'));
      expect(row.status).toBe('approved');
    }
  });

  it('denies a pre-v0.10.0 leftover in either mode', async () => {
    for (const mode of ['legacy', 'derived'] as const) {
      await getDb(env).delete(manualApprovalQueue);
      await setMode(mode);
      await seedQueueRow();
      const res = await post({ action: 'deny', queueId: 'q-1' });
      expect(res.status).toBe(204);
      const [row] = await getDb(env)
        .select()
        .from(manualApprovalQueue)
        .where(eq(manualApprovalQueue.id, 'q-1'));
      expect(row.status).toBe('denied');
    }
  });
});
