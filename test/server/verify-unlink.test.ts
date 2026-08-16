import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/auth-schema';
import { cutoverSettings } from '../../src/server/db/cutover-schema';
import {
  parties,
  people,
  personVerifications,
  personLinks,
  boardServiceTerms,
  accessGrants,
} from '../../src/server/db/roster-schema';
import { legacyAuthContext } from '../../src/server/authz/context';
import type { AuthContext } from '../../src/server/authz/guards';
import { POST } from '../../src/pages/api/verify/unlink';
import { POST as adminUnlinkPost } from '../../src/pages/api/admin/person-links';

/**
 * #219's always-available self-unlink (PLAN-3c D7): no officialMode/member
 * gate, just the write freeze and a session. Shares `endLinkStatements` and
 * the last-System-Administrator refusal with the board's admin unlink route
 * — both paths are exercised here.
 */

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => null,
}));

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
  'audit_events',
  'verification_review_requests',
  'access_grants',
  'person_links',
  'person_verifications',
  'board_service_terms',
  'people',
  'parties',
];

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(cutoverSettings);
  for (const table of CLEAR) {
    if (table === 'audit_events') {
      await db.run(
        sql.raw('DELETE FROM "audit_events" WHERE correlation_sequence > 0'),
      );
    }
    await db.run(sql.raw(`DELETE FROM "${table}"`));
  }
  await db.run(sql.raw('DELETE FROM users'));
  for (const id of ['acct-1', 'sa-1', 'sa-2']) {
    const now = new Date();
    await db.insert(users).values({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
  }
});

async function setFreeze(value: 'on' | 'off') {
  const db = getDb(env);
  await db.delete(cutoverSettings);
  await db
    .insert(cutoverSettings)
    .values({ key: 'write_freeze', value, updatedAt: new Date() });
}

async function seedPerson(id: string) {
  const now = new Date();
  await getDb(env)
    .insert(parties)
    .values({ id, kind: 'person', createdAt: now, updatedAt: now });
  await getDb(env)
    .insert(people)
    .values({
      partyId: id,
      partyKind: 'person',
      fullName: `Person ${id}`,
      nameNormalized: `person ${id}`,
      updatedAt: now,
    });
}

async function seedLink(accountId: string, personId: string) {
  const now = new Date();
  await getDb(env)
    .insert(personVerifications)
    .values({
      id: `ver-${accountId}`,
      accountId,
      personId,
      method: 'manual',
      approverAccountId: accountId,
      reason: 'manual_board_decision',
      verifiedAt: now,
    });
  await getDb(env)
    .insert(personLinks)
    .values({
      id: `link-${accountId}`,
      accountId,
      personId,
      verificationId: `ver-${accountId}`,
      startedAt: now,
    });
}

async function seedTerm(id: string, personId: string) {
  const now = new Date();
  await getDb(env).insert(boardServiceTerms).values({
    id,
    personId,
    qualifyingLotId: null,
    startDay: '2026-01-01',
    scheduledEndDay: '2027-01-01',
    createdAt: now,
    updatedAt: now,
  });
}

async function seedGrant(
  id: string,
  accountId: string,
  grantType: 'board' | 'system_admin',
  qualifyingBoardTermId: string | null = null,
) {
  await getDb(env)
    .insert(accessGrants)
    .values({
      id,
      accountId,
      grantType,
      qualifyingBoardTermId,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      grantReason:
        grantType === 'board' ? 'board_service' : 'technical_administration',
    });
}

function ctxFor(accountId: string): AuthContext {
  return legacyAuthContext(accountId, 'homeowner', []);
}

function req(accountId: string | undefined): never {
  return {
    request: new Request('http://localhost/api/verify/unlink', {
      method: 'POST',
    }),
    ...(accountId ? { locals: { authContext: ctxFor(accountId) } } : {}),
  } as never;
}

describe('self-unlink', () => {
  it("ends the caller's own link and every current grant (204)", async () => {
    await seedPerson('per-1');
    await seedLink('acct-1', 'per-1');
    await seedTerm('term-1', 'per-1');
    await seedGrant('g-board', 'acct-1', 'board', 'term-1');

    const res = await POST(req('acct-1'));
    expect(res.status).toBe(204);

    const db = getDb(env);
    const [link] = await db
      .select()
      .from(personLinks)
      .where(eq(personLinks.id, 'link-acct-1'));
    expect(link.endedAt).not.toBeNull();
    expect(link.endReason).toBe('self_unlink');
    expect(link.endedByAccountId).toBe('acct-1');

    const [grant] = await db
      .select()
      .from(accessGrants)
      .where(eq(accessGrants.id, 'g-board'));
    expect(grant.endedAt).not.toBeNull();
    expect(grant.endReason).toBe('person_link_ended');

    expect(
      await db.all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);
  });

  it('401s an anonymous caller', async () => {
    const res = await POST(req(undefined));
    expect(res.status).toBe(401);
  });

  it('409s when the caller has no current link', async () => {
    const res = await POST(req('acct-1'));
    expect(res.status).toBe(409);
    expect(await res.text()).toBe('No linked person');
  });

  it('refuses to unlink the last System Administrator, recording a denial', async () => {
    await seedPerson('per-1');
    await seedLink('sa-1', 'per-1');
    await seedGrant('g-sa', 'sa-1', 'system_admin');

    const res = await POST(req('sa-1'));
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(
      'Cannot unlink the last System Administrator',
    );

    const db = getDb(env);
    const [link] = await db
      .select()
      .from(personLinks)
      .where(eq(personLinks.id, 'link-sa-1'));
    expect(link.endedAt).toBeNull();
    const [grant] = await db
      .select()
      .from(accessGrants)
      .where(eq(accessGrants.id, 'g-sa'));
    expect(grant.endedAt).toBeNull();

    const denials = await db.all<{
      outcome: string;
      target_account_id: string;
    }>(
      sql`SELECT a.outcome, a.target_account_id FROM access_events a
          JOIN audit_events e ON e.id = a.event_id
          WHERE a.requested_action = 'last_administrator_change'`,
    );
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({
      outcome: 'denied',
      target_account_id: 'sa-1',
    });
  });

  it('lets a NON-last System Administrator self-unlink, ending only their own grant', async () => {
    await seedPerson('per-1');
    await seedPerson('per-2');
    await seedLink('sa-1', 'per-1');
    await seedLink('sa-2', 'per-2');
    await seedGrant('g-sa-1', 'sa-1', 'system_admin');
    await seedGrant('g-sa-2', 'sa-2', 'system_admin');

    const res = await POST(req('sa-1'));
    expect(res.status).toBe(204);

    const db = getDb(env);
    const [g1] = await db
      .select()
      .from(accessGrants)
      .where(eq(accessGrants.id, 'g-sa-1'));
    expect(g1.endedAt).not.toBeNull();
    const [g2] = await db
      .select()
      .from(accessGrants)
      .where(eq(accessGrants.id, 'g-sa-2'));
    expect(g2.endedAt).toBeNull();
  });

  it('503s while the site is frozen', async () => {
    await setFreeze('on');
    await seedPerson('per-1');
    await seedLink('acct-1', 'per-1');
    const res = await POST(req('acct-1'));
    expect(res.status).toBe(503);
  });
});

describe('the admin unlink path also refuses the last System Administrator', () => {
  function adminReq(body: unknown): never {
    return {
      request: new Request('http://localhost/api/admin/person-links', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      locals: { authContext: legacyAuthContext('board-1', 'board', []) },
    } as never;
  }

  it('refuses and records a denial identically to self-unlink', async () => {
    await getDb(env).insert(users).values({
      id: 'board-1',
      name: 'board-1',
      email: 'board-1@example.test',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await seedPerson('per-1');
    await seedLink('sa-1', 'per-1');
    await seedGrant('g-sa', 'sa-1', 'system_admin');

    const res = await adminUnlinkPost(
      adminReq({
        action: 'unlink',
        linkId: 'link-sa-1',
        endReason: 'recorded_in_error',
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(
      'Cannot unlink the last System Administrator',
    );

    const db = getDb(env);
    const [link] = await db
      .select()
      .from(personLinks)
      .where(eq(personLinks.id, 'link-sa-1'));
    expect(link.endedAt).toBeNull();

    const denials = await db.all<{ outcome: string }>(
      sql`SELECT a.outcome FROM access_events a
          JOIN audit_events e ON e.id = a.event_id
          WHERE a.requested_action = 'last_administrator_change'`,
    );
    expect(denials).toHaveLength(1);
    expect(denials[0].outcome).toBe('denied');
  });
});
