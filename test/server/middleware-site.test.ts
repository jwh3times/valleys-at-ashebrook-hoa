import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { onRequest } from '../../src/middleware';

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
});
