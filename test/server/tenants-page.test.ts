import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import reactServerRenderer from '@astrojs/react/server.js';
import TenantsPage from '../../src/pages/tenants.astro';
import NotFoundPage from '../../src/pages/404.astro';
import { DEFAULT_SITE_SETTINGS, type SiteSettings } from '../../src/lib/types';
import type { AuthContext } from '../../src/server/authz/guards';
import {
  resetTenancyWorld,
  seedLinkedAccount,
  seedTenancy,
} from './tenancy-fixtures';

// #294 slice 3 (spec decision 3): the owner's `/tenants` page. It sits outside
// `/homeowner/*` so it can answer 404 (ADR 0024's reason), and it renders only
// to a caller who holds a Lot. With a gate off it renders only what is on file,
// so it can still be ended or withdrawn (review decision, 2026-10-25).

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});
beforeEach(async () => {
  await resetTenancyWorld();
  await seedTenancy('ten', { scheduledEndDay: '2099-01-01' });
});

const flagsOn: SiteSettings = {
  ...DEFAULT_SITE_SETTINGS,
  officialMode: true,
  tenantAccessEnabled: true,
};

function caller(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'acct-owner',
    personId: 'owner',
    capabilities: new Set(['member']),
    lotIds: ['lot'],
    contentTier: 'homeowner',
    hasCurrentBoardTerm: false,
    ...overrides,
  };
}

async function render(
  authContext: AuthContext | null,
  site = flagsOn,
  url = 'http://localhost/tenants',
) {
  const container = await AstroContainer.create();
  container.addServerRenderer({
    renderer: reactServerRenderer,
    name: '@astrojs/react',
  });
  container.insertPageRoute('/404', NotFoundPage);
  return container.renderToResponse(TenantsPage, {
    request: new Request(url),
    locals: { site, authContext } as unknown as App.Locals,
  });
}

/** An open request on `lot`, and a refusal of an earlier one. */
async function seedRequests() {
  await env.DATABASE.prepare(
    `INSERT INTO tenancy_requests (id, lot_id, requested_by_account_id,
       requested_by_person_id, basis_ownership_id, kind, tenant_name, channel,
       contact_value, contact_normalized, scheduled_end_day, created_at)
     VALUES ('req', 'lot', 'acct-owner', 'owner', 'owner-lot-own', 'new',
       'Ned Next', 'email', 'ned@example.test', 'ned@example.test',
       '2099-01-01', 1)`,
  ).run();
  await env.DATABASE.prepare(
    `INSERT INTO tenancy_requests (id, lot_id, requested_by_account_id,
       requested_by_person_id, basis_ownership_id, kind, scheduled_end_day,
       status, created_at, decided_at, decided_by_account_id, refusal_reason)
     VALUES ('old', 'lot', 'acct-owner', 'owner', 'owner-lot-own', 'new',
       '2099-01-01', 'refused', 1, ?, 'board', 'No lease on file')`,
  )
    .bind(Date.now())
    .run();
}

describe('/tenants', () => {
  it('renders the list on the server, with only the masked contact', async () => {
    await seedRequests();
    const res = await render(caller());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const html = await res.text();
    expect(html).toContain('lot Ashebrook Lane');
    expect(html).toContain('Person tenant');
    expect(html).toContain('Current until 2099-01-01 · not yet signed in');
    expect(html).toContain('Awaiting the board · ***test · until 2099-01-01');
    expect(html).toContain('No lease on file');
    expect(html).not.toContain('ned@example.test');
    expect(html).toContain('Ask the board to approve a tenant');
    expect(html).toContain(
      'Re-invite tenant: Person tenant, lot Ashebrook Lane',
    );
  });

  it('confirms the action the page was reloaded after', async () => {
    const res = await render(
      caller(),
      flagsOn,
      'http://localhost/tenants?done=withdraw',
    );
    expect(await res.text()).toContain('Request withdrawn.');
  });

  it('with tenant access off, still shows what is on file so it can be ended, but takes no new request or renewal', async () => {
    const res = await render(caller(), {
      ...flagsOn,
      tenantAccessEnabled: false,
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Person tenant');
    expect(html).toContain('Tenant access is switched off.');
    expect(html).toContain('End tenancy: Person tenant, lot Ashebrook Lane');
    expect(html).not.toContain('Renew tenancy:');
    expect(html).not.toContain('Re-invite tenant:');
    expect(html).not.toContain('Ask the board to approve a tenant');
  });

  it('offers no Re-invite once the tenant has claimed', async () => {
    await seedLinkedAccount('acct-tenant', 'tenant');
    const html = await (await render(caller())).text();
    expect(html).toContain('signed in');
    expect(html).not.toContain('Re-invite tenant:');
  });

  it('is the 404 while officialMode is off, like every member surface', async () => {
    const res = await render(caller(), { ...flagsOn, officialMode: false });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('Person tenant');
  });

  it('with tenant access off and nothing on file, is the 404', async () => {
    await resetTenancyWorld();
    expect((await render(caller())).status).toBe(200);
    const res = await render(caller(), {
      ...flagsOn,
      tenantAccessEnabled: false,
    });
    expect(res.status).toBe(404);
  });

  it('is the 404 to a signed-out visitor, a tenant, and a board member who holds no Lot', async () => {
    for (const ctx of [
      null,
      caller({ capabilities: new Set(['tenant']), lotIds: [] }),
      caller({
        capabilities: new Set(['board']),
        lotIds: [],
        contentTier: 'board',
      }),
    ]) {
      const res = await render(ctx);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('Person tenant');
    }
  });
});
