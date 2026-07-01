import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { onRequest } from '../../src/middleware';
import { getDb } from '../../src/server/db/client';
import { settings } from '../../src/server/db/schema';
import { DEFAULT_SITE_SETTINGS } from '../../src/lib/types';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

function ctx(path: string) {
  const url = new URL(`http://localhost${path}`);
  const locals: Record<string, unknown> = {};
  return {
    request: new Request(url),
    url,
    locals,
    redirect: (loc: string, status = 302) =>
      new Response(null, { status, headers: { location: loc } }),
  } as never;
}

describe('middleware site locals', () => {
  it('populates locals.site with defaults (official mode off) for a page request', async () => {
    const c = ctx('/about');
    await onRequest(c, async () => new Response('ok'));
    // @ts-expect-error test shape
    expect(c.locals.site.officialMode).toBe(false);
  });

  it('still populates locals.site for /api requests (defaults, no extra DB read)', async () => {
    const c = ctx('/api/content/site');
    await onRequest(c, async () => new Response('ok'));
    // @ts-expect-error test shape
    expect(c.locals.site).toBeDefined();
    // @ts-expect-error test shape
    expect(c.locals.site.officialMode).toBe(false);
  });

  it('reflects a seeded officialMode on page requests but not on /api requests', async () => {
    const value = JSON.stringify({
      ...DEFAULT_SITE_SETTINGS,
      officialMode: true,
    });
    await getDb(env)
      .insert(settings)
      .values({ key: 'site', value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      });

    const page = ctx('/about');
    await onRequest(page, async () => new Response('ok'));
    // @ts-expect-error test shape
    expect(page.locals.site.officialMode).toBe(true);

    const api = ctx('/api/content/site');
    await onRequest(api, async () => new Response('ok'));
    // @ts-expect-error test shape
    expect(api.locals.site.officialMode).toBe(false);
  });
});
