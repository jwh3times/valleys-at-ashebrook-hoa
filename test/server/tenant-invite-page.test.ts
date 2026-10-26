import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import reactServerRenderer from '@astrojs/react/server.js';
import TenantInvitePage from '../../src/pages/tenant-invite.astro';
import NotFoundPage from '../../src/pages/404.astro';
import { DEFAULT_SITE_SETTINGS, type SiteSettings } from '../../src/lib/types';
import type { AuthContext } from '../../src/server/authz/guards';
import {
  generateInvitationToken,
  hashInvitationToken,
} from '../../src/server/roster/tenancy-invitation';
import { resetTenancyWorld, seedTenancy } from './tenancy-fixtures';

// #294 slice 4 (spec decision 4): the page the invitation link opens. It only
// displays, because mail scanners prefetch links: the POST to
// /api/verify/tenant-claim is the only thing that consumes an invitation.

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const DAY_MS = 86_400_000;
let token: string;

beforeEach(async () => {
  await resetTenancyWorld();
  await env.DATABASE.prepare(
    `UPDATE lots SET address = '12 Example Lane' WHERE id = 'lot'`,
  ).run();
  await seedTenancy('ten');
  await env.DATABASE.prepare(
    `INSERT INTO contact_methods (id, party_id, party_kind, channel, value,
       value_normalized, created_at, updated_at)
     VALUES ('cm', 'tenant', 'person', 'email', 'tess@example.test',
       'tess@example.test', 1, 1)`,
  ).run();
  token = generateInvitationToken();
  await env.DATABASE.prepare(
    `INSERT INTO tenancy_invitations (id, tenancy_id, contact_method_id,
       channel, token_hash, expires_at, created_at)
     VALUES ('inv', 'ten', 'cm', 'email', ?, ?, ?)`,
  )
    .bind(
      await hashInvitationToken(token, env.BETTER_AUTH_SECRET),
      Date.now() + 13 * DAY_MS,
      Date.now() - DAY_MS,
    )
    .run();
});

const flagsOn: SiteSettings = {
  ...DEFAULT_SITE_SETTINGS,
  officialMode: true,
  tenantAccessEnabled: true,
};

const visitor: AuthContext = {
  userId: 'acct-tess',
  personId: null,
  capabilities: new Set(),
  lotIds: [],
  contentTier: 'visitor',
  hasCurrentBoardTerm: false,
};

async function render(
  authContext: AuthContext | null,
  query: string,
  site = flagsOn,
) {
  const container = await AstroContainer.create();
  container.addServerRenderer({
    renderer: reactServerRenderer,
    name: '@astrojs/react',
  });
  container.insertPageRoute('/404', NotFoundPage);
  return container.renderToResponse(TenantInvitePage, {
    request: new Request(`http://localhost/tenant-invite${query}`),
    locals: { site, authContext } as unknown as App.Locals,
  });
}

async function consumed(): Promise<unknown> {
  const row = await env.DATABASE.prepare(
    `SELECT consumed_at FROM tenancy_invitations WHERE id = 'inv'`,
  ).first<{ consumed_at: number | null }>();
  return row!.consumed_at;
}

describe('/tenant-invite', () => {
  it("shows a signed-in visitor the Lot's address and a Claim button, without consuming the invitation", async () => {
    const res = await render(visitor, `?token=${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('12 Example Lane');
    expect(html).toMatch(/<button[^>]*>\s*Claim/);
    expect(await consumed()).toBeNull();
  });

  it('sends a signed-out visitor to sign in or register with the invitation kept, showing no address', async () => {
    const res = await render(null, `?token=${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const next = encodeURIComponent(`/tenant-invite?token=${token}`);
    expect(html).toContain(`href="/login?next=${next}"`);
    expect(html).toContain(`href="/register?next=${next}"`);
    expect(html).not.toContain('12 Example Lane');
    expect(await consumed()).toBeNull();
  });

  it('says the link is not valid, offering no claim, for an unknown, malformed or expired token', async () => {
    await env.DATABASE.prepare(
      `UPDATE tenancy_invitations SET expires_at = created_at + 1`,
    ).run();
    for (const query of [
      `?token=${generateInvitationToken()}`,
      '?token=short',
      '',
      `?token=${token}`,
    ]) {
      const res = await render(visitor, query);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/not valid/i);
      expect(html).not.toMatch(/<button[^>]*>\s*Claim/);
      expect(html).not.toContain('12 Example Lane');
    }
  });

  it('is the 404 while either gate is off', async () => {
    for (const site of [
      { ...flagsOn, officialMode: false },
      { ...flagsOn, tenantAccessEnabled: false },
    ]) {
      const res = await render(visitor, `?token=${token}`, site);
      expect(res.status).toBe(404);
    }
  });

  it('is never cached and never sends its token on as a referrer', async () => {
    const res = await render(visitor, `?token=${token}`);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
