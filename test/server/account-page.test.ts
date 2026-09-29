// The /account page (#415): a signed-in Account's own sign-in methods,
// rendered through the Astro Container API inside the Workers runtime so the
// page's `env` and Better Auth session reads are the real ones.
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import reactServerRenderer from '@astrojs/react/server.js';

vi.mock('../../src/server/auth/senders', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  sendSms: vi.fn().mockResolvedValue(undefined),
}));

import AccountPage from '../../src/pages/account.astro';
import { createAuth } from '../../src/server/auth';
import { callerContext } from './caller-context';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

async function makeContainer() {
  const container = await AstroContainer.create();
  container.addServerRenderer({
    renderer: reactServerRenderer,
    name: '@astrojs/react',
  });
  return container;
}

async function signedInPasswordUser(email: string) {
  const auth = createAuth(env);
  const post = (path: string, body: unknown) =>
    auth.handler(
      new Request(`http://localhost/api/auth/${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '192.0.2.90',
        },
        body: JSON.stringify(body),
      }),
    );
  const password = 'a-valid-password-123';
  await post('sign-up/email', { email, password, name: 'Account Page' });
  await env.DATABASE.prepare(
    'UPDATE users SET email_verified = 1 WHERE email = ?',
  )
    .bind(email)
    .run();
  const res = await post('sign-in/email', { email, password });
  const { user } = (await res.json()) as { user: { id: string } };
  return {
    id: user.id,
    cookie: res.headers.getSetCookie()[0].split(';')[0],
  };
}

describe('account page', () => {
  it('sends a signed-out visitor to sign in', async () => {
    const container = await makeContainer();
    const res = await container.renderToResponse(AccountPage, {
      request: new Request('http://localhost/account'),
      locals: {} as App.Locals,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it("lists the signed-in Account's own sign-in methods", async () => {
    const email = 'account-page@example.com';
    const user = await signedInPasswordUser(email);
    const container = await makeContainer();
    const res = await container.renderToResponse(AccountPage, {
      request: new Request('http://localhost/account', {
        headers: { cookie: user.cookie },
      }),
      locals: {
        authContext: callerContext(user.id, 'visitor', []),
      } as App.Locals,
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`Signed in as ${email}`);
    // The sign-in methods island is mounted (client-only, so it has no SSR
    // body), and nothing on the page carries a provider token.
    expect(html).toContain('&quot;SignInMethods&quot;');
    expect(html).not.toMatch(/access_?token|refresh_?token/i);
    // The shared header offers the page to a signed-in caller.
    expect(html).toContain('href="/account"');
  });
});
