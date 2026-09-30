import { env, applyD1Migrations } from 'cloudflare:test';
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';

// Don't make real Resend/Twilio calls from sign-up's email-verification step.
vi.mock('../../src/server/auth/senders', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
  sendSms: vi.fn().mockResolvedValue(undefined),
}));

import { createAuth, isGoogleSignInConfigured } from '../../src/server/auth';
import { sendEmail } from '../../src/server/auth/senders';
import { getAuthContext } from '../../src/server/authz/context';
import { associationDateIso } from '../../src/lib/format';
import { resetRoster, seedRoster } from './dual-fixtures';

/**
 * Individual Google sign-in (#415). Everything runs through the real Better
 * Auth handler against D1; only Google's token endpoint is stubbed, because it
 * is the one network call the redirect callback makes.
 */

const BASE = 'http://localhost:4321';
const googleEnv = {
  ...env,
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
};
const auth = () => createAuth(googleEnv, undefined, BASE);

type Claims = {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

const b64url = (value: unknown) =>
  btoa(JSON.stringify(value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** An unsigned ID token: the redirect flow trusts the TLS token response. */
function idToken(claims: Claims): string {
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: 'https://accounts.google.com',
    aud: googleEnv.GOOGLE_CLIENT_ID,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  })}.signature`;
}

const tokenRequests: URLSearchParams[] = [];

/** Google's token endpoint answers the code exchange with these claims. */
function googleAnswers(claims: Claims | { status: number }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith('https://oauth2.googleapis.com/token')) {
        throw new Error(`unexpected outbound fetch: ${url}`);
      }
      const request = input instanceof Request ? input : new Request(url, init);
      tokenRequests.push(new URLSearchParams(await request.text()));
      if ('status' in claims) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      return Response.json({
        access_token: 'google-access-token',
        refresh_token: 'google-refresh-token',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid email profile',
        id_token: idToken(claims),
      });
    }),
  );
}

function cookiesFrom(res: Response): string[] {
  return res.headers.getSetCookie().map((c) => c.split(';')[0]);
}

function sessionCookie(res: Response): string | undefined {
  return cookiesFrom(res).find(
    (c) => c.startsWith('better-auth.session_token=') && !c.endsWith('='),
  );
}

// Better Auth rate-limits sign-in and sign-up per client IP, so every request
// comes from its own documentation-range address (RFC 5737).
let requestCount = 0;
function clientIp(): string {
  const n = requestCount++;
  const nets = ['192.0.2', '198.51.100', '203.0.113'];
  return `${nets[Math.floor(n / 250) % 3]}.${(n % 250) + 1}`;
}

function post(path: string, body: unknown, cookie?: string) {
  return auth().handler(
    new Request(`${BASE}/api/auth/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: BASE,
        'cf-connecting-ip': clientIp(),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

function get(path: string, cookie?: string) {
  return auth().handler(
    new Request(`${BASE}/api/auth/${path}`, {
      headers: {
        'cf-connecting-ip': clientIp(),
        ...(cookie ? { cookie } : {}),
      },
      redirect: 'manual',
    }),
  );
}

/** Starts a redirect flow the way the login and account pages do. */
async function startFlow(
  path: 'sign-in/social' | 'link-social',
  cookie?: string,
) {
  const res = await post(
    path,
    path === 'sign-in/social'
      ? {
          provider: 'google',
          callbackURL: '/',
          newUserCallbackURL: '/verify-property',
          errorCallbackURL: '/login',
        }
      : {
          provider: 'google',
          callbackURL: '/account',
          errorCallbackURL: '/account',
        },
    cookie,
  );
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  const authorize = new URL(url);
  return {
    authorize,
    state: authorize.searchParams.get('state')!,
    cookie: [cookie, ...cookiesFrom(res)].filter(Boolean).join('; '),
  };
}

/** Google redirects back to the callback with a code (or an error). */
async function finishFlow(
  flow: { state: string; cookie: string },
  query = 'code=test-code',
) {
  return get(`callback/google?${query}&state=${flow.state}`, flow.cookie);
}

async function googleSignIn(claims: Claims) {
  googleAnswers(claims);
  return finishFlow(await startFlow('sign-in/social'));
}

function location(res: Response): URL {
  return new URL(res.headers.get('location')!, BASE);
}

async function scalar<T>(query: string, ...binds: unknown[]): Promise<T> {
  const row = await env.DATABASE.prepare(query)
    .bind(...binds)
    .first<{ v: T }>();
  return row!.v;
}

const userIdFor = (email: string) =>
  scalar<string | null>('SELECT id AS v FROM users WHERE email = ?', email);
const countUsers = (email: string) =>
  scalar<number>('SELECT count(*) AS v FROM users WHERE email = ?', email);
const providersFor = async (userId: string) =>
  (
    await env.DATABASE.prepare(
      'SELECT provider_id FROM accounts WHERE user_id = ? ORDER BY provider_id',
    )
      .bind(userId)
      .all<{ provider_id: string }>()
  ).results.map((r) => r.provider_id);

/** An existing, email-verified email/password Account, signed in. */
async function passwordUser(email: string, password = 'a-valid-password-123') {
  expect(
    (await post('sign-up/email', { email, password, name: 'Password User' }))
      .status,
  ).toBe(200);
  await env.DATABASE.prepare(
    'UPDATE users SET email_verified = 1 WHERE email = ?',
  )
    .bind(email)
    .run();
  const signedIn = await post('sign-in/email', { email, password });
  expect(signedIn.status).toBe(200);
  return { id: (await userIdFor(email))!, cookie: sessionCookie(signedIn)! };
}

async function contextFor(cookie: string) {
  return getAuthContext(
    new Request(`${BASE}/`, { headers: { cookie } }),
    env,
    associationDateIso(),
  );
}

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(() => {
  tokenRequests.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Google sign-in configuration', () => {
  it('is available only when both the client ID and secret are set', () => {
    expect(isGoogleSignInConfigured(googleEnv)).toBe(true);
    expect(isGoogleSignInConfigured(env)).toBe(false);
    expect(
      isGoogleSignInConfigured({ ...env, GOOGLE_CLIENT_ID: 'id-only' }),
    ).toBe(false);
  });

  it('keeps email/password working and reports Google unavailable when unconfigured', async () => {
    const unconfigured = createAuth({ ...env }, undefined, BASE);
    const res = await unconfigured.handler(
      new Request(`${BASE}/api/auth/sign-in/social`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: BASE,
          'cf-connecting-ip': clientIp(),
        },
        body: JSON.stringify({ provider: 'google', callbackURL: '/' }),
      }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe(
      'PROVIDER_NOT_FOUND',
    );

    const { cookie } = await passwordUser('unconfigured-google@example.com');
    expect(cookie).toBeTruthy();
  });

  it('requests identity scopes only, never Drive access', async () => {
    const { authorize } = await startFlow('sign-in/social');
    expect(authorize.origin + authorize.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(authorize.searchParams.get('scope')!.split(' ').sort()).toEqual([
      'email',
      'openid',
      'profile',
    ]);
    // Google would otherwise fold every scope this client was ever granted
    // into the personal login's token.
    expect(authorize.searchParams.get('include_granted_scopes')).toBeNull();
    expect(authorize.searchParams.get('prompt')).toBe('select_account');
  });

  it.each(['callbackURL', 'errorCallbackURL', 'newUserCallbackURL'])(
    'rejects an untrusted %s before redirecting to Google',
    async (field) => {
      const res = await post('sign-in/social', {
        provider: 'google',
        callbackURL: '/',
        [field]: 'https://attacker.example/',
      });
      expect(res.status).toBe(403);
    },
  );

  it.each([
    ['sign-in/social', 'scopes', ['https://www.googleapis.com/auth/drive']],
    ['sign-in/social', 'additionalParams', { include_granted_scopes: 'true' }],
  ] as const)(
    'refuses a %s request that widens the login with %s',
    async (path, field, value) => {
      const res = await post(path, {
        provider: 'google',
        callbackURL: '/',
        [field]: value,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe(
        'IDENTITY_SCOPES_ONLY',
      );
    },
  );

  it('refuses a link request that widens the login', async () => {
    const user = await passwordUser('link-widen@example.com');
    const res = await post(
      'link-social',
      {
        provider: 'google',
        callbackURL: '/account',
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      },
      user.cookie,
    );
    expect(res.status).toBe(400);
  });

  it('does not sign in with a bare ID token, even one Google signed', async () => {
    // A genuinely signed token whose key Google's JWKS endpoint serves, so the
    // only thing that can refuse it is the redirect-flow-only configuration.
    const keys = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey(
      'jwk',
      keys.publicKey,
    )) as JsonWebKey;
    const signingInput = `${b64url({ alg: 'RS256', typ: 'JWT', kid: 'test-kid' })}.${b64url(
      {
        iss: 'https://accounts.google.com',
        aud: googleEnv.GOOGLE_CLIENT_ID,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        sub: 'bare-token-sub',
        email: 'bare-token@example.com',
        email_verified: true,
      },
    )}`;
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        keys.privateKey,
        new TextEncoder().encode(signingInput),
      ),
    );
    const token = `${signingInput}.${btoa(String.fromCharCode(...signature))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          keys: [{ ...jwk, kid: 'test-kid', alg: 'RS256', use: 'sig' }],
        }),
      ),
    );

    const res = await post('sign-in/social', {
      provider: 'google',
      idToken: { token },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(sessionCookie(res)).toBeUndefined();
    expect(await countUsers('bare-token@example.com')).toBe(0);
  });
});

describe('signing in with Google', () => {
  it('registers a new Account and sends it to property verification', async () => {
    const email = 'new-google-user@example.com';
    const res = await googleSignIn({
      sub: 'google-sub-new',
      email,
      email_verified: true,
      name: 'New Google User',
    });

    expect(res.status).toBe(302);
    expect(location(res).pathname).toBe('/verify-property');
    expect(sessionCookie(res)).toBeTruthy();
    const userId = (await userIdFor(email))!;
    expect(await providersFor(userId)).toEqual(['google']);
    // The code exchange carried PKCE and this deployment's callback.
    expect(tokenRequests[0].get('code_verifier')).toBeTruthy();
    expect(tokenRequests[0].get('redirect_uri')).toBe(
      `${BASE}/api/auth/callback/google`,
    );
  });

  it('keeps the Google name and email but not the profile photo', async () => {
    const email = 'photo-free@example.com';
    await googleSignIn({
      sub: 'google-sub-photo',
      email,
      email_verified: true,
      name: 'Photo Free',
      picture: 'https://lh3.googleusercontent.com/a/example-photo',
    });
    expect(
      await env.DATABASE.prepare(
        'SELECT name, email, image FROM users WHERE email = ?',
      )
        .bind(email)
        .first(),
    ).toEqual({ name: 'Photo Free', email, image: null });
  });

  it('does not keep Google tokens after sign-in', async () => {
    const email = 'token-free@example.com';
    await googleSignIn({
      sub: 'google-sub-tokens',
      email,
      email_verified: true,
    });
    const row = await env.DATABASE.prepare(
      `SELECT access_token, refresh_token, id_token FROM accounts
       WHERE provider_id = 'google' AND account_id = ?`,
    )
      .bind('google-sub-tokens')
      .first();
    expect(row).toEqual({
      access_token: null,
      refresh_token: null,
      id_token: null,
    });
  });

  it('signs a returning Google user into the same Account', async () => {
    const email = 'returning-google@example.com';
    const claims = { sub: 'google-sub-returning', email, email_verified: true };
    await googleSignIn(claims);
    const firstId = await userIdFor(email);

    const res = await googleSignIn(claims);
    expect(res.status).toBe(302);
    expect(location(res).pathname).toBe('/');
    const session = await auth().api.getSession({
      headers: new Headers({ cookie: sessionCookie(res)! }),
    });
    expect(session?.user.id).toBe(firstId);
    expect(await countUsers(email)).toBe(1);
    // A returning sign-in rewrites the account row; still no tokens kept.
    expect(
      await env.DATABASE.prepare(
        `SELECT access_token, refresh_token, id_token FROM accounts
         WHERE provider_id = 'google' AND account_id = ?`,
      )
        .bind('google-sub-returning')
        .first(),
    ).toEqual({ access_token: null, refresh_token: null, id_token: null });
  });

  it('resolves the Google identity, not the email, on a returning sign-in', async () => {
    const email = 'changed-google-email@example.com';
    await googleSignIn({
      sub: 'google-sub-stable',
      email,
      email_verified: true,
    });
    const firstId = await userIdFor(email);

    const res = await googleSignIn({
      sub: 'google-sub-stable',
      email: 'renamed-google-email@example.com',
      email_verified: true,
    });
    const session = await auth().api.getSession({
      headers: new Headers({ cookie: sessionCookie(res)! }),
    });
    expect(session?.user.id).toBe(firstId);
    // No roster or Account contact is rewritten from provider claims.
    expect(session?.user.email).toBe(email);
  });

  it('does not silently merge a new Google identity into an Account with the same email', async () => {
    const email = 'collision@example.com';
    const existing = await passwordUser(email);

    const res = await googleSignIn({
      sub: 'google-sub-collision',
      email,
      email_verified: true,
    });

    expect(res.status).toBe(302);
    expect(location(res).pathname).toBe('/login');
    expect(location(res).searchParams.get('error')).toBe('account_not_linked');
    expect(sessionCookie(res)).toBeUndefined();
    expect(await providersFor(existing.id)).toEqual(['credential']);
    expect(await countUsers(email)).toBe(1);
  });

  it('creates nothing for a Google email Google has not verified', async () => {
    vi.mocked(sendEmail).mockClear();
    const email = 'unverified-google@example.com';
    const res = await googleSignIn({
      sub: 'google-sub-unverified',
      email,
      email_verified: false,
    });
    expect(location(res).pathname).toBe('/login');
    expect(location(res).searchParams.get('error')).toBe(
      'unable_to_get_user_info',
    );
    expect(sessionCookie(res)).toBeUndefined();
    // Not even an unverified user row with this Google identity attached —
    // that row is a takeover seed once the address's owner verifies it.
    expect(await countUsers(email)).toBe(0);
    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
  });

  it('answers an unverified Google email the same whether or not an Account uses it', async () => {
    const email = 'unverified-existing@example.com';
    const existing = await passwordUser(email);
    const res = await googleSignIn({
      sub: 'google-sub-unverified-existing',
      email,
      email_verified: false,
    });
    expect(location(res).searchParams.get('error')).toBe(
      'unable_to_get_user_info',
    );
    expect(await providersFor(existing.id)).toEqual(['credential']);
  });

  it('returns a cancelled consent to the login screen without an Account', async () => {
    googleAnswers({ sub: 'never-used', email: 'cancelled@example.com' });
    const flow = await startFlow('sign-in/social');
    const res = await finishFlow(flow, 'error=access_denied');

    expect(location(res).pathname).toBe('/login');
    expect(location(res).searchParams.get('error')).toBe('access_denied');
    expect(sessionCookie(res)).toBeUndefined();
    expect(tokenRequests).toHaveLength(0);
    expect(await countUsers('cancelled@example.com')).toBe(0);
  });

  it('rejects a replayed state on the login screen', async () => {
    googleAnswers({
      sub: 'google-sub-replay',
      email: 'replay@example.com',
      email_verified: true,
    });
    const flow = await startFlow('sign-in/social');
    expect((await finishFlow(flow)).status).toBe(302);

    const replay = await finishFlow(flow);
    expect(location(replay).pathname).toBe('/login');
    expect(location(replay).searchParams.get('error')).toBe('state_mismatch');
    expect(sessionCookie(replay)).toBeUndefined();
  });

  it('rejects a state that was never issued', async () => {
    const res = await finishFlow({ state: 'forged-state', cookie: '' });
    expect(location(res).pathname).toBe('/login');
    expect(location(res).searchParams.get('error')).toBeTruthy();
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('rejects a code Google refuses to exchange', async () => {
    googleAnswers({ status: 400 });
    const res = await finishFlow(await startFlow('sign-in/social'));
    expect(location(res).pathname).toBe('/login');
    expect(location(res).searchParams.get('error')).toBe('invalid_code');
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('rejects a Google identity with no email', async () => {
    const res = await googleSignIn({
      sub: 'google-sub-no-email',
      email_verified: true,
    });
    expect(location(res).pathname).toBe('/login');
    expect(location(res).searchParams.get('error')).toBe('email_not_found');
    expect(sessionCookie(res)).toBeUndefined();
  });
});

describe('linking Google to an existing Account', () => {
  it('links explicitly from a signed-in session without a second Account', async () => {
    const email = 'link-me@example.com';
    const user = await passwordUser(email);

    googleAnswers({ sub: 'google-sub-link', email, email_verified: true });
    const res = await finishFlow(await startFlow('link-social', user.cookie));

    expect(res.status).toBe(302);
    expect(location(res).pathname).toBe('/account');
    expect(location(res).searchParams.get('error')).toBeNull();
    expect(await providersFor(user.id)).toEqual(['credential', 'google']);
    expect(await countUsers(email)).toBe(1);

    // The linked identity now signs in to the same Account.
    const signIn = await googleSignIn({
      sub: 'google-sub-link',
      email,
      email_verified: true,
    });
    const session = await auth().api.getSession({
      headers: new Headers({ cookie: sessionCookie(signIn)! }),
    });
    expect(session?.user.id).toBe(user.id);
  });

  it('needs a signed-in session', async () => {
    const res = await post('link-social', {
      provider: 'google',
      callbackURL: '/account',
    });
    expect(res.status).toBe(401);
  });

  it('needs a recently started session', async () => {
    const user = await passwordUser('stale-session@example.com');
    // Sessions live in KV secondary storage, so age the session by moving the
    // clock past Better Auth's one-day freshness window rather than its row.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2 * 86_400_000 });
    try {
      const res = await post(
        'link-social',
        { provider: 'google', callbackURL: '/account' },
        user.cookie,
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe(
        'SESSION_NOT_FRESH',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a Google identity whose email differs from the Account email', async () => {
    const user = await passwordUser('link-mismatch@example.com');
    googleAnswers({
      sub: 'google-sub-mismatch',
      email: 'someone-else@example.com',
      email_verified: true,
    });
    const res = await finishFlow(await startFlow('link-social', user.cookie));

    expect(location(res).pathname).toBe('/account');
    expect(location(res).searchParams.get('error')).toBe(
      'email_does_not_match',
    );
    expect(await providersFor(user.id)).toEqual(['credential']);
  });

  it('refuses a Google identity whose email Google has not verified', async () => {
    const email = 'link-unverified@example.com';
    const user = await passwordUser(email);
    googleAnswers({ sub: 'google-sub-link-unv', email, email_verified: false });
    const res = await finishFlow(await startFlow('link-social', user.cookie));

    expect(location(res).searchParams.get('error')).toBe(
      'unable_to_get_user_info',
    );
    expect(await providersFor(user.id)).toEqual(['credential']);
  });

  it('refuses to move a Google identity already linked to another Account', async () => {
    await googleSignIn({
      sub: 'google-sub-taken',
      email: 'taken@example.com',
      email_verified: true,
    });
    const other = await passwordUser('taken-attempt@example.com');
    googleAnswers({
      sub: 'google-sub-taken',
      email: 'taken-attempt@example.com',
      email_verified: true,
    });
    const res = await finishFlow(await startFlow('link-social', other.cookie));

    expect(location(res).searchParams.get('error')).toBe(
      'account_already_linked_to_different_user',
    );
    expect(await providersFor(other.id)).toEqual(['credential']);
    const owner = (await userIdFor('taken@example.com'))!;
    expect(await providersFor(owner)).toEqual(['google']);
  });
});

describe('disconnecting Google', () => {
  async function linkedUser(email: string, sub: string) {
    const user = await passwordUser(email);
    googleAnswers({ sub, email, email_verified: true });
    await finishFlow(await startFlow('link-social', user.cookie));
    return user;
  }

  async function googleAccountRowId(userId: string) {
    return scalar<string>(
      `SELECT id AS v FROM accounts WHERE user_id = ? AND provider_id = 'google'`,
      userId,
    );
  }

  it('unlinks Google while password sign-in remains', async () => {
    const email = 'unlink-ok@example.com';
    const user = await linkedUser(email, 'google-sub-unlink-ok');
    const res = await post(
      'unlink-account',
      { accountId: await googleAccountRowId(user.id) },
      user.cookie,
    );
    expect(res.status).toBe(200);
    expect(await providersFor(user.id)).toEqual(['credential']);
    expect(
      (
        await post('sign-in/email', {
          email,
          password: 'a-valid-password-123',
        })
      ).status,
    ).toBe(200);
  });

  it('refuses to remove the only sign-in method', async () => {
    const email = 'google-only@example.com';
    const res = await googleSignIn({
      sub: 'google-sub-only',
      email,
      email_verified: true,
    });
    const userId = (await userIdFor(email))!;
    const unlink = await post(
      'unlink-account',
      { accountId: await googleAccountRowId(userId) },
      sessionCookie(res),
    );
    expect(unlink.status).toBe(400);
    expect(((await unlink.json()) as { code: string }).code).toBe(
      'FAILED_TO_UNLINK_LAST_ACCOUNT',
    );
    expect(await providersFor(userId)).toEqual(['google']);
  });

  it('lets a Google-only user set a password through reset, then disconnect', async () => {
    const email = 'google-then-password@example.com';
    const res = await googleSignIn({
      sub: 'google-sub-reset',
      email,
      email_verified: true,
    });
    const userId = (await userIdFor(email))!;

    vi.mocked(sendEmail).mockClear();
    expect(
      (
        await post('request-password-reset', {
          email,
          redirectTo: '/reset-password',
        })
      ).status,
    ).toBe(200);
    const resetEmail = vi
      .mocked(sendEmail)
      .mock.calls.find(([, , subject]) =>
        String(subject).startsWith('Reset your password'),
      );
    const callback = await auth().handler(
      new Request(String(resetEmail![3]).replace('Reset link: ', ''), {
        redirect: 'manual',
      }),
    );
    const token = location(callback).searchParams.get('token')!;
    const newPassword = 'a-fresh-password-789';
    expect((await post('reset-password', { token, newPassword })).status).toBe(
      200,
    );
    expect(
      (await post('sign-in/email', { email, password: newPassword })).status,
    ).toBe(200);

    const unlink = await post(
      'unlink-account',
      { accountId: await googleAccountRowId(userId) },
      sessionCookie(res),
    );
    expect(unlink.status).toBe(200);
    expect(await providersFor(userId)).toEqual(['credential']);
  });
});

describe('provider tokens stay server-side', () => {
  it.each(['get-access-token', 'refresh-token'])(
    'does not serve /%s',
    async (path) => {
      const res = await googleSignIn({
        sub: `google-sub-${path}`,
        email: `${path}@example.com`,
        email_verified: true,
      });
      const cookie = sessionCookie(res)!;
      const response = await post(path, { providerId: 'google' }, cookie);
      expect(response.status).toBe(404);
    },
  );

  it('does not serve /account-info', async () => {
    const res = await googleSignIn({
      sub: 'google-sub-account-info',
      email: 'account-info@example.com',
      email_verified: true,
    });
    const response = await get('account-info', sessionCookie(res));
    expect(response.status).toBe(404);
  });
});

describe('access for Google sessions', () => {
  beforeEach(async () => {
    await resetRoster();
  });

  it('grants nothing from a Google identity alone, even when its email is on the roster', async () => {
    const email = 'rostered-owner@example.com';
    await seedRoster({
      lots: [
        {
          id: 'lot-g1',
          owners: [{ id: 'person-g1', name: 'Rostered Owner', email }],
        },
      ],
    });
    const res = await googleSignIn({
      sub: 'google-sub-rostered',
      email,
      email_verified: true,
      name: 'Rostered Owner',
    });

    const ctx = await contextFor(sessionCookie(res)!);
    expect(ctx?.personId).toBeNull();
    expect(ctx?.contentTier).toBe('visitor');
    expect([...(ctx?.capabilities ?? [])]).toEqual([]);
    expect(ctx?.lotIds).toEqual([]);
  });

  it('derives current roster authority after Person Verification, and ends it with the Ownership', async () => {
    const email = 'verified-google-owner@example.com';
    await seedRoster({
      lots: [
        { id: 'lot-g2', owners: [{ id: 'person-g2', name: 'Verified Owner' }] },
      ],
    });
    const res = await googleSignIn({
      sub: 'google-sub-verified-owner',
      email,
      email_verified: true,
    });
    const cookie = sessionCookie(res)!;
    const accountId = (await userIdFor(email))!;

    // The existing Person Verification outcome: a verification and its link.
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        `INSERT INTO person_verifications (id, account_id, person_id, method, approver_account_id, reason, verified_at)
         VALUES ('gv-1', ?, 'person-g2', 'manual', ?, 'manual_board_decision', 1)`,
      ).bind(accountId, accountId),
      env.DATABASE.prepare(
        `INSERT INTO person_links (id, account_id, person_id, verification_id, started_at)
         VALUES ('gl-1', ?, 'person-g2', 'gv-1', 1)`,
      ).bind(accountId),
    ]);

    const linked = await contextFor(cookie);
    expect(linked?.personId).toBe('person-g2');
    expect(linked?.capabilities.has('member')).toBe(true);
    expect(linked?.capabilities.has('board')).toBe(false);
    expect(linked?.lotIds).toEqual(['lot-g2']);

    await env.DATABASE.prepare(
      `UPDATE ownerships SET end_day = '2020-01-02' WHERE id = 'person-g2-own'`,
    ).run();
    const ended = await contextFor(cookie);
    expect(ended?.capabilities.has('member')).toBe(false);
    expect(ended?.lotIds).toEqual([]);
  });

  it('keeps the Account and its Person Link when Google is linked', async () => {
    const email = 'linked-keeps-person@example.com';
    await seedRoster({
      lots: [
        { id: 'lot-g3', owners: [{ id: 'person-g3', name: 'Kept Owner' }] },
      ],
    });
    const user = await passwordUser(email);
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        `INSERT INTO person_verifications (id, account_id, person_id, method, approver_account_id, reason, verified_at)
         VALUES ('gv-3', ?, 'person-g3', 'manual', ?, 'manual_board_decision', 1)`,
      ).bind(user.id, user.id),
      env.DATABASE.prepare(
        `INSERT INTO person_links (id, account_id, person_id, verification_id, started_at)
         VALUES ('gl-3', ?, 'person-g3', 'gv-3', 1)`,
      ).bind(user.id),
    ]);

    googleAnswers({ sub: 'google-sub-keeps', email, email_verified: true });
    await finishFlow(await startFlow('link-social', user.cookie));
    const signIn = await googleSignIn({
      sub: 'google-sub-keeps',
      email,
      email_verified: true,
    });

    const ctx = await contextFor(sessionCookie(signIn)!);
    expect(ctx?.userId).toBe(user.id);
    expect(ctx?.personId).toBe('person-g3');
    expect(ctx?.lotIds).toEqual(['lot-g3']);
  });
});
