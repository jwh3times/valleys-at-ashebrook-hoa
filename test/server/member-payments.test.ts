import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { POST } from '../../src/pages/api/member/payments';
import { setPaymentProviderForTests } from '../../src/server/payments/registry';
import {
  MAX_PAYMENT_CENTS,
  MIN_PAYMENT_CENTS,
  paymentReference,
} from '../../src/lib/payments';
import type { AuthContext } from '../../src/server/authz/guards';
import {
  truncateAll,
  seedProperty,
  seedLotAuthority,
  seedPerson,
} from './fixtures';
import {
  FAKE_PROVIDER_ID,
  fakeProvider,
  unconfigurePayments,
} from './payments-fixtures';

/**
 * `POST /api/member/payments` (ADR 0025, #542): a homeowner starts paying
 * dues on a Lot they hold.
 *
 * Observed as the homeowner and the board observe it: the status, the `{ url }`
 * the browser is sent to, the `payments` row that exists afterwards, and what
 * the provider was asked for. Nothing here reads which helper ran.
 */

const ORIGIN = 'http://localhost';
const SITE_URL = 'https://residents.example';
const mutableEnv = env as unknown as Record<string, unknown>;
const realSiteUrl = env.BETTER_AUTH_URL;

const member = (personId: string | null = 'payer-1'): AuthContext => ({
  userId: 'account-payer-1',
  personId,
  capabilities: new Set(['member']),
  lotIds: ['lot-a'],
  contentTier: 'homeowner',
  hasCurrentBoardTerm: false,
});

const ALL_ON = {
  officialMode: true,
  lotRecordsEnabled: true,
  onlinePaymentsEnabled: true,
};

async function setSite(flags: Record<string, unknown>) {
  await env.DATABASE.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('site', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  )
    .bind(JSON.stringify(flags), Date.now())
    .run();
}

function start(
  body: unknown,
  {
    caller = member(),
    origin = ORIGIN,
    contentType = 'application/json',
  }: {
    caller?: AuthContext | null;
    origin?: string | null;
    contentType?: string;
  } = {},
) {
  const headers: Record<string, string> = { 'content-type': contentType };
  if (origin !== null) headers.origin = origin;
  return POST({
    request: new Request(`${ORIGIN}/api/member/payments`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    locals: { authContext: caller },
  } as never);
}

async function paymentRows() {
  const { results } = await env.DATABASE.prepare(
    `SELECT id, lot_id, amount_cents, initiated_by_person_id, origin, provider,
            provider_payment_ref, status, ledger_state
       FROM payments ORDER BY created_at`,
  ).all<{
    id: string;
    lot_id: string;
    amount_cents: number;
    initiated_by_person_id: string | null;
    origin: string;
    provider: string;
    provider_payment_ref: string | null;
    status: string;
    ledger_state: string;
  }>();
  return results;
}

let fake: ReturnType<typeof fakeProvider>;
const useFake = (options: Parameters<typeof fakeProvider>[0] = {}) => {
  fake = fakeProvider(options);
  setPaymentProviderForTests(fake);
};

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  // A consolidation link points at another party with RESTRICT, so it would
  // make the shared teardown's `DELETE FROM parties` fail.
  await env.DATABASE.prepare(
    'UPDATE parties SET consolidated_into_party_id = NULL',
  ).run();
  unconfigurePayments();
  mutableEnv.BETTER_AUTH_URL = SITE_URL;
  await truncateAll();
  await env.DATABASE.prepare(
    "DELETE FROM cutover_settings WHERE key = 'write_freeze'",
  ).run();
  await seedProperty('lot-a');
  await seedProperty('lot-b');
  await seedLotAuthority('payer-1', 'lot-a', { startDay: '2020-01-01' });
  await seedLotAuthority('neighbor-1', 'lot-b', { startDay: '2020-01-01' });
  await setSite(ALL_ON);
  useFake();
});

afterEach(() => {
  setPaymentProviderForTests(null);
  mutableEnv.BETTER_AUTH_URL = realSiteUrl;
});

describe('starting a payment', () => {
  it('records a created payment and sends the homeowner to the provider', async () => {
    const res = await start({ lotId: 'lot-a', amountCents: 45075 });

    expect(res.status).toBe(201);
    const { url } = (await res.json()) as { url: string };
    const rows = await paymentRows();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(url).toBe(`https://checkout.invalid/${row.id}`);
    expect(row).toMatchObject({
      lot_id: 'lot-a',
      amount_cents: 45075,
      initiated_by_person_id: 'payer-1',
      origin: 'checkout',
      provider: FAKE_PROVIDER_ID,
      provider_payment_ref: `ref_${row.id}`,
      status: 'created',
      ledger_state: 'none',
    });
  });

  it('builds the return and cancel addresses from the site URL, never the request host', async () => {
    await start({ lotId: 'lot-a', amountCents: 45075 });

    const [row] = await paymentRows();
    expect(fake.checkouts).toEqual([
      {
        paymentId: row.id,
        paymentReference: paymentReference(row.id),
        amountCents: 45075,
        returnUrl: `${SITE_URL}/lot-records/payments/${row.id}`,
        cancelUrl: `${SITE_URL}/lot-records/payments/${row.id}`,
      },
    ]);
  });

  it('hands the provider the payment’s Payment Reference to print on its receipt (#562)', async () => {
    await start({ lotId: 'lot-a', amountCents: 45075 });

    const [row] = await paymentRows();
    expect(fake.checkouts).toHaveLength(1);
    expect(fake.checkouts[0].paymentReference).toBe(paymentReference(row.id));
    expect(fake.checkouts[0].paymentReference).toMatch(
      /^[0-9A-F]{4}-[0-9A-F]{4}$/,
    );
  });

  it('lets an account linked to a consolidated duplicate pay for the survivor’s Lot', async () => {
    // Consolidation marks the duplicate and moves no Ownership, while the
    // caller's membership was decided through the survivor. Refusing here
    // would offer a Pay action that always answers 404.
    await seedPerson('duplicate-1');
    await env.DATABASE.prepare(
      "UPDATE parties SET consolidated_into_party_id = 'payer-1' WHERE id = 'duplicate-1'",
    ).run();

    const res = await start(
      { lotId: 'lot-a', amountCents: 45000 },
      { caller: member('duplicate-1') },
    );

    expect(res.status).toBe(201);
    // Who acted is recorded as is; only the authority question resolves.
    const [row] = await paymentRows();
    expect(row.initiated_by_person_id).toBe('duplicate-1');
  });

  it.each([
    ['the smallest payment', MIN_PAYMENT_CENTS],
    ['the largest payment', MAX_PAYMENT_CENTS],
  ])('accepts %s', async (_, amountCents) => {
    expect((await start({ lotId: 'lot-a', amountCents })).status).toBe(201);
  });
});

describe('amounts and Lots it refuses', () => {
  it.each([
    ['one cent under the minimum', MIN_PAYMENT_CENTS - 1],
    ['one cent over the maximum', MAX_PAYMENT_CENTS + 1],
    ['zero', 0],
    ['a negative amount', -45000],
    ['a fraction of a cent', 450.5],
    ['a string', '45000'],
    ['nothing', undefined],
  ])(
    'answers 400 to %s, asking the provider for nothing',
    async (_, amountCents) => {
      const res = await start({ lotId: 'lot-a', amountCents });

      expect(res.status).toBe(400);
      expect(fake.checkouts).toEqual([]);
      expect(await paymentRows()).toEqual([]);
    },
  );

  it('answers 400 to a missing Lot, and to a body that is not JSON', async () => {
    expect((await start({ amountCents: 45000 })).status).toBe(400);
    expect((await start('{"lotId":')).status).toBe(400);
    expect(await paymentRows()).toEqual([]);
  });

  it.each([
    ['a Lot someone else holds', 'lot-b'],
    ['a Lot that does not exist', 'lot-nowhere'],
  ])('answers the same 404 for %s', async (_, lotId) => {
    const res = await start({ lotId, amountCents: 45000 });

    expect(res.status).toBe(404);
    expect(fake.checkouts).toEqual([]);
    expect(await paymentRows()).toEqual([]);
  });

  it('answers 404 to a member with no Person Link to scope them by', async () => {
    const res = await start(
      { lotId: 'lot-a', amountCents: 45000 },
      { caller: member(null) },
    );
    expect(res.status).toBe(404);
    expect(await paymentRows()).toEqual([]);
  });
});

describe('the gate, in its fixed order', () => {
  it.each([
    ['official mode is off', { ...ALL_ON, officialMode: false }],
    ['lot records are off', { ...ALL_ON, lotRecordsEnabled: false }],
    ['online payments are off', { ...ALL_ON, onlinePaymentsEnabled: false }],
    [
      'a flag is the string "true"',
      { ...ALL_ON, onlinePaymentsEnabled: 'true' },
    ],
  ])('answers 404 when %s', async (_, flags) => {
    await setSite(flags);
    const res = await start({ lotId: 'lot-a', amountCents: 45000 });
    expect(res.status).toBe(404);
    expect(fake.checkouts).toEqual([]);
  });

  it('answers 404 when no payment provider is configured, before any other check', async () => {
    setPaymentProviderForTests(null);
    // Anonymous and cross-origin too: an unconfigured deployment must not
    // answer 401 or 403 and so advertise that the surface exists.
    for (const options of [
      {},
      { caller: null },
      { origin: 'https://elsewhere.example' },
    ]) {
      const res = await start({ lotId: 'lot-a', amountCents: 45000 }, options);
      expect(res.status).toBe(404);
    }
    expect(await paymentRows()).toEqual([]);
  });

  it('answers 503 during the write freeze, before the header checks', async () => {
    await env.DATABASE.prepare(
      "INSERT INTO cutover_settings (key, value, updated_at) VALUES ('write_freeze', 'on', 1)",
    ).run();
    const res = await start(
      { lotId: 'lot-a', amountCents: 45000 },
      { origin: 'https://elsewhere.example' },
    );
    expect(res.status).toBe(503);
    expect(fake.checkouts).toEqual([]);
  });

  it('answers 403 to another origin, and to none', async () => {
    for (const origin of ['https://elsewhere.example', null]) {
      const res = await start(
        { lotId: 'lot-a', amountCents: 45000 },
        { origin },
      );
      expect(res.status).toBe(403);
    }
    expect(fake.checkouts).toEqual([]);
  });

  it('answers 415 to a form post, before reading the session', async () => {
    const res = await start('lotId=lot-a&amountCents=45000', {
      contentType: 'application/x-www-form-urlencoded',
      caller: null,
    });
    expect(res.status).toBe(415);
  });

  it('answers 401 to an anonymous caller, and 403 to one without Lot Authority', async () => {
    expect(
      (await start({ lotId: 'lot-a', amountCents: 45000 }, { caller: null }))
        .status,
    ).toBe(401);
    const visitor: AuthContext = {
      ...member(),
      capabilities: new Set(),
      lotIds: [],
      contentTier: 'visitor',
    };
    expect(
      (await start({ lotId: 'lot-a', amountCents: 45000 }, { caller: visitor }))
        .status,
    ).toBe(403);
    expect(fake.checkouts).toEqual([]);
  });
});

describe('a race between the preflight and the insert', () => {
  it('answers 409 and records nothing when online payments are turned off mid-request', async () => {
    useFake({
      duringCheckout: () =>
        setSite({ ...ALL_ON, onlinePaymentsEnabled: false }),
    });

    const res = await start({ lotId: 'lot-a', amountCents: 45000 });

    expect(res.status).toBe(409);
    expect(fake.checkouts).toHaveLength(1);
    expect(await paymentRows()).toEqual([]);
  });

  it('answers the masked 404 and records nothing when the caller stops holding the Lot mid-request', async () => {
    useFake({
      duringCheckout: async () => {
        await env.DATABASE.prepare(
          "UPDATE ownerships SET end_day = '2020-06-01' WHERE id = 'payer-1-lot-a-own'",
        ).run();
      },
    });

    const res = await start({ lotId: 'lot-a', amountCents: 45000 });

    expect(res.status).toBe(404);
    expect(await paymentRows()).toEqual([]);
  });

  it('answers 502 and records nothing when the provider cannot open a checkout', async () => {
    useFake({ checkoutError: new Error('provider down') });

    const res = await start({ lotId: 'lot-a', amountCents: 45000 });

    expect(res.status).toBe(502);
    expect(await paymentRows()).toEqual([]);
  });
});
