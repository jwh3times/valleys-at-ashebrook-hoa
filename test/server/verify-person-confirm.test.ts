import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { sql, eq, and, isNull } from 'drizzle-orm';

// The later-acquired-lot test drives the real `getAuthContext` seam; only
// the session is synthesized, matching access-revalidation.test.ts's pattern.
let sessionUserId: string | null = null;
vi.mock('../../src/server/auth', () => ({
  createAuth: () => ({
    api: {
      getSession: async () =>
        sessionUserId
          ? { user: { id: sessionUserId, role: 'homeowner' } }
          : null,
    },
  }),
}));

import { getDb } from '../../src/server/db/client';
import {
  verificationCodes,
  personVerifications,
  personLinks,
  contactMethods,
} from '../../src/server/db/roster-schema';
import { auditEvents } from '../../src/server/db/audit-schema';
import { userPropertyLinks, users } from '../../src/server/db/schema';
import { cutoverSettings } from '../../src/server/db/cutover-schema';
import { hashCode, MAX_ATTEMPTS } from '../../src/server/verification/codes';
import { confirmPersonVerification } from '../../src/server/roster/verification';
import { getAuthContext } from '../../src/server/authz/context';
import { seedRoster } from './dual-fixtures';

const DAY = '2026-06-15';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

async function clearAll() {
  const db = getDb(env);
  await db.run(sql.raw('DELETE FROM "audit_scalar_changes"'));
  await db.run(sql.raw('DELETE FROM "audit_sensitive_field_changes"'));
  await db.run(sql.raw('DELETE FROM "identity_events"'));
  await db.run(sql.raw('DELETE FROM "access_events"'));
  await db.run(
    sql.raw('DELETE FROM "audit_events" WHERE correlation_sequence > 0'),
  );
  await db.run(sql.raw('DELETE FROM "audit_events"'));
  await db.run(sql.raw('DELETE FROM "verification_codes"'));
  await db.run(sql.raw('DELETE FROM "verification_review_requests"'));
  await db.run(sql.raw('DELETE FROM "person_links"'));
  await db.run(sql.raw('DELETE FROM "person_verifications"'));
  await db.run(sql.raw('DELETE FROM "contact_methods"'));
  await db.run(sql.raw('DELETE FROM "ownerships"'));
  await db.run(sql.raw('DELETE FROM "people"'));
  await db.run(sql.raw('DELETE FROM "organizations"'));
  await db.run(sql.raw('DELETE FROM "parties"'));
  await db.run(sql.raw('DELETE FROM "property_verifications"'));
  await db.run(sql.raw('DELETE FROM "user_property_links"'));
  await db.run(sql.raw('DELETE FROM "manual_approval_queue"'));
  await db.run(sql.raw('DELETE FROM "owners"'));
  await db.run(sql.raw('DELETE FROM "properties"'));
  await db.run(sql.raw('DELETE FROM "users"'));
  await db.delete(cutoverSettings);
}

beforeEach(async () => {
  sessionUserId = null;
  await clearAll();
});

async function seedAccount(
  id: string,
  role: 'visitor' | 'homeowner' = 'visitor',
) {
  await getDb(env).run(
    sql`INSERT INTO users (id, name, email, email_verified, role, created_at, updated_at)
        VALUES (${id}, ${id}, ${`${id}@example.test`}, 0, ${role}, 1, 1)`,
  );
}

async function seedCode(opts: {
  id?: string;
  accountId: string;
  personId: string;
  contactMethodId: string;
  lotId: string;
  channel: 'email' | 'sms';
  code: string;
  attempts?: number;
  expiresAt?: Date;
}): Promise<string> {
  const id = opts.id ?? crypto.randomUUID();
  await getDb(env)
    .insert(verificationCodes)
    .values({
      id,
      accountId: opts.accountId,
      personId: opts.personId,
      contactMethodId: opts.contactMethodId,
      lotId: opts.lotId,
      channel: opts.channel,
      codeHash: await hashCode(opts.code, env.BETTER_AUTH_SECRET),
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 600_000),
      attempts: opts.attempts ?? 0,
      consumedAt: null,
      createdAt: new Date(),
    });
  return id;
}

describe('confirmPersonVerification — happy path', () => {
  it('writes the verification, link, identity event, and both mirrors in one batch', async () => {
    await seedRoster({
      lots: [
        {
          id: 'lot-happy',
          owners: [
            {
              id: 'own-happy',
              name: 'Happy Path',
              email: 'happy@example.test',
            },
          ],
        },
      ],
    });
    await seedAccount('acct-happy', 'visitor');
    await seedCode({
      accountId: 'acct-happy',
      personId: 'own-happy',
      contactMethodId: 'own-happy-email',
      lotId: 'lot-happy',
      channel: 'email',
      code: '123456',
    });

    const result = await confirmPersonVerification(env, 'acct-happy', '123456');
    expect(result).toEqual({ ok: true });

    const db = getDb(env);
    const [verification] = await db
      .select()
      .from(personVerifications)
      .where(eq(personVerifications.accountId, 'acct-happy'));
    expect(verification).toMatchObject({
      personId: 'own-happy',
      method: 'otp_email',
      contactMethodId: 'own-happy-email',
      contactMethodPartyKind: 'person',
      reason: 'automatic_contact_proof',
      approverAccountId: null,
    });

    const [link] = await db
      .select()
      .from(personLinks)
      .where(eq(personLinks.accountId, 'acct-happy'));
    expect(link).toMatchObject({
      personId: 'own-happy',
      verificationId: verification.id,
    });
    expect(link.endedAt).toBeNull();

    const identityRows = await db.all<{
      reason_code: string;
      person_verification_id: string;
      person_link_id: string;
      person_id: string;
      target_account_id: string;
    }>(
      sql`SELECT reason_code, person_verification_id, person_link_id, person_id, target_account_id
          FROM identity_events`,
    );
    expect(identityRows).toHaveLength(1);
    expect(identityRows[0]).toEqual({
      reason_code: 'automatic_contact_proof',
      person_verification_id: verification.id,
      person_link_id: link.id,
      person_id: 'own-happy',
      target_account_id: 'acct-happy',
    });

    const [rootEvent] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actorAccountId, 'acct-happy'));
    expect(rootEvent.family).toBe('identity');
    expect(rootEvent.eventKind).toBe('person_verified');
    expect(rootEvent.correlationSequence).toBe(0);
    expect(rootEvent.operationKey).toMatch(
      /^verify-confirm:person_verified:[0-9a-f-]{36}$/,
    );

    // Write-behind mirrors.
    const [mirrorLink] = await db
      .select()
      .from(userPropertyLinks)
      .where(eq(userPropertyLinks.userId, 'acct-happy'));
    expect(mirrorLink.propertyId).toBe('lot-happy');
    expect(mirrorLink.method).toBe('otp_email');
    const [account] = await db
      .select()
      .from(users)
      .where(eq(users.id, 'acct-happy'));
    expect(account.role).toBe('homeowner');

    expect(
      await db.all(sql`SELECT * FROM audit_integrity_violations_v`),
    ).toEqual([]);
  });

  it('never promotes an already-board account and never re-touches an already-homeowner account', async () => {
    await seedRoster({
      lots: [
        {
          id: 'lot-board',
          owners: [
            {
              id: 'own-board',
              name: 'Board Person',
              email: 'board@example.test',
            },
          ],
        },
      ],
    });
    await seedAccount('acct-board', 'homeowner');
    await getDb(env)
      .update(users)
      .set({ role: 'board' })
      .where(eq(users.id, 'acct-board'));
    await seedCode({
      accountId: 'acct-board',
      personId: 'own-board',
      contactMethodId: 'own-board-email',
      lotId: 'lot-board',
      channel: 'email',
      code: '654321',
    });

    const result = await confirmPersonVerification(env, 'acct-board', '654321');
    expect(result).toEqual({ ok: true });
    const [account] = await getDb(env)
      .select()
      .from(users)
      .where(eq(users.id, 'acct-board'));
    expect(account.role).toBe('board');
  });
});

describe('confirmPersonVerification — attempts, locking, expiry', () => {
  it('increments attempts on a wrong code and locks at MAX_ATTEMPTS', async () => {
    await seedRoster({
      lots: [
        {
          id: 'lot-attempts',
          owners: [
            {
              id: 'own-attempts',
              name: 'Attempts Person',
              email: 'att@example.test',
            },
          ],
        },
      ],
    });
    await seedAccount('acct-attempts');
    const codeId = await seedCode({
      accountId: 'acct-attempts',
      personId: 'own-attempts',
      contactMethodId: 'own-attempts-email',
      lotId: 'lot-attempts',
      channel: 'email',
      code: '111111',
    });

    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const res = await confirmPersonVerification(
        env,
        'acct-attempts',
        '000000',
      );
      expect(res).toEqual({ ok: false, reason: 'mismatch' });
      const [row] = await getDb(env)
        .select()
        .from(verificationCodes)
        .where(eq(verificationCodes.id, codeId));
      expect(row.attempts).toBe(i);
    }

    // Locked now, even with the correct code.
    const locked = await confirmPersonVerification(
      env,
      'acct-attempts',
      '111111',
    );
    expect(locked).toEqual({ ok: false, reason: 'locked' });
  });

  it('reports expired for a code past its expiry', async () => {
    await seedRoster({
      lots: [
        {
          id: 'lot-expired',
          owners: [
            {
              id: 'own-expired',
              name: 'Expired Person',
              email: 'exp@example.test',
            },
          ],
        },
      ],
    });
    await seedAccount('acct-expired');
    await seedCode({
      accountId: 'acct-expired',
      personId: 'own-expired',
      contactMethodId: 'own-expired-email',
      lotId: 'lot-expired',
      channel: 'email',
      code: '222222',
      expiresAt: new Date(Date.now() - 1_000),
    });

    const result = await confirmPersonVerification(
      env,
      'acct-expired',
      '222222',
    );
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('confirmPersonVerification — the person-link race', () => {
  it('a Person already linked elsewhere between request and confirm fails generically with zero new rows', async () => {
    await seedRoster({
      lots: [
        {
          id: 'lot-race',
          owners: [
            { id: 'own-race', name: 'Race Person', email: 'race@example.test' },
          ],
        },
      ],
      accounts: [
        { id: 'acct-winner', role: 'homeowner', linkedTo: 'own-race' },
      ],
    });
    await seedAccount('acct-loser');
    await seedCode({
      accountId: 'acct-loser',
      personId: 'own-race',
      contactMethodId: 'own-race-email',
      lotId: 'lot-race',
      channel: 'email',
      code: '333333',
    });

    const db = getDb(env);
    const before = {
      verifications: (await db.select().from(personVerifications)).length,
      links: (await db.select().from(personLinks)).length,
      identity: (await db.all(sql`SELECT * FROM identity_events`)).length,
      events: (await db.select().from(auditEvents)).length,
    };

    const result = await confirmPersonVerification(env, 'acct-loser', '333333');
    expect(result).toEqual({ ok: false, reason: 'mismatch' });

    const after = {
      verifications: (await db.select().from(personVerifications)).length,
      links: (await db.select().from(personLinks)).length,
      identity: (await db.all(sql`SELECT * FROM identity_events`)).length,
      events: (await db.select().from(auditEvents)).length,
    };
    expect(after).toEqual(before);

    // The pre-existing link is still the only current link for this Person.
    const currentLinks = await db
      .select()
      .from(personLinks)
      .where(
        and(eq(personLinks.personId, 'own-race'), isNull(personLinks.endedAt)),
      );
    expect(currentLinks).toHaveLength(1);
    expect(currentLinks[0].accountId).toBe('acct-winner');
  });
});

describe('a later-acquired Lot needs no re-verification', () => {
  it('getAuthContext (derived) reports both Lots after a second Ownership is recorded', async () => {
    await seedRoster({
      lots: [
        {
          id: 'lot-first',
          owners: [
            { id: 'own-later', name: 'Later Lot', email: 'later@example.test' },
          ],
        },
        { id: 'lot-second', owners: [] },
      ],
    });
    await seedAccount('acct-later');
    await seedCode({
      accountId: 'acct-later',
      personId: 'own-later',
      contactMethodId: 'own-later-email',
      lotId: 'lot-first',
      channel: 'email',
      code: '444444',
    });
    const result = await confirmPersonVerification(env, 'acct-later', '444444');
    expect(result).toEqual({ ok: true });

    // A second Ownership for the SAME Person, on the second Lot — recorded by
    // some other process entirely, with no re-verification of this account.
    await getDb(env).run(
      sql`INSERT INTO ownerships (id, owner_party_id, lot_id, start_day, created_at, updated_at)
          VALUES ('own-later-second', 'own-later', 'lot-second', NULL, 1, 1)`,
    );

    await getDb(env)
      .insert(cutoverSettings)
      .values({ key: 'cutover_mode', value: 'derived', updatedAt: new Date() });
    sessionUserId = 'acct-later';

    const ctx = await getAuthContext(new Request('http://localhost'), env, DAY);
    expect(ctx?.lotIds.sort()).toEqual(['lot-first', 'lot-second']);

    // No new identity facts were written for this — the Lot came from
    // Ownership alone.
    const identityCount = (
      await getDb(env).all(sql`SELECT * FROM identity_events`)
    ).length;
    expect(identityCount).toBe(1);
  });
});

describe('structural Organization exclusion (#202)', () => {
  it('rejects an Organization contact via party_kind (CHECK) and via a mismatched pair (composite FK)', async () => {
    const db = getDb(env);
    await db.run(
      sql`INSERT INTO parties (id, kind, created_at, updated_at) VALUES ('org-excl', 'organization', 1, 1)`,
    );
    await db.run(
      sql`INSERT INTO organizations (party_id, party_kind, legal_name, name_normalized, updated_at)
          VALUES ('org-excl', 'organization', 'Excluded Org', 'excluded org', 1)`,
    );
    await db.insert(contactMethods).values({
      id: 'org-excl-email',
      partyId: 'org-excl',
      partyKind: 'organization',
      channel: 'email',
      value: 'org@example.test',
      valueNormalized: 'org@example.test',
      isPreferred: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await seedRoster({
      lots: [
        { id: 'lot-excl', owners: [{ id: 'own-excl', name: 'Excl Person' }] },
      ],
    });
    await seedAccount('acct-excl');

    // party_kind = 'organization': the CHECK
    // `person_verifications_contact_person_only` rejects it outright.
    await expect(
      env.DATABASE.prepare(
        `INSERT INTO person_verifications (id, account_id, person_id, method, contact_method_id, contact_method_party_kind, reason, verified_at)
         VALUES (?, ?, ?, 'otp_email', ?, 'organization', 'automatic_contact_proof', ?)`,
      )
        .bind(
          crypto.randomUUID(),
          'acct-excl',
          'own-excl',
          'org-excl-email',
          Date.now(),
        )
        .run(),
    ).rejects.toThrow();

    // party_kind = 'person' but the id belongs to an Organization's contact:
    // the composite FK to contact_methods(id, party_kind) has no such row.
    await expect(
      env.DATABASE.prepare(
        `INSERT INTO person_verifications (id, account_id, person_id, method, contact_method_id, contact_method_party_kind, reason, verified_at)
         VALUES (?, ?, ?, 'otp_email', ?, 'person', 'automatic_contact_proof', ?)`,
      )
        .bind(
          crypto.randomUUID(),
          'acct-excl',
          'own-excl',
          'org-excl-email',
          Date.now(),
        )
        .run(),
    ).rejects.toThrow();
  });
});
