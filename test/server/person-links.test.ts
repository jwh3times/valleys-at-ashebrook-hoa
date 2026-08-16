import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { getDb } from '../../src/server/db/client';
import { users } from '../../src/server/db/auth-schema';
import {
  parties,
  people,
  organizations,
  personVerifications,
  personLinks,
  boardServiceTerms,
  accessGrants,
} from '../../src/server/db/roster-schema';
import { pauseNextBatch } from './fixtures';
import { GET, POST } from '../../src/pages/api/admin/person-links';

/**
 * #219's Person Link surface (PLAN-3c D7): manual verification links an
 * EXISTING Person to an account (never creates one), and unlink ends a link
 * and every Access Grant it currently supports in one batch.
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
  'organizations',
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
  for (const id of ['board-1', 'acct-1', 'acct-2', 'sa-1']) {
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

async function seedOrganization(id: string) {
  const now = new Date();
  await getDb(env)
    .insert(parties)
    .values({ id, kind: 'organization', createdAt: now, updatedAt: now });
  await getDb(env)
    .insert(organizations)
    .values({
      partyId: id,
      partyKind: 'organization',
      legalName: `Org ${id}`,
      nameNormalized: `org ${id}`,
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
      approverAccountId: 'board-1',
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

function req(body: unknown, method = 'POST'): never {
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return {
    request: new Request('http://localhost/api/admin/person-links', init),
  } as never;
}

const goodEvidence = { kind: 'operator_observation' };

describe('manualVerify', () => {
  it('walks the validation chain to a recorded verification and link', async () => {
    const missingPerson = await POST(
      req({
        action: 'manualVerify',
        accountId: 'acct-1',
        personId: 'nobody',
        reason: 'manual_board_decision',
        evidence: goodEvidence,
      }),
    );
    expect(missingPerson.status).toBe(404);

    await seedPerson('per-1');
    const res = await POST(
      req({
        action: 'manualVerify',
        accountId: 'acct-1',
        personId: 'per-1',
        reason: 'manual_board_decision',
        evidence: goodEvidence,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; verificationId: string };

    const db = getDb(env);
    const [link] = await db
      .select()
      .from(personLinks)
      .where(eq(personLinks.id, body.id));
    expect(link.accountId).toBe('acct-1');
    expect(link.personId).toBe('per-1');

    const events = await db.all<{
      event_kind: string;
      reason_code: string;
      person_id: string;
      target_account_id: string;
      evidence_kind: string;
    }>(
      sql`SELECT e.event_kind, ie.reason_code, ie.person_id, ie.target_account_id, ie.evidence_kind
          FROM identity_events ie JOIN audit_events e ON e.id = ie.event_id
          WHERE e.event_kind = 'person_verified'`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason_code: 'manual_board_decision',
      person_id: 'per-1',
      target_account_id: 'acct-1',
      evidence_kind: 'operator_observation',
    });

    expect(
      await db.all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);
  });

  it('refuses an Organization', async () => {
    await seedOrganization('org-1');
    const res = await POST(
      req({
        action: 'manualVerify',
        accountId: 'acct-1',
        personId: 'org-1',
        reason: 'manual_board_decision',
        evidence: goodEvidence,
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Organization');
  });

  it('refuses a consolidated Person', async () => {
    await seedPerson('per-1');
    await seedPerson('per-2');
    await getDb(env)
      .update(parties)
      .set({ consolidatedIntoPartyId: 'per-2' })
      .where(eq(parties.id, 'per-1'));
    const res = await POST(
      req({
        action: 'manualVerify',
        accountId: 'acct-1',
        personId: 'per-1',
        reason: 'manual_board_decision',
        evidence: goodEvidence,
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('consolidated');
  });

  it('refuses a Person already linked to another account', async () => {
    await seedPerson('per-1');
    await seedLink('acct-1', 'per-1');
    const res = await POST(
      req({
        action: 'manualVerify',
        accountId: 'acct-2',
        personId: 'per-1',
        reason: 'manual_board_decision',
        evidence: goodEvidence,
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('already linked to an account');
  });

  it('refuses an account already linked', async () => {
    await seedPerson('per-1');
    await seedPerson('per-2');
    await seedLink('acct-1', 'per-1');
    const res = await POST(
      req({
        action: 'manualVerify',
        accountId: 'acct-1',
        personId: 'per-2',
        reason: 'manual_board_decision',
        evidence: goodEvidence,
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('This account is already linked');
  });

  it('holds the invariant under interleaving: a concurrent link creation loses cleanly', async () => {
    await seedPerson('per-1');
    const pause = pauseNextBatch();
    try {
      const a = POST(
        req({
          action: 'manualVerify',
          accountId: 'acct-1',
          personId: 'per-1',
          reason: 'manual_board_decision',
          evidence: goodEvidence,
        }),
      );
      await pause.reached;
      const b = await POST(
        req({
          action: 'manualVerify',
          accountId: 'acct-2',
          personId: 'per-1',
          reason: 'manual_board_decision',
          evidence: goodEvidence,
        }),
      );
      expect(b.status).toBe(201);
      pause.release();
      const aRes = await a;
      expect(aRes.status).toBe(409);
    } finally {
      pause.restore();
    }
    const db = getDb(env);
    const links = await db.select().from(personLinks);
    expect(links).toHaveLength(1);
    expect(links[0].accountId).toBe('acct-2');
    const verifications = await db.select().from(personVerifications);
    expect(verifications).toHaveLength(1);
  });
});

describe('unlink', () => {
  it('ends the link and every current grant in one batch', async () => {
    await seedPerson('per-1');
    await seedLink('acct-1', 'per-1');
    await seedTerm('term-1', 'per-1');
    await seedGrant('g-board', 'acct-1', 'board', 'term-1');
    await seedGrant('g-sa', 'acct-1', 'system_admin');
    // Another live System Administrator so this unlink is not the last one.
    await seedGrant('g-sa-other', 'sa-1', 'system_admin');

    const res = await POST(
      req({
        action: 'unlink',
        linkId: 'link-acct-1',
        endReason: 'recorded_in_error',
      }),
    );
    expect(res.status).toBe(204);

    const db = getDb(env);
    const [link] = await db
      .select()
      .from(personLinks)
      .where(eq(personLinks.id, 'link-acct-1'));
    expect(link.endedAt).not.toBeNull();
    expect(link.endReason).toBe('recorded_in_error');

    const grants = await db
      .select()
      .from(accessGrants)
      .where(eq(accessGrants.accountId, 'acct-1'));
    expect(grants).toHaveLength(2);
    for (const g of grants) {
      expect(g.endedAt).not.toBeNull();
      expect(g.endReason).toBe('person_link_ended');
    }

    const identityRoot = await db.all<{ event_kind: string }>(
      sql`SELECT e.event_kind FROM identity_events ie
          JOIN audit_events e ON e.id = ie.event_id
          WHERE e.event_kind = 'person_link_ended'`,
    );
    expect(identityRoot).toHaveLength(1);

    const caused = await db.all<{ requested_action: string; outcome: string }>(
      sql`SELECT a.requested_action, a.outcome FROM access_events a
          JOIN audit_events e ON e.id = a.event_id
          WHERE e.event_kind = 'grant_revoked' AND e.automatic_cause = 'person_link_ended'`,
    );
    expect(caused).toHaveLength(2);
    for (const c of caused) {
      expect(c.requested_action).toBe('revoke');
      expect(c.outcome).toBe('allowed');
    }

    expect(
      await db.all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);
  });

  it('refuses to unlink the last System Administrator', async () => {
    await seedPerson('per-1');
    await seedLink('sa-1', 'per-1');
    await seedGrant('g-sa', 'sa-1', 'system_admin');

    const res = await POST(
      req({
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
    const [grant] = await db
      .select()
      .from(accessGrants)
      .where(eq(accessGrants.id, 'g-sa'));
    expect(grant.endedAt).toBeNull();

    const denials = await db.all<{ outcome: string }>(
      sql`SELECT a.outcome FROM access_events a
          JOIN audit_events e ON e.id = a.event_id
          WHERE a.requested_action = 'last_administrator_change'`,
    );
    expect(denials).toHaveLength(1);
    expect(denials[0].outcome).toBe('denied');
  });

  it('refuses an already-ended link', async () => {
    await seedPerson('per-1');
    await seedLink('acct-1', 'per-1');
    const first = await POST(
      req({
        action: 'unlink',
        linkId: 'link-acct-1',
        endReason: 'recorded_in_error',
      }),
    );
    expect(first.status).toBe(204);
    const again = await POST(
      req({
        action: 'unlink',
        linkId: 'link-acct-1',
        endReason: 'recorded_in_error',
      }),
    );
    expect(again.status).toBe(409);
  });

  it('rejects self_unlink as an admin end reason', async () => {
    await seedPerson('per-1');
    await seedLink('acct-1', 'per-1');
    const res = await POST(
      req({
        action: 'unlink',
        linkId: 'link-acct-1',
        endReason: 'self_unlink',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('404s an unknown link', async () => {
    const res = await POST(
      req({
        action: 'unlink',
        linkId: 'nope',
        endReason: 'recorded_in_error',
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe('GET', () => {
  it('lists links with account and person display data', async () => {
    await seedPerson('per-1');
    await seedLink('acct-1', 'per-1');
    const res = await GET(req(undefined, 'GET'));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as {
      id: string;
      accountEmail: string;
      personDisplayName: string;
      current: boolean;
      verification: { method: string; reason: string };
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'link-acct-1',
      accountEmail: 'acct-1@example.test',
      personDisplayName: 'Person per-1',
      current: true,
      verification: { method: 'manual', reason: 'manual_board_decision' },
    });
  });
});
