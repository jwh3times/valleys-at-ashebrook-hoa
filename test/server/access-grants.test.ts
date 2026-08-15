import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/auth-schema';
import {
  parties,
  people,
  personVerifications,
  personLinks,
  boardServiceTerms,
  accessGrants,
} from '../../src/server/db/roster-schema';
import type { AuthContext } from '../../src/server/authz/guards';
import { pauseNextBatch } from './fixtures';
import { GET, POST } from '../../src/pages/api/admin/access-grants';

/**
 * #218's Access Grants route (#203): never implicit, asymmetric authority
 * (board may touch board grants, only a System Administrator touches
 * system_admin ones), the grant-to-link-to-term chain validated at the
 * mutation boundary, and the last-System-Administrator invariant living on
 * exactly this route — refusals recorded as denied Access Events.
 */

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () =>
    (await importActual<typeof import('../../src/server/authz/context')>())
      .legacyAuthContext('board-1', 'board', []),
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
  'access_events',
  'audit_events',
  'access_grants',
  'person_links',
  'person_verifications',
  'board_service_terms',
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
  await db.run(sql.raw('DELETE FROM users'));
  for (const id of ['board-1', 'acct-1', 'acct-2', 'sa-1', 'sa-2']) {
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

async function seedPerson(id: string) {
  const now = new Date();
  await getDb(env)
    .insert(parties)
    .values({ id, kind: 'person', createdAt: now, updatedAt: now });
  await getDb(env).insert(people).values({
    partyId: id,
    partyKind: 'person',
    fullName: `Person ${id}`,
    nameNormalized: `person ${id}`,
    updatedAt: now,
  });
}

async function seedLink(accountId: string, personId: string) {
  const now = new Date();
  await getDb(env).insert(personVerifications).values({
    id: `ver-${accountId}`,
    accountId,
    personId,
    method: 'manual',
    approverAccountId: 'board-1',
    reason: 'manual_board_decision',
    verifiedAt: now,
  });
  await getDb(env).insert(personLinks).values({
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
  await getDb(env).insert(boardServiceTerms).values({
    id,
    personId,
    qualifyingLotId: null,
    startDay: '2026-01-01',
    scheduledEndDay: overrides.scheduledEndDay ?? '2027-01-01',
    createdAt: now,
    updatedAt: now,
  });
}

async function seedSysAdminGrant(id: string, accountId: string) {
  await getDb(env).insert(accessGrants).values({
    id,
    accountId,
    grantType: 'system_admin',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    grantReason: 'technical_administration',
  });
}

function sysAdminCtx(userId = 'sa-1'): AuthContext {
  return {
    userId,
    personId: `person-${userId}`,
    capabilities: new Set([
      'systemAdmin',
      'board',
      'member',
      'redactionAuthorize',
      'redactionCleanup',
      'accessDenialDetail',
      'auditIntegrityViews',
    ]),
    lotIds: [],
    contentTier: 'board',
    hasCurrentBoardTerm: false,
    role: 'board',
    propertyIds: [],
  };
}

function req(body?: unknown, ctx?: AuthContext, method = 'POST'): never {
  return {
    request: new Request('http://localhost/api/admin/access-grants', {
      method,
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    ...(ctx ? { locals: { authContext: ctx } } : {}),
  } as never;
}

describe('grant', () => {
  it('walks the validation chain to a recorded board grant', async () => {
    const missingAccount = await POST(
      req({ action: 'grant', accountId: 'nobody', grantType: 'board', qualifyingBoardTermId: 't' }),
    );
    expect(missingAccount.status).toBe(404);

    const unlinked = await POST(
      req({ action: 'grant', accountId: 'acct-1', grantType: 'board', qualifyingBoardTermId: 't' }),
    );
    expect(unlinked.status).toBe(409);
    expect(await unlinked.text()).toBe('Account has no linked Person');

    await seedPerson('per-1');
    await seedLink('acct-1', 'per-1');
    const noTerm = await POST(
      req({ action: 'grant', accountId: 'acct-1', grantType: 'board', qualifyingBoardTermId: 't' }),
    );
    expect(noTerm.status).toBe(404);

    await seedTerm('term-lapsed', 'per-1', { scheduledEndDay: '2026-02-01' });
    const lapsed = await POST(
      req({
        action: 'grant',
        accountId: 'acct-1',
        grantType: 'board',
        qualifyingBoardTermId: 'term-lapsed',
      }),
    );
    expect(lapsed.status).toBe(409);
    expect(await lapsed.text()).toBe('Term no longer supports a grant');

    // A term belonging to a DIFFERENT person than the account's link.
    await seedPerson('per-2');
    await seedTerm('term-other', 'per-2');
    const mismatched = await POST(
      req({
        action: 'grant',
        accountId: 'acct-1',
        grantType: 'board',
        qualifyingBoardTermId: 'term-other',
      }),
    );
    expect(mismatched.status).toBe(409);
    expect(await mismatched.text()).toBe(
      "Account is not linked to the term's person",
    );

    await seedTerm('term-1', 'per-1');
    const granted = await POST(
      req({
        action: 'grant',
        accountId: 'acct-1',
        grantType: 'board',
        qualifyingBoardTermId: 'term-1',
      }),
    );
    expect(granted.status).toBe(201);

    const duplicate = await POST(
      req({
        action: 'grant',
        accountId: 'acct-1',
        grantType: 'board',
        qualifyingBoardTermId: 'term-1',
      }),
    );
    expect(duplicate.status).toBe(409);

    const db = getDb(env);
    const [event] = await db.all<{
      event_kind: string;
      requested_action: string;
      outcome: string;
      target_account_id: string;
    }>(
      sql`SELECT e.event_kind, a.requested_action, a.outcome, a.target_account_id
          FROM access_events a JOIN audit_events e ON e.id = a.event_id
          WHERE e.event_kind = 'grant_created'`,
    );
    expect(event).toMatchObject({
      requested_action: 'grant',
      outcome: 'allowed',
      target_account_id: 'acct-1',
    });
    expect(await db.all(sql`SELECT * FROM audit_integrity_violations_v`)).toEqual([]);
  });

  it('restricts system_admin grants to a System Administrator', async () => {
    await seedPerson('per-sa');
    await seedLink('sa-2', 'per-sa');

    const byBoard = await POST(
      req({ action: 'grant', accountId: 'sa-2', grantType: 'system_admin' }),
    );
    expect(byBoard.status).toBe(403);

    const bySysAdmin = await POST(
      req(
        { action: 'grant', accountId: 'sa-2', grantType: 'system_admin' },
        sysAdminCtx(),
      ),
    );
    expect(bySysAdmin.status).toBe(201);

    const db = getDb(env);
    const [grant] = await db
      .select()
      .from(accessGrants)
      .where(eq(accessGrants.accountId, 'sa-2'));
    expect(grant.grantType).toBe('system_admin');
    expect(grant.qualifyingBoardTermId).toBeNull();
    expect(grant.grantReason).toBe('technical_administration');
  });
});

describe('revoke', () => {
  it('lets a board caller revoke a board grant, their own included', async () => {
    await seedPerson('per-1');
    await seedLink('board-1', 'per-1');
    await seedTerm('term-1', 'per-1');
    const granted = await POST(
      req({
        action: 'grant',
        accountId: 'board-1',
        grantType: 'board',
        qualifyingBoardTermId: 'term-1',
      }),
    );
    const id = ((await granted.json()) as { id: string }).id;

    const revoked = await POST(req({ action: 'revoke', grantId: id }));
    expect(revoked.status).toBe(204);
    const db = getDb(env);
    const [grant] = await db
      .select()
      .from(accessGrants)
      .where(eq(accessGrants.id, id));
    expect(grant.endedAt).not.toBeNull();
    expect(grant.endReason).toBe('revoked');

    const again = await POST(req({ action: 'revoke', grantId: id }));
    expect(again.status).toBe(409);
  });

  it('never lets a board caller touch a system_admin grant', async () => {
    await seedSysAdminGrant('g-sa', 'sa-1');
    const res = await POST(req({ action: 'revoke', grantId: 'g-sa' }));
    expect(res.status).toBe(403);
  });

  it('refuses to revoke the last System Administrator and records the denial', async () => {
    await seedSysAdminGrant('g-sa', 'sa-1');
    const res = await POST(
      req({ action: 'revoke', grantId: 'g-sa' }, sysAdminCtx()),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toBe(
      'Cannot revoke the last System Administrator',
    );

    const db = getDb(env);
    const [grant] = await db
      .select()
      .from(accessGrants)
      .where(eq(accessGrants.id, 'g-sa'));
    expect(grant.endedAt).toBeNull();

    const denials = await db.all<{ requested_action: string; outcome: string }>(
      sql`SELECT a.requested_action, a.outcome
          FROM access_events a JOIN audit_events e ON e.id = a.event_id
          WHERE a.requested_action = 'last_administrator_change'`,
    );
    expect(denials).toHaveLength(1);
    expect(denials[0].outcome).toBe('denied');
    expect(await db.all(sql`SELECT * FROM audit_integrity_violations_v`)).toEqual([]);
  });

  it('with two administrators, one revocation succeeds and the next refuses', async () => {
    await seedSysAdminGrant('g-1', 'sa-1');
    await seedSysAdminGrant('g-2', 'sa-2');
    const first = await POST(
      req({ action: 'revoke', grantId: 'g-1' }, sysAdminCtx()),
    );
    expect(first.status).toBe(204);
    const second = await POST(
      req({ action: 'revoke', grantId: 'g-2' }, sysAdminCtx()),
    );
    expect(second.status).toBe(409);
  });

  it('holds the invariant under interleaving: concurrent revokes end at most one', async () => {
    await seedSysAdminGrant('g-1', 'sa-1');
    await seedSysAdminGrant('g-2', 'sa-2');
    const pause = pauseNextBatch();
    try {
      // A passes its pre-checks (g-2 is still live) and parks its batch.
      const a = POST(req({ action: 'revoke', grantId: 'g-1' }, sysAdminCtx()));
      await pause.reached;
      // B commits first, ending g-2 while g-1 is still live.
      const b = await POST(
        req({ action: 'revoke', grantId: 'g-2' }, sysAdminCtx('sa-2')),
      );
      expect(b.status).toBe(204);
      pause.release();
      // A's boundary re-check now finds no OTHER live administrator: refused.
      const aRes = await a;
      expect(aRes.status).toBe(409);
    } finally {
      pause.restore();
    }
    const db = getDb(env);
    const live = await db.all<{ id: string }>(
      sql`SELECT id FROM access_grants WHERE grant_type = 'system_admin' AND ended_at IS NULL`,
    );
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe('g-1');
  });
});

describe('GET', () => {
  it('lists grants with account emails', async () => {
    await seedSysAdminGrant('g-sa', 'sa-1');
    const res = await GET(req(undefined, undefined, 'GET'));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string; accountEmail: string; live: boolean }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'g-sa',
      accountEmail: 'sa-1@example.test',
      live: true,
    });
  });
});
