import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import reactServerRenderer from '@astrojs/react/server.js';
import PaymentPage from '../../src/pages/lot-records/payments/[id].astro';
import NotFoundPage from '../../src/pages/404.astro';
import {
  truncateAll,
  seedProperty,
  seedLotAuthority,
  seedPerson,
} from './fixtures';
import { seedPayment } from './payments-fixtures';
import { DEFAULT_SITE_SETTINGS, type SiteSettings } from '../../src/lib/types';
import type { AuthContext } from '../../src/server/authz/guards';

/**
 * The page a homeowner returns to from the provider (ADR 0025, #542),
 * rendered through the Astro Container API inside the Workers runtime.
 *
 * It shows the payment's STORED status, so a homeowner who has just paid sees
 * "processing" until the provider confirms, and nothing in the address bar can
 * say otherwise. A payment the reader may not see is the generic 404, the same
 * as one that does not exist.
 */

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  // A consolidation link points at another party with RESTRICT, so it would
  // make the shared teardown's `DELETE FROM parties` fail.
  await env.DATABASE.prepare(
    'UPDATE parties SET consolidated_into_party_id = NULL',
  ).run();
  await truncateAll();
  await seedProperty('lot-a');
  await seedProperty('lot-b');
  await seedLotAuthority('payer-1', 'lot-a', { startDay: '2020-01-01' });
  await seedLotAuthority('neighbor-1', 'lot-b', { startDay: '2020-01-01' });
  // Created 2026-11-01, as every seeded payment is.
  await seedPayment({ id: 'pay-1', lotId: 'lot-a', amountCents: 45075 });
});

const flagsOn: SiteSettings = {
  ...DEFAULT_SITE_SETTINGS,
  officialMode: true,
  lotRecordsEnabled: true,
};

function caller(personId: string | null): AuthContext {
  return {
    userId: `account-${personId}`,
    personId,
    capabilities: new Set(['member']),
    lotIds: [],
    contentTier: 'homeowner',
    hasCurrentBoardTerm: false,
  };
}

async function render(
  id: string,
  authContext: AuthContext | null,
  { site = flagsOn, query = '' }: { site?: SiteSettings; query?: string } = {},
) {
  const container = await AstroContainer.create();
  container.addServerRenderer({
    renderer: reactServerRenderer,
    name: '@astrojs/react',
  });
  container.insertPageRoute('/404', NotFoundPage);
  const res = await container.renderToResponse(PaymentPage, {
    params: { id },
    request: new Request(`http://localhost/lot-records/payments/${id}${query}`),
    locals: { site, authContext } as unknown as App.Locals,
  });
  return { status: res.status, html: await res.text(), res };
}

async function setStatus(status: string) {
  await env.DATABASE.prepare('UPDATE payments SET status = ? WHERE id = ?')
    .bind(status, 'pay-1')
    .run();
}

describe('the payment a homeowner returns to', () => {
  it('shows a payment not yet confirmed as such, with its amount and Lot', async () => {
    const { status, html, res } = await render('pay-1', caller('payer-1'));

    expect(status).toBe(200);
    expect(html).toContain('Not confirmed yet');
    // A homeowner who left the provider's page unpaid lands here too, so it
    // must not tell them they have paid.
    expect(html).not.toContain('do not need to pay again');
    expect(html).toContain('$450.75');
    expect(html).toContain('lot-a Ashebrook Lane');
    expect(html).toContain('href="/lot-records"');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('never takes its status from the query string', async () => {
    const { html } = await render('pay-1', caller('payer-1'), {
      query: '?status=succeeded&redirect_status=succeeded',
    });

    expect(html).toContain('Not confirmed yet');
    expect(html).not.toContain('Received');
  });

  it.each([
    ['pending', 'Processing'],
    ['succeeded', 'Received'],
    ['failed', 'Did not go through'],
    ['canceled', 'Canceled'],
    ['expired', 'Canceled'],
  ])('describes a %s payment as %s', async (stored, shown) => {
    await setStatus(stored);
    const { html } = await render('pay-1', caller('payer-1'));
    expect(html).toContain(shown);
  });

  it('shows the payment to a co-owner, since the audience is the Lot', async () => {
    await seedLotAuthority('co-owner-1', 'lot-a', { startDay: '2020-01-01' });
    const { status, html } = await render('pay-1', caller('co-owner-1'));
    expect(status).toBe(200);
    expect(html).toContain('$450.75');
  });

  it('shows the payment to an account linked to a consolidated duplicate of the payer', async () => {
    await seedPerson('duplicate-1');
    await env.DATABASE.prepare(
      "UPDATE parties SET consolidated_into_party_id = 'payer-1' WHERE id = 'duplicate-1'",
    ).run();
    const { status } = await render('pay-1', caller('duplicate-1'));
    expect(status).toBe(200);
  });

  it('still renders with online payments switched off', async () => {
    const { status } = await render('pay-1', caller('payer-1'), {
      site: { ...flagsOn, onlinePaymentsEnabled: false },
    });
    expect(status).toBe(200);
  });

  it('asks an anonymous reader to sign in, without looking the payment up', async () => {
    const { status, html } = await render('no-such-payment', null);
    expect(status).toBe(200);
    expect(html).toContain('href="/login"');
    expect(html).not.toContain('$');
  });
});

describe('a payment the reader may not see is the generic 404', () => {
  it.each([
    ['someone else’s', 'pay-1', 'neighbor-1'],
    ['an unknown', 'no-such-payment', 'payer-1'],
    ['an unlinked reader’s', 'pay-1', null],
  ])('for %s payment', async (_, id, personId) => {
    const { status, html } = await render(id, caller(personId));
    expect(status).toBe(404);
    expect(html).not.toContain('$450.75');
  });

  it('for a payment made before the reader’s own period', async () => {
    // A buyer holds the Lot today but not on the day the seller paid.
    await seedLotAuthority('buyer-1', 'lot-a', { startDay: '2026-11-05' });
    const { status, html } = await render('pay-1', caller('buyer-1'));
    expect(status).toBe(404);
    expect(html).not.toContain('$450.75');
  });

  it.each([
    ['official mode is off', { ...flagsOn, officialMode: false }],
    ['lot records are off', { ...flagsOn, lotRecordsEnabled: false }],
  ])('while %s', async (_, site) => {
    const { status } = await render('pay-1', caller('payer-1'), { site });
    expect(status).toBe(404);
  });
});
