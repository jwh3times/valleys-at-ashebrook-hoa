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
  it('sets baseline headers on a normal response', async () => {
    const res = await call('/', async () => new Response('ok'));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe(
      'strict-origin-when-cross-origin',
    );
    expect(res.headers.get('permissions-policy')).toBeTruthy();
    // Enforced, never Report-Only.
    expect(res.headers.get('content-security-policy-report-only')).toBeNull();
  });

  /**
   * The page Content-Security-Policy belongs to Astro (`security.csp` in
   * astro.config.mjs), because only it can hash the inline scripts it
   * generates. Middleware fills the gap for everything Astro did not render,
   * and must never overwrite what it did.
   */
  describe('content-security-policy ownership', () => {
    it('leaves a policy Astro already set alone', async () => {
      const astroPolicy =
        "default-src 'self'; script-src 'self' 'sha256-abc123='";
      const res = await call(
        '/',
        async () =>
          new Response('<html></html>', {
            headers: {
              'content-type': 'text/html',
              'content-security-policy': astroPolicy,
            },
          }),
      );
      // Overwriting this is the one change that would turn dropping
      // 'unsafe-inline' into an outage: the hashes would be gone and every
      // inline script blocked.
      expect(res.headers.get('content-security-policy')).toBe(astroPolicy);
    });

    it('gives a non-page response the strict policy', async () => {
      const res = await call(
        '/api/anything',
        async () =>
          new Response('{}', {
            headers: { 'content-type': 'application/json' },
          }),
      );
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
    });

    it('never puts default-src on an HTML response it has to fall back for', async () => {
      // A page that somehow arrived without Astro's policy still needs to
      // render: `default-src 'none'` would blank it, and any `script-src`
      // written here would lack the hashes and block the page's own scripts.
      const res = await call(
        '/',
        async () =>
          new Response('<html></html>', {
            headers: { 'content-type': 'text/html' },
          }),
      );
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).not.toContain('default-src');
      expect(csp).not.toContain('script-src');
      expect(csp).not.toContain('style-src');
      // It still constrains everything else.
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain('calendar.google.com');
    });
  });

  it('sets headers on the /admin redirect too', async () => {
    const res = await call('/admin', async () => new Response('ok'));
    expect([301, 302, 307, 308]).toContain(res.status);
    expect(res.headers.get('location')).toBe('/login');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
