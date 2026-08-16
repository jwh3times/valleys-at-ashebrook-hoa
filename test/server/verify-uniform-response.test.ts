import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';

vi.mock('../../src/server/authz/turnstile', () => ({
  verifyTurnstile: async () => true,
}));
vi.mock('../../src/server/auth/senders', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  sendSms: vi.fn().mockResolvedValue(undefined),
}));

const callerState = vi.hoisted(() => ({ userId: 'placeholder' }));
vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () =>
    legacyAuthContext(callerState.userId, 'homeowner', []),
}));

import {
  POST,
  UNIFORM_REQUEST_RESPONSE,
} from '../../src/pages/api/verify/request';
import { legacyAuthContext } from '../../src/server/authz/context';
import { getDb } from '../../src/server/db/client';
import { properties, owners, users } from '../../src/server/db/schema';
import { contactMethods } from '../../src/server/db/roster-schema';
import { cutoverSettings } from '../../src/server/db/cutover-schema';
import { seedRoster } from './dual-fixtures';

// ADR 0022 phase 3c (#219/D2): the uniform response is a SECURITY boundary.
// Every internal path enumerated here — success, every failure kind, every
// rate limit, both cutover modes — must produce the exact same status and
// byte-identical body. This file is that proof, not a spot check.

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

function req(body: Record<string, unknown>) {
  return POST({
    request: new Request('http://localhost/api/verify/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turnstileToken: 't', ...body }),
    }),
  } as never);
}

/** Every scenario below uses a unique account, so the per-account cooldown
 * and daily counter never bleed between cases. */
async function seedAccount(id: string) {
  await getDb(env)
    .insert(users)
    .values({
      id,
      name: id,
      email: `${id}@example.test`,
      emailVerified: false,
      role: 'homeowner',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
}

async function expectUniform(res: Response) {
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toBe(JSON.stringify(UNIFORM_REQUEST_RESPONSE));
}

describe('derived mode: every path converges', () => {
  beforeAll(async () => {
    await getDb(env).delete(cutoverSettings);
    await getDb(env)
      .insert(cutoverSettings)
      .values({ key: 'cutover_mode', value: 'derived', updatedAt: new Date() });

    await seedRoster({
      lots: [
        {
          id: 'ur-lot-ok',
          owners: [
            { id: 'ur-own-ok', name: 'OK Owner', email: 'ok@example.test' },
          ],
        },
        {
          id: 'ur-lot-unmatched',
          owners: [
            {
              id: 'ur-own-unmatched',
              name: 'Real Name',
              email: 'real@example.test',
            },
          ],
        },
        {
          id: 'ur-lot-amb',
          owners: [
            {
              id: 'ur-own-amb-a',
              name: 'Jane Alpha Doe',
              email: 'amb-a@example.test',
            },
            {
              id: 'ur-own-amb-b',
              name: 'Jane Beta Doe',
              email: 'amb-b@example.test',
            },
          ],
        },
        {
          id: 'ur-lot-shared',
          owners: [
            {
              id: 'ur-own-shared-a',
              name: 'Shared A',
              email: 'shared@example.test',
            },
            {
              id: 'ur-own-shared-b',
              name: 'Shared B',
              email: 'unique-shared-b@example.test',
            },
          ],
        },
        {
          id: 'ur-lot-linked',
          owners: [
            {
              id: 'ur-own-linked',
              name: 'Linked Owner',
              email: 'linked@example.test',
            },
          ],
        },
        {
          id: 'ur-lot-selfsource',
          owners: [
            {
              id: 'ur-own-selfsource',
              name: 'Self Source',
              email: 'selfsource@example.test',
            },
          ],
        },
        {
          id: 'ur-lot-other',
          owners: [
            {
              id: 'ur-own-other',
              name: 'Other Owner',
              email: 'other@example.test',
            },
          ],
        },
        {
          id: 'ur-lot-ratelot',
          owners: [
            {
              id: 'ur-own-ratelot',
              name: 'Rate Lot Owner',
              email: 'ratelot@example.test',
            },
          ],
        },
        {
          id: 'ur-lot-rateperson',
          owners: [
            {
              id: 'ur-own-rateperson',
              name: 'Rate Person Owner',
              email: 'rateperson@example.test',
            },
          ],
        },
        {
          id: 'ur-lot-ratenames',
          owners: [
            {
              id: 'ur-own-ratenames',
              name: 'Rate Names Owner',
              email: 'ratenames@example.test',
            },
          ],
        },
      ],
      accounts: [
        { id: 'ur-acct-ok', role: 'homeowner' },
        { id: 'ur-acct-unknown', role: 'homeowner' },
        { id: 'ur-acct-unmatched', role: 'homeowner' },
        { id: 'ur-acct-amb', role: 'homeowner' },
        { id: 'ur-acct-org', role: 'homeowner' },
        { id: 'ur-acct-shared', role: 'homeowner' },
        { id: 'ur-acct-holder', role: 'homeowner', linkedTo: 'ur-own-linked' },
        { id: 'ur-acct-newcomer', role: 'homeowner' },
        {
          id: 'ur-acct-selflinked',
          role: 'homeowner',
          linkedTo: 'ur-own-selfsource',
        },
        { id: 'ur-acct-ratelot', role: 'homeowner' },
        { id: 'ur-acct-rateperson', role: 'homeowner' },
        { id: 'ur-acct-ratenames', role: 'homeowner' },
        { id: 'ur-acct-ratedaily', role: 'homeowner' },
      ],
    });

    // Organization-owned Lot: no Person owner at all.
    const now = 1;
    await getDb(env).run(
      sql`INSERT INTO properties (id, address, address_normalized, status, vote_weight, created_at, updated_at)
          VALUES ('ur-lot-org', 'ur-lot-org Way', 'ur-lot-org way', 'active', 1, ${now}, ${now})`,
    );
    await getDb(env).run(
      sql`INSERT INTO parties (id, kind, created_at, updated_at) VALUES ('ur-org', 'organization', ${now}, ${now})`,
    );
    await getDb(env).run(
      sql`INSERT INTO organizations (party_id, party_kind, legal_name, name_normalized, updated_at)
          VALUES ('ur-org', 'organization', 'UR Org Holdings', 'ur org holdings', ${now})`,
    );
    await getDb(env).run(
      sql`INSERT INTO ownerships (id, owner_party_id, lot_id, start_day, created_at, updated_at)
          VALUES ('ur-own-org', 'ur-org', 'ur-lot-org', NULL, ${now}, ${now})`,
    );

    // Force the shared-contact collision: both owners resolve to one email.
    await getDb(env)
      .update(contactMethods)
      .set({
        value: 'shared@example.test',
        valueNormalized: 'shared@example.test',
      })
      .where(eq(contactMethods.id, 'ur-own-shared-b-email'));
  });

  it('success: a matched Person receives the code', async () => {
    callerState.userId = 'ur-acct-ok';
    await expectUniform(
      await req({
        address: 'ur-lot-ok Way',
        name: 'OK Owner',
        channel: 'email',
      }),
    );
  });

  it('unknown address', async () => {
    callerState.userId = 'ur-acct-unknown';
    await expectUniform(
      await req({ address: '0000 Nowhere', name: 'Nobody', channel: 'email' }),
    );
  });

  it('unmatched name', async () => {
    callerState.userId = 'ur-acct-unmatched';
    await expectUniform(
      await req({
        address: 'ur-lot-unmatched Way',
        name: 'Wrong Person',
        channel: 'email',
      }),
    );
  });

  it('ambiguous name (two owners resolving the same tokens)', async () => {
    callerState.userId = 'ur-acct-amb';
    await expectUniform(
      await req({
        address: 'ur-lot-amb Way',
        name: 'Jane Doe',
        channel: 'email',
      }),
    );
  });

  it('an organization-owned Lot', async () => {
    callerState.userId = 'ur-acct-org';
    await expectUniform(
      await req({
        address: 'ur-lot-org Way',
        name: 'UR Org Holdings',
        channel: 'email',
      }),
    );
  });

  it('a shared contact disqualifying both owners', async () => {
    callerState.userId = 'ur-acct-shared';
    await expectUniform(
      await req({
        address: 'ur-lot-shared Way',
        name: 'Shared A',
        channel: 'email',
      }),
    );
  });

  it('the matched Person is already linked to a different account', async () => {
    callerState.userId = 'ur-acct-newcomer';
    await expectUniform(
      await req({
        address: 'ur-lot-linked Way',
        name: 'Linked Owner',
        channel: 'email',
      }),
    );
  });

  it('this account is already linked (to anyone)', async () => {
    callerState.userId = 'ur-acct-selflinked';
    await expectUniform(
      await req({
        address: 'ur-lot-other Way',
        name: 'Other Owner',
        channel: 'email',
      }),
    );
  });

  it('the per-Lot daily limit', async () => {
    await env.KV.put('verif:day:prop:ur-lot-ratelot', '5', {
      expirationTtl: 86_400,
    });
    callerState.userId = 'ur-acct-ratelot';
    await expectUniform(
      await req({
        address: 'ur-lot-ratelot Way',
        name: 'Rate Lot Owner',
        channel: 'email',
      }),
    );
  });

  it('the per-Person daily limit', async () => {
    await env.KV.put('verif:day:person:ur-own-rateperson', '5', {
      expirationTtl: 86_400,
    });
    callerState.userId = 'ur-acct-rateperson';
    await expectUniform(
      await req({
        address: 'ur-lot-rateperson Way',
        name: 'Rate Person Owner',
        channel: 'email',
      }),
    );
  });

  it('the distinct-claimed-names cap', async () => {
    await env.KV.put(
      'verif:names:ur-lot-ratenames:ur-acct-ratenames',
      JSON.stringify(['name one', 'name two', 'name three']),
      { expirationTtl: 86_400 },
    );
    callerState.userId = 'ur-acct-ratenames';
    await expectUniform(
      await req({
        address: 'ur-lot-ratenames Way',
        name: 'Name Four',
        channel: 'email',
      }),
    );
  });

  it('the per-account daily limit', async () => {
    await env.KV.put('verif:day:user:ur-acct-ratedaily', '5', {
      expirationTtl: 86_400,
    });
    callerState.userId = 'ur-acct-ratedaily';
    await expectUniform(
      await req({
        address: '0000 Irrelevant',
        name: 'Nobody',
        channel: 'email',
      }),
    );
  });
});

describe('legacy mode: a known address and an unknown address are identical', () => {
  beforeAll(async () => {
    await getDb(env).delete(cutoverSettings);

    const now = new Date();
    await getDb(env).insert(properties).values({
      id: 'ur-legacy-prop',
      address: '5 Legacy Ln',
      addressNormalized: '5 legacy ln',
      unit: null,
      status: 'active',
      notes: null,
      createdAt: now,
      updatedAt: now,
    });
    await getDb(env).insert(owners).values({
      id: 'ur-legacy-own',
      propertyId: 'ur-legacy-prop',
      fullName: 'Legacy Owner',
      phone: null,
      email: 'legacy@example.test',
      status: 'active',
      notes: null,
      createdAt: now,
      updatedAt: now,
    });
    await seedAccount('ur-acct-legacy-known');
    await seedAccount('ur-acct-legacy-unknown');
  });

  it('both answer the same uniform response', async () => {
    callerState.userId = 'ur-acct-legacy-known';
    const known = await req({
      address: '5 Legacy Ln',
      name: '',
      channel: 'email',
    });
    await expectUniform(known);

    callerState.userId = 'ur-acct-legacy-unknown';
    const unknown = await req({
      address: '0000 Nowhere',
      name: '',
      channel: 'email',
    });
    await expectUniform(unknown);
  });
});
