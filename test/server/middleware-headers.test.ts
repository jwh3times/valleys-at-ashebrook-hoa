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

  it('authorizes every rendered script under the audited policy with a fresh nonce', async () => {
    const renderPage = async () =>
      new Response(
        '<!doctype html><html><head><script>window.inline = true;</script><script src="/app.js"></script></head></html>',
        {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy':
              "default-src *; script-src * 'unsafe-inline'; style-src 'nonce-stale'",
          },
        },
      );

    const first = await call('/', renderPage);
    const second = await call('/', renderPage);
    const firstPolicy = first.headers.get('content-security-policy') ?? '';
    const secondPolicy = second.headers.get('content-security-policy') ?? '';
    const firstNonce = /'nonce-([^']+)'/.exec(firstPolicy)?.[1];
    const secondNonce = /'nonce-([^']+)'/.exec(secondPolicy)?.[1];

    const firstScriptDirective = firstPolicy
      .split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('script-src'));
    expect(firstScriptDirective).not.toContain("'unsafe-inline'");
    expect(firstPolicy).toContain("frame-ancestors 'none'");
    expect(firstPolicy).toContain('calendar.google.com');
    expect(firstPolicy).not.toContain("'nonce-stale'");
    expect(firstNonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(secondNonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(secondNonce).not.toBe(firstNonce);

    const html = await first.text();
    expect(html.split(`nonce="${firstNonce}"`)).toHaveLength(3);
  });

  it('keeps script execution nonce-only when an HTML page lacks Astro policy', async () => {
    const res = await call(
      '/',
      async () =>
        new Response(
          '<!doctype html><html><script>window.ready = true;</script></html>',
          {
            headers: { 'content-type': 'text/html' },
          },
        ),
    );
    const policy = res.headers.get('content-security-policy') ?? '';
    const scriptDirective = policy
      .split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('script-src'));
    const nonce = /'nonce-([^']+)'/.exec(scriptDirective ?? '')?.[1];

    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(await res.text()).toContain(`nonce="${nonce}"`);
  });

  it('keeps one nonce when an HTML response passes through middleware twice', async () => {
    const inner = await call(
      '/missing',
      async () =>
        new Response(
          '<!doctype html><html><script>window.ready = true;</script></html>',
          {
            status: 404,
            headers: { 'content-type': 'text/html' },
          },
        ),
    );
    const outer = await call('/missing', async () => inner);
    const policy = outer.headers.get('content-security-policy') ?? '';
    const nonceSources = [...policy.matchAll(/'nonce-([^']+)'/g)];

    expect(outer.status).toBe(404);
    expect(nonceSources).toHaveLength(1);
    expect(await outer.text()).toContain(`nonce="${nonceSources[0]?.[1]}"`);
  });

  it('sets headers on the /admin redirect too', async () => {
    const res = await call('/admin', async () => new Response('ok'));
    expect([301, 302, 307, 308]).toContain(res.status);
    expect(res.headers.get('location')).toBe('/login');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
