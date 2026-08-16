import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';

vi.mock('../../src/server/auth/senders', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  sendSms: vi.fn().mockResolvedValue(undefined),
}));

import { getDb } from '../../src/server/db/client';
import {
  contactMethods,
  verificationReviewRequests,
} from '../../src/server/db/roster-schema';
import { sendEmail } from '../../src/server/auth/senders';
import {
  matchPersonForVerification,
  requestPersonVerification,
} from '../../src/server/roster/verification';
import { resetRoster, seedRoster } from './dual-fixtures';

// ADR 0022 phase 3c (#219/D3): the derived-mode Person matcher. Every case
// here is an INTERNAL outcome — the route (verify-request-message.test.ts,
// verify-uniform-response.test.ts) is what proves these all collapse to the
// same response; this file proves the matcher makes the right internal call.

const DAY = '2026-06-15';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(sendEmail).mockResolvedValue(undefined);
  // verification_codes references people/contact_methods/properties with
  // RESTRICT, so it must be cleared BEFORE resetRoster() deletes those.
  await getDb(env).run(sql.raw('DELETE FROM verification_codes'));
  await getDb(env).run(sql.raw('DELETE FROM verification_review_requests'));
  await resetRoster();
  await getDb(env).run(sql.raw('DELETE FROM users'));
});

async function seedAccount(id: string) {
  await getDb(env).run(
    sql`INSERT INTO users (id, name, email, email_verified, role, created_at, updated_at)
        VALUES (${id}, ${id}, ${`${id}@example.test`}, 0, 'homeowner', 1, 1)`,
  );
}

describe('matchPersonForVerification', () => {
  it('tier 1: an exact normalized full-name match', async () => {
    await seedRoster({
      lots: [
        {
          id: 'lot-t1',
          owners: [
            { id: 'own-t1', name: 'Jane Doe', email: 'jane@example.test' },
          ],
        },
      ],
    });
    await seedAccount('acct-t1');

    const result = await matchPersonForVerification(
      env,
      DAY,
      'acct-t1',
      'lot-t1 Way',
      'Jane Doe',
      'email',
    );
    expect(result).toEqual({
      kind: 'matched',
      lotId: 'lot-t1',
      personId: 'own-t1',
      contactMethodId: 'own-t1-email',
      contactValue: 'jane@example.test',
    });
  });

  it('tier 2: first+last token match resolves to one owner', async () => {
    await seedRoster({
      lots: [
        {
          id: 'lot-t2',
          owners: [
            {
              id: 'own-t2',
              name: 'Jane Middle Doe',
              email: 'jane2@example.test',
            },
          ],
        },
      ],
    });
    await seedAccount('acct-t2');

    const result = await matchPersonForVerification(
      env,
      DAY,
      'acct-t2',
      'lot-t2 Way',
      'Jane Doe',
      'email',
    );
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') expect(result.personId).toBe('own-t2');
  });

  it('tier 2: two owners resolving the same first+last tokens is ambiguous and fails', async () => {
    await seedRoster({
      lots: [
        {
          id: 'lot-amb',
          owners: [
            {
              id: 'own-amb-a',
              name: 'Jane Alpha Doe',
              email: 'a@example.test',
            },
            { id: 'own-amb-b', name: 'Jane Beta Doe', email: 'b@example.test' },
          ],
        },
      ],
    });
    await seedAccount('acct-amb');

    const result = await matchPersonForVerification(
      env,
      DAY,
      'acct-amb',
      'lot-amb Way',
      'Jane Doe',
      'email',
    );
    expect(result).toEqual({ kind: 'name_unmatched' });
  });

  it('two exact tier-1 matches is ambiguous with no fallback to tier 2', async () => {
    await seedRoster({
      lots: [
        {
          id: 'lot-exact-amb',
          owners: [
            { id: 'own-exact-a', name: 'Pat Smith', email: 'pa@example.test' },
            { id: 'own-exact-b', name: 'Pat Smith', email: 'pb@example.test' },
          ],
        },
      ],
    });
    await seedAccount('acct-exact-amb');

    const result = await matchPersonForVerification(
      env,
      DAY,
      'acct-exact-amb',
      'lot-exact-amb Way',
      'Pat Smith',
      'email',
    );
    expect(result).toEqual({ kind: 'name_unmatched' });
  });

  it('an organization-owned Lot never matches, even the applicant naming themself', async () => {
    const now = 1;
    await getDb(env).run(
      sql`INSERT INTO properties (id, address, address_normalized, status, vote_weight, created_at, updated_at)
          VALUES ('lot-org', 'lot-org Way', 'lot-org way', 'active', 1, ${now}, ${now})`,
    );
    await getDb(env).run(
      sql`INSERT INTO parties (id, kind, created_at, updated_at) VALUES ('org-1', 'organization', ${now}, ${now})`,
    );
    await getDb(env).run(
      sql`INSERT INTO organizations (party_id, party_kind, legal_name, name_normalized, updated_at)
          VALUES ('org-1', 'organization', 'Acme HOA Holdings', 'acme hoa holdings', ${now})`,
    );
    await getDb(env).run(
      sql`INSERT INTO ownerships (id, owner_party_id, lot_id, start_day, created_at, updated_at)
          VALUES ('own-org-1', 'org-1', 'lot-org', NULL, ${now}, ${now})`,
    );
    await seedAccount('acct-org');

    const result = await matchPersonForVerification(
      env,
      DAY,
      'acct-org',
      'lot-org Way',
      'Acme HOA Holdings',
      'email',
    );
    expect(result).toEqual({ kind: 'name_unmatched' });
  });

  it('a contact value shared by two Parties disqualifies both', async () => {
    await seedRoster({
      lots: [
        {
          id: 'lot-shared',
          owners: [
            {
              id: 'own-shared-a',
              name: 'Sam Shared',
              email: 'shared@example.test',
            },
            {
              id: 'own-shared-b',
              name: 'Robin Other',
              email: 'unique@example.test',
            },
          ],
        },
      ],
    });
    // Force the collision: Robin's email now matches Sam's, roster-wide.
    await getDb(env)
      .update(contactMethods)
      .set({
        value: 'shared@example.test',
        valueNormalized: 'shared@example.test',
      })
      .where(eq(contactMethods.id, 'own-shared-b-email'));
    await seedAccount('acct-shared');

    const result = await matchPersonForVerification(
      env,
      DAY,
      'acct-shared',
      'lot-shared Way',
      'Sam Shared',
      'email',
    );
    expect(result).toEqual({ kind: 'no_contact' });
  });

  it('picks the preferred contact when more than one is uniquely attributable', async () => {
    await seedRoster({
      lots: [
        {
          id: 'lot-pref',
          owners: [
            { id: 'own-pref', name: 'Casey Pref', email: 'first@example.test' },
          ],
        },
      ],
    });
    // seedRoster's single email lands preferred; add a second, non-preferred
    // unique contact, then flip which one is preferred.
    await getDb(env).insert(contactMethods).values({
      id: 'own-pref-email-2',
      partyId: 'own-pref',
      partyKind: 'person',
      channel: 'email',
      value: 'second@example.test',
      valueNormalized: 'second@example.test',
      isPreferred: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await getDb(env)
      .update(contactMethods)
      .set({ isPreferred: false })
      .where(eq(contactMethods.id, 'own-pref-email'));
    await getDb(env)
      .update(contactMethods)
      .set({ isPreferred: true })
      .where(eq(contactMethods.id, 'own-pref-email-2'));
    await seedAccount('acct-pref');

    const result = await matchPersonForVerification(
      env,
      DAY,
      'acct-pref',
      'lot-pref Way',
      'Casey Pref',
      'email',
    );
    expect(result).toEqual({
      kind: 'matched',
      lotId: 'lot-pref',
      personId: 'own-pref',
      contactMethodId: 'own-pref-email-2',
      contactValue: 'second@example.test',
    });
  });

  it('an unknown address never creates a review request', async () => {
    await seedAccount('acct-unknown');
    const result = await matchPersonForVerification(
      env,
      DAY,
      'acct-unknown',
      '0000 Nowhere',
      'Nobody',
      'email',
    );
    expect(result).toEqual({ kind: 'lot_not_found' });
    const rows = await getDb(env).select().from(verificationReviewRequests);
    expect(rows).toHaveLength(0);
  });

  it('no contact on file never creates a review request', async () => {
    await seedRoster({
      lots: [
        {
          id: 'lot-nocontact',
          owners: [{ id: 'own-nocontact', name: 'No Contact' }],
        },
      ],
    });
    await seedAccount('acct-nocontact');
    const result = await matchPersonForVerification(
      env,
      DAY,
      'acct-nocontact',
      'lot-nocontact Way',
      'No Contact',
      'email',
    );
    expect(result).toEqual({ kind: 'no_contact' });
    const rows = await getDb(env).select().from(verificationReviewRequests);
    expect(rows).toHaveLength(0);
  });

  it('a Person already linked to a different account auto-creates ONE review request, idempotently', async () => {
    await seedRoster({
      lots: [
        {
          id: 'lot-collide',
          owners: [
            {
              id: 'own-collide',
              name: 'Linked Person',
              email: 'linked@example.test',
            },
          ],
        },
      ],
      accounts: [
        { id: 'acct-holder', role: 'homeowner', linkedTo: 'own-collide' },
      ],
    });
    await seedAccount('acct-newcomer');

    const first = await matchPersonForVerification(
      env,
      DAY,
      'acct-newcomer',
      'lot-collide Way',
      'Linked Person',
      'email',
    );
    expect(first).toEqual({ kind: 'person_already_linked' });

    const second = await matchPersonForVerification(
      env,
      DAY,
      'acct-newcomer',
      'lot-collide Way',
      'Linked Person',
      'email',
    );
    expect(second).toEqual({ kind: 'person_already_linked' });

    const rows = await getDb(env)
      .select()
      .from(verificationReviewRequests)
      .where(eq(verificationReviewRequests.accountId, 'acct-newcomer'));
    expect(rows).toHaveLength(1);
    expect(rows[0].internalReason).toBe('person_already_linked');
    expect(rows[0].status).toBe('open');
  });

  it('this account already being linked (to anyone) fails with nothing created', async () => {
    await seedRoster({
      lots: [
        {
          id: 'lot-a',
          owners: [
            { id: 'own-a', name: 'Account Already', email: 'aa@example.test' },
          ],
        },
        {
          id: 'lot-b',
          owners: [
            { id: 'own-b', name: 'Other Person', email: 'bb@example.test' },
          ],
        },
      ],
      accounts: [
        { id: 'acct-linked-already', role: 'homeowner', linkedTo: 'own-a' },
      ],
    });

    const result = await matchPersonForVerification(
      env,
      DAY,
      'acct-linked-already',
      'lot-b Way',
      'Other Person',
      'email',
    );
    expect(result).toEqual({ kind: 'account_already_linked' });
    const rows = await getDb(env).select().from(verificationReviewRequests);
    expect(rows).toHaveLength(0);
  });
});

describe('requestPersonVerification sends', () => {
  it('sends exactly ONE message on a match', async () => {
    await seedRoster({
      lots: [
        {
          id: 'lot-send',
          owners: [
            { id: 'own-send', name: 'Send Me', email: 'send@example.test' },
          ],
        },
      ],
    });
    await seedAccount('acct-send');

    const result = await requestPersonVerification(
      env,
      DAY,
      'acct-send',
      'lot-send Way',
      'Send Me',
      'email',
    );
    expect(result).toEqual({ kind: 'sent' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('sends nothing on every failure path', async () => {
    await seedRoster({
      lots: [
        { id: 'lot-nosend', owners: [{ id: 'own-nosend', name: 'No Send' }] },
      ],
    });
    await seedAccount('acct-nosend-1');
    await seedAccount('acct-nosend-2');

    const notFound = await requestPersonVerification(
      env,
      DAY,
      'acct-nosend-1',
      '0000 Gone',
      'Whoever',
      'email',
    );
    expect(notFound.kind).toBe('lot_not_found');

    const noContact = await requestPersonVerification(
      env,
      DAY,
      'acct-nosend-2',
      'lot-nosend Way',
      'No Send',
      'email',
    );
    expect(noContact.kind).toBe('no_contact');

    expect(sendEmail).not.toHaveBeenCalled();
  });
});
