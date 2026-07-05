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

const call = (path: string, next: () => Promise<Response>) =>
  (
    onRequest as never as (
      c: unknown,
      n: () => Promise<Response>,
    ) => Promise<Response>
  )(fakeContext(path), next);

describe('security headers', () => {
  it('sets baseline headers on a normal page response', async () => {
    const res = await call('/', async () => new Response('ok'));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe(
      'strict-origin-when-cross-origin',
    );
    expect(res.headers.get('permissions-policy')).toBeTruthy();
    // Enforced (not Report-Only) after the CSP audit confirmed no legitimate
    // resource is blocked.
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('calendar.google.com');
    // Cloudflare Web Analytics beacon (injected by the edge) is allowed.
    expect(csp).toContain('static.cloudflareinsights.com');
    expect(res.headers.get('content-security-policy-report-only')).toBeNull();
  });

  it('sets headers on the /admin redirect too', async () => {
    const res = await call('/admin', async () => new Response('ok'));
    expect([301, 302, 307, 308]).toContain(res.status);
    expect(res.headers.get('location')).toBe('/login');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
