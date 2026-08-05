import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import reactServerRenderer from '@astrojs/react/server.js';
import { getDb } from '../../src/server/db/client';
import {
  properties,
  owners,
  meetings,
  proxies,
} from '../../src/server/db/schema';
import { DEFAULT_SITE_SETTINGS } from '../../src/lib/types';
import ProxiesPage from '../../src/pages/proxies.astro';
import NotFoundPage from '../../src/pages/404.astro';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

const now = new Date();

beforeEach(async () => {
  const db = getDb(env);
  await db.delete(proxies);
  await db.delete(meetings);
  await db.delete(owners);
  await db.delete(properties);
});

async function makeContainer() {
  const container = await AstroContainer.create();
  container.addServerRenderer({
    renderer: reactServerRenderer,
    name: '@astrojs/react',
  });
  container.insertPageRoute('/404', NotFoundPage);
  return container;
}

function localsWith(officialMode: boolean, authContext: unknown) {
  return {
    site: { ...DEFAULT_SITE_SETTINGS, officialMode },
    authContext,
  } as unknown as App.Locals;
}

describe('/proxies', () => {
  it('renders the generic 404 when officialMode is off — even for a verified homeowner', async () => {
    const container = await makeContainer();
    const res = await container.renderToResponse(ProxiesPage, {
      request: new Request('http://localhost/proxies'),
      locals: localsWith(false, {
        userId: 'u1',
        role: 'homeowner',
        propertyIds: ['p1'],
      }),
    });
    const html = await res.text();
    expect(html).toContain('Page not found');
  });

  it('prompts an anonymous caller to sign in when the mode is on', async () => {
    const container = await makeContainer();
    const html = await container.renderToString(ProxiesPage, {
      request: new Request('http://localhost/proxies'),
      locals: localsWith(true, null),
    });
    expect(html).toContain('Sign in');
    expect(html).not.toContain('Grant a proxy');
  });

  it('renders the manager with the caller lots and upcoming occasions for a verified homeowner (positive control for the 404 test)', async () => {
    const db = getDb(env);
    await db.insert(properties).values({
      id: 'p1',
      address: '1 Oak St',
      addressNormalized: '1 oak st',
      voteWeight: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(owners).values({
      id: 'o1',
      propertyId: 'p1',
      fullName: 'Jane Doe',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(meetings).values({
      id: 'm1',
      body: 'member',
      kind: 'annual',
      date: '2099-01-01',
      title: 'Distant Annual Meeting',
      status: 'draft',
      visibility: 'homeowner',
      createdBy: 'b',
      createdAt: now,
      updatedAt: now,
    });
    const container = await makeContainer();
    const html = await container.renderToString(ProxiesPage, {
      request: new Request('http://localhost/proxies'),
      locals: localsWith(true, {
        userId: 'u1',
        role: 'homeowner',
        propertyIds: ['p1'],
      }),
    });
    expect(html).toContain('Grant a proxy');
    expect(html).toContain('1 Oak St');
    expect(html).toContain('Distant Annual Meeting');
  });
});
