import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { onRequest } from '../../src/middleware';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

function fakeContext(path: string) {
  const url = new URL(`http://localhost${path}`);
  return {
    request: new Request(url),
    url,
    locals: {} as App.Locals,
    redirect: (p: string, status?: number) =>
      new Response(null, { status: status ?? 302, headers: { location: p } }),
  };
}

describe('route protection', () => {
  it('redirects an anonymous visitor away from /admin to /login', async () => {
    const res = await (
      onRequest as never as (
        c: unknown,
        n: () => Promise<Response>,
      ) => Promise<Response>
    )(fakeContext('/admin'), async () => new Response('ok'));
    expect([301, 302, 307, 308]).toContain(res.status);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('allows an anonymous visitor through a public path', async () => {
    const res = await (
      onRequest as never as (
        c: unknown,
        n: () => Promise<Response>,
      ) => Promise<Response>
    )(fakeContext('/'), async () => new Response('ok'));
    expect(res.status).toBe(200);
  });
});
