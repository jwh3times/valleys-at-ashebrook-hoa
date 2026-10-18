import type { APIRoute } from 'astro';
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { GET as status } from '../../src/pages/api/admin/drive/status';
import { GET as connect } from '../../src/pages/api/admin/drive/connect';
import { GET as callback } from '../../src/pages/api/admin/drive/callback';
import { POST as disconnect } from '../../src/pages/api/admin/drive/disconnect';
import {
  sealRefreshToken,
  unsealRefreshToken,
} from '../../src/server/drive/seal';
import { users } from '../../src/server/db/auth-schema';
import { getDb } from '../../src/server/db/client';
import { callerContext } from './caller-context';

// #290 slice 2 (spec 2026-10-18 decision 1, ADR 0027): the association's
// Google Drive connection — its feature gate, status, connect, callback,
// disconnect and keepalive. Google is a stubbed fetch throughout; no test
// calls Google.

const SYSADMIN = 'sysadmin-1';
const BOARD = 'board-1';

// Synthetic values only: a 32-byte key of 0x07 bytes, and fake client values.
const DRIVE_SECRETS = {
  DRIVE_CLIENT_ID: 'drive-client.apps.googleusercontent.example',
  DRIVE_CLIENT_SECRET: 'drive-client-secret-not-real',
  DRIVE_PICKER_API_KEY: 'picker-key-not-real',
  DRIVE_PROJECT_NUMBER: '100000000001',
  DRIVE_TOKEN_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
};
type DriveSecret = keyof typeof DRIVE_SECRETS;
const mutableEnv = env as unknown as Record<string, unknown>;

/** The URL a stubbed fetch was called with. */
const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
/** A stubbed fetch's form body, as Google's endpoints receive it. */
const formOf = (init?: RequestInit) =>
  new URLSearchParams(typeof init?.body === 'string' ? init.body : '');

function configure(overrides: Partial<Record<DriveSecret, string>> = {}) {
  Object.assign(mutableEnv, DRIVE_SECRETS, overrides);
}
function unconfigure() {
  for (const k of Object.keys(DRIVE_SECRETS)) delete mutableEnv[k];
}

function systemAdmin() {
  const ctx = callerContext(SYSADMIN, 'board', []);
  ctx.capabilities.add('systemAdmin');
  return { authContext: ctx };
}
const boardAdmin = () => ({ authContext: callerContext(BOARD, 'board', []) });

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  const now = new Date();
  await getDb(env)
    .insert(users)
    .values(
      [SYSADMIN, BOARD].map((id) => ({
        id,
        name: id === SYSADMIN ? 'Sys Admin' : 'Board Admin',
        email: `${id}@example.test`,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      })),
    );
});

afterEach(async () => {
  unconfigure();
  vi.restoreAllMocks();
  await env.DATABASE.exec('DELETE FROM drive_connection');
  await env.DATABASE.exec('DELETE FROM cutover_settings');
});

async function freezeWrites() {
  await env.DATABASE.exec(
    "INSERT INTO cutover_settings (key, value, updated_at) VALUES ('write_freeze', 'on', 1)",
  );
}

function get(
  handler: APIRoute,
  path: string,
  locals: object,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handler({
    request: new Request(`http://localhost/api/admin/drive/${path}`, {
      headers,
    }),
    locals,
    url: new URL(`http://localhost/api/admin/drive/${path}`),
  } as never) as Promise<Response>;
}

async function seedConnection(
  overrides: Partial<Record<string, string | number | null>> = {},
) {
  const row = {
    id: 1,
    status: 'connected',
    google_sub: 'google-sub-1',
    google_email: 'association@example.test',
    refresh_token_sealed: 'v1.sealed.placeholder',
    key_version: 1,
    granted_scope: 'openid email https://www.googleapis.com/auth/drive.file',
    connected_by: SYSADMIN,
    connected_at: 1_700_000_000_000,
    last_used_at: null,
    last_refreshed_at: null,
    broken_at: null,
    broken_reason: null,
    revision: 1,
    ...overrides,
  };
  const cols = Object.keys(row);
  await env.DATABASE.prepare(
    `INSERT INTO drive_connection (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
  )
    .bind(...Object.values(row))
    .run();
}

describe('the Drive feature gate', () => {
  it('answers 404 while the feature is not configured', async () => {
    expect((await get(status, 'status', systemAdmin())).status).toBe(404);
  });

  it.each(Object.keys(DRIVE_SECRETS) as DriveSecret[])(
    'answers 404 while %s is missing',
    async (missing) => {
      configure();
      delete mutableEnv[missing];
      expect((await get(status, 'status', systemAdmin())).status).toBe(404);
    },
  );

  it('answers 404 while DRIVE_TOKEN_KEY is not 32 bytes', async () => {
    configure({ DRIVE_TOKEN_KEY: btoa('too short') });
    expect((await get(status, 'status', systemAdmin())).status).toBe(404);
  });
});

describe('GET /api/admin/drive/status', () => {
  it('reports no connection, and who may manage one', async () => {
    configure();
    const asSysadmin = await get(status, 'status', systemAdmin());
    expect(await asSysadmin.json()).toEqual({
      configured: true,
      status: 'none',
      canManage: true,
    });
    const asBoard = await get(status, 'status', boardAdmin());
    expect(await asBoard.json()).toMatchObject({
      status: 'none',
      canManage: false,
    });
  });

  it('describes a connection without ever returning its credential', async () => {
    configure();
    await seedConnection();
    const res = await get(status, 'status', boardAdmin());
    const text = await res.text();
    expect(text).not.toContain('sealed');
    expect(JSON.parse(text)).toEqual({
      configured: true,
      status: 'connected',
      canManage: false,
      googleEmail: 'association@example.test',
      connectedBy: SYSADMIN,
      connectedByName: 'Sys Admin',
      connectedAt: 1_700_000_000_000,
      lastUsedAt: null,
      lastRefreshedAt: null,
      brokenAt: null,
    });
  });

  it('refuses a caller without Board Access', async () => {
    configure();
    const res = await get(status, 'status', {
      authContext: callerContext('h', 'homeowner', []),
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/admin/drive/connect', () => {
  it('sends a System Administrator to Google with a drive.file request', async () => {
    configure();
    const res = await get(connect, 'connect', systemAdmin());
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get('location')!);
    expect(to.origin + to.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    const q = to.searchParams;
    expect(q.get('client_id')).toBe(DRIVE_SECRETS.DRIVE_CLIENT_ID);
    expect(q.get('redirect_uri')).toBe(
      'http://localhost/api/admin/drive/callback',
    );
    expect(q.get('response_type')).toBe('code');
    expect(q.get('scope')).toBe(
      'openid email https://www.googleapis.com/auth/drive.file',
    );
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('prompt')).toBe('consent select_account');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it('sets a short-lived, HttpOnly state cookie that names no secret', async () => {
    configure();
    const res = await get(connect, 'connect', systemAdmin());
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^__Host-drive_oauth=/);
    for (const attr of [
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
      'Path=/',
      'Max-Age=600',
    ])
      expect(cookie).toContain(attr);
    expect(cookie).not.toContain(DRIVE_SECRETS.DRIVE_CLIENT_SECRET);
  });

  it('refuses a board admin who is not a System Administrator', async () => {
    configure();
    expect((await get(connect, 'connect', boardAdmin())).status).toBe(403);
  });

  it('answers 404 while the feature is not configured', async () => {
    expect((await get(connect, 'connect', systemAdmin())).status).toBe(404);
  });

  it('is frozen during a write freeze, although it is a GET', async () => {
    configure();
    await freezeWrites();
    expect((await get(connect, 'connect', systemAdmin())).status).toBe(503);
  });

  it('refuses to connect over a working connection unless asked to reconnect', async () => {
    configure();
    await seedConnection();
    expect((await get(connect, 'connect', systemAdmin())).status).toBe(409);
    expect(
      (await get(connect, 'connect?reconnect=1', systemAdmin())).status,
    ).toBe(302);
  });

  it('lets a broken connection be reconnected', async () => {
    configure();
    await seedConnection({
      status: 'broken',
      refresh_token_sealed: null,
      broken_at: 1_700_000_100_000,
      broken_reason: 'invalid_grant',
    });
    expect((await get(connect, 'connect', systemAdmin())).status).toBe(302);
  });
});

describe('GET /api/admin/drive/callback', () => {
  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

  /** A fake id_token; the callback reads claims from Google's own response. */
  function idToken(sub: string, email: string) {
    const part = (o: object) =>
      btoa(JSON.stringify(o))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    return `${part({ alg: 'none' })}.${part({ sub, email, email_verified: true })}.sig`;
  }

  interface GoogleReply {
    sub?: string;
    email?: string;
    scope?: string;
    refreshToken?: string | null;
    tokenStatus?: number;
  }

  /** Stub Google's token and revoke endpoints; returns the calls made. */
  function stubGoogle(reply: GoogleReply = {}) {
    const calls: { url: string; body: URLSearchParams }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        const body = formOf(init);
        calls.push({ url, body });
        if (url === 'https://oauth2.googleapis.com/token') {
          if (reply.tokenStatus && reply.tokenStatus !== 200)
            return Response.json(
              { error: 'invalid_grant' },
              { status: reply.tokenStatus },
            );
          return Response.json({
            access_token: 'new-access-token',
            ...(reply.refreshToken === null
              ? {}
              : { refresh_token: reply.refreshToken ?? 'new-refresh-token' }),
            expires_in: 3599,
            token_type: 'Bearer',
            scope:
              reply.scope ??
              `openid https://www.googleapis.com/auth/userinfo.email ${DRIVE_SCOPE}`,
            id_token: idToken(
              reply.sub ?? 'google-sub-1',
              reply.email ?? 'association@example.test',
            ),
          });
        }
        if (url === 'https://oauth2.googleapis.com/revoke')
          return new Response(null, { status: 200 });
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );
    return calls;
  }

  /** Start a connect as `locals`, returning what the browser carries back. */
  async function begin(path = 'connect', locals = systemAdmin()) {
    const res = await get(connect, path, locals);
    const location = new URL(res.headers.get('location')!);
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    return { state: location.searchParams.get('state')!, cookie };
  }

  function finish(
    state: string,
    cookie: string,
    locals: object = systemAdmin(),
    extra = 'code=auth-code',
  ) {
    return get(callback, `callback?${extra}&state=${state}`, locals, {
      cookie,
    });
  }

  const outcome = (res: Response) =>
    new URL(res.headers.get('location')!, 'http://localhost').searchParams.get(
      'drive',
    );

  async function connectionRow() {
    return env.DATABASE.prepare('SELECT * FROM drive_connection').first<{
      status: string;
      google_sub: string;
      google_email: string;
      refresh_token_sealed: string | null;
      key_version: number;
      connected_by: string;
      revision: number;
      broken_at: number | null;
    }>();
  }

  async function history() {
    const { results } = await env.DATABASE.prepare(
      "SELECT old_value, new_value, acting_account_id FROM setting_changes WHERE key = 'drive_connection' ORDER BY recorded_at, rowid",
    ).all();
    return results;
  }

  afterEach(async () => {
    vi.unstubAllGlobals();
    await env.DATABASE.exec(
      "DELETE FROM setting_changes WHERE key = 'drive_connection'",
    );
  });

  it('stores a sealed credential for the account Google returned, and records it', async () => {
    configure();
    const { state, cookie } = await begin();
    const calls = stubGoogle();

    const res = await finish(state, cookie);
    expect(res.status).toBe(302);
    expect(outcome(res)).toBe('connected');
    expect(res.headers.get('set-cookie')).toMatch(
      /^__Host-drive_oauth=; .*Max-Age=0/,
    );

    const exchange = calls.find((c) => c.url.endsWith('/token'))!;
    expect(exchange.body.get('grant_type')).toBe('authorization_code');
    expect(exchange.body.get('code')).toBe('auth-code');
    expect(exchange.body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(exchange.body.get('redirect_uri')).toBe(
      'http://localhost/api/admin/drive/callback',
    );

    const row = await connectionRow();
    expect(row).toMatchObject({
      status: 'connected',
      google_sub: 'google-sub-1',
      google_email: 'association@example.test',
      connected_by: SYSADMIN,
      revision: 1,
    });
    expect(
      await unsealRefreshToken(
        DRIVE_SECRETS.DRIVE_TOKEN_KEY,
        row!.refresh_token_sealed!,
        { googleSub: 'google-sub-1', keyVersion: row!.key_version },
      ),
    ).toBe('new-refresh-token');
    expect(await history()).toEqual([
      {
        old_value: 'none',
        new_value: 'connected',
        acting_account_id: SYSADMIN,
      },
    ]);
  });

  it('refuses a callback whose state does not match the cookie', async () => {
    configure();
    const { cookie } = await begin();
    const calls = stubGoogle();
    const res = await finish('some-other-state', cookie);
    expect(outcome(res)).toBe('expired');
    expect(calls).toEqual([]);
    expect(await connectionRow()).toBeNull();
  });

  it('refuses a callback finished by a different Account than started it', async () => {
    configure();
    const { state, cookie } = await begin();
    const calls = stubGoogle();
    const other = callerContext('sysadmin-2', 'board', []);
    other.capabilities.add('systemAdmin');
    const res = await finish(state, cookie, { authContext: other });
    expect(outcome(res)).toBe('expired');
    expect(calls).toEqual([]);
  });

  it('reports a cancelled consent without calling Google', async () => {
    configure();
    const { state, cookie } = await begin();
    const calls = stubGoogle();
    const res = await finish(
      state,
      cookie,
      systemAdmin(),
      'error=access_denied',
    );
    expect(outcome(res)).toBe('cancelled');
    expect(calls).toEqual([]);
  });

  it('refuses a grant without drive.file, and revokes it', async () => {
    configure();
    const { state, cookie } = await begin();
    const calls = stubGoogle({
      scope: 'openid https://www.googleapis.com/auth/userinfo.email',
    });
    const res = await finish(state, cookie);
    expect(outcome(res)).toBe('drive-not-granted');
    expect(await connectionRow()).toBeNull();
    const revoke = calls.find((c) => c.url.endsWith('/revoke'));
    expect(revoke?.body.get('token')).toBe('new-refresh-token');
  });

  it('refuses a grant that carries no refresh token, and revokes it', async () => {
    configure();
    const { state, cookie } = await begin();
    const calls = stubGoogle({ refreshToken: null });
    const res = await finish(state, cookie);
    expect(outcome(res)).toBe('no-refresh-token');
    expect(await connectionRow()).toBeNull();
    expect(
      calls.find((c) => c.url.endsWith('/revoke'))?.body.get('token'),
    ).toBe('new-access-token');
  });

  it('refuses to reconnect a different Google account, and revokes that one', async () => {
    configure();
    await seedConnection({
      status: 'broken',
      refresh_token_sealed: null,
      broken_at: 1_700_000_100_000,
      broken_reason: 'invalid_grant',
    });
    const { state, cookie } = await begin();
    const calls = stubGoogle({
      sub: 'google-sub-OTHER',
      email: 'someone@example.test',
    });
    const res = await finish(state, cookie);
    expect(outcome(res)).toBe('wrong-account');
    expect(await connectionRow()).toMatchObject({
      status: 'broken',
      google_sub: 'google-sub-1',
    });
    expect(calls.some((c) => c.url.endsWith('/revoke'))).toBe(true);
  });

  it('never revokes a refused grant from the connected account itself', async () => {
    // Google's revocation covers everything the account granted the project,
    // so revoking this token would also kill the connection already stored.
    configure();
    await seedConnection();
    const { state, cookie } = await begin('connect?reconnect=1');
    const calls = stubGoogle({
      scope: 'openid https://www.googleapis.com/auth/userinfo.email',
    });
    const res = await finish(state, cookie);
    expect(outcome(res)).toBe('drive-not-granted');
    expect(calls.some((c) => c.url.endsWith('/revoke'))).toBe(false);
    expect(await connectionRow()).toMatchObject({
      status: 'connected',
      refresh_token_sealed: 'v1.sealed.placeholder',
    });
  });

  it('reconnects a broken connection to the same account', async () => {
    configure();
    await seedConnection({
      status: 'broken',
      refresh_token_sealed: null,
      broken_at: 1_700_000_100_000,
      broken_reason: 'invalid_grant',
      revision: 4,
    });
    const { state, cookie } = await begin();
    stubGoogle();
    const res = await finish(state, cookie);
    expect(outcome(res)).toBe('connected');
    expect(await connectionRow()).toMatchObject({
      status: 'connected',
      broken_at: null,
      revision: 5,
    });
    expect(await history()).toEqual([
      {
        old_value: 'broken',
        new_value: 'connected',
        acting_account_id: SYSADMIN,
      },
    ]);
  });

  it('loses cleanly to a connection written while Google was asked', async () => {
    configure();
    const { state, cookie } = await begin();
    const calls = stubGoogle();
    // Another System Administrator's connect lands first.
    await seedConnection({ connected_by: 'sysadmin-2' });
    const res = await finish(state, cookie);
    expect(outcome(res)).toBe('conflict');
    expect(await connectionRow()).toMatchObject({ connected_by: 'sysadmin-2' });
    expect(await history()).toEqual([]);
    // Same account as the winner: revoking would kill its connection too.
    expect(calls.some((c) => c.url.endsWith('/revoke'))).toBe(false);
  });

  it('loses cleanly to a reconnect that finished first', async () => {
    configure();
    await seedConnection({
      status: 'broken',
      refresh_token_sealed: null,
      broken_at: 1_700_000_100_000,
      broken_reason: 'invalid_grant',
      revision: 4,
    });
    const { state, cookie } = await begin();
    // Another System Administrator's reconnect lands first.
    await env.DATABASE.exec(
      "UPDATE drive_connection SET status = 'connected', refresh_token_sealed = 'v1.winner.token', broken_at = NULL, broken_reason = NULL, connected_by = 'sysadmin-2', revision = 5",
    );
    const calls = stubGoogle();
    const res = await finish(state, cookie);
    expect(outcome(res)).toBe('conflict');
    expect(await connectionRow()).toMatchObject({
      refresh_token_sealed: 'v1.winner.token',
      connected_by: 'sysadmin-2',
      revision: 5,
    });
    expect(await history()).toEqual([]);
    expect(calls.some((c) => c.url.endsWith('/revoke'))).toBe(false);
  });

  it('is frozen during a write freeze', async () => {
    configure();
    const { state, cookie } = await begin();
    await freezeWrites();
    const calls = stubGoogle();
    expect((await finish(state, cookie)).status).toBe(503);
    expect(calls).toEqual([]);
  });

  it('refuses a board admin who is not a System Administrator', async () => {
    configure();
    const { state, cookie } = await begin();
    expect((await finish(state, cookie, boardAdmin())).status).toBe(403);
  });
});

describe('POST /api/admin/drive/disconnect', () => {
  function post(locals: object = systemAdmin()) {
    return disconnect({
      request: new Request('http://localhost/api/admin/drive/disconnect', {
        method: 'POST',
      }),
      locals,
    } as never) as Promise<Response>;
  }

  function stubRevoke(ok: boolean) {
    const tokens: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (urlOf(input) !== 'https://oauth2.googleapis.com/revoke')
          throw new Error(`unexpected fetch to ${urlOf(input)}`);
        tokens.push(formOf(init).get('token') ?? '');
        return new Response(null, { status: ok ? 200 : 400 });
      }),
    );
    return tokens;
  }

  async function seedSealed() {
    await seedConnection({
      refresh_token_sealed: await sealRefreshToken(
        DRIVE_SECRETS.DRIVE_TOKEN_KEY,
        'stored-refresh-token',
        { googleSub: 'google-sub-1', keyVersion: 1 },
      ),
    });
  }

  async function drive() {
    return env.DATABASE.prepare('SELECT status FROM drive_connection').first();
  }
  async function history() {
    const { results } = await env.DATABASE.prepare(
      "SELECT old_value, new_value, acting_account_id FROM setting_changes WHERE key = 'drive_connection'",
    ).all();
    return results;
  }

  afterEach(async () => {
    vi.unstubAllGlobals();
    await env.DATABASE.exec(
      "DELETE FROM setting_changes WHERE key = 'drive_connection'",
    );
  });

  it('revokes the stored credential at Google and deletes it', async () => {
    configure();
    await seedSealed();
    const revoked = stubRevoke(true);
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revokeFailed: false });
    expect(revoked).toEqual(['stored-refresh-token']);
    expect(await drive()).toBeNull();
    expect(await history()).toEqual([
      {
        old_value: 'connected',
        new_value: 'none',
        acting_account_id: SYSADMIN,
      },
    ]);
  });

  it('deletes the credential even when Google refuses the revoke, and says so', async () => {
    configure();
    await seedSealed();
    stubRevoke(false);
    const res = await post();
    expect(await res.json()).toEqual({ revokeFailed: true });
    expect(await drive()).toBeNull();
  });

  it('removes a broken connection without calling Google', async () => {
    configure();
    await seedConnection({
      status: 'broken',
      refresh_token_sealed: null,
      broken_at: 1_700_000_100_000,
      broken_reason: 'invalid_grant',
    });
    const revoked = stubRevoke(true);
    expect(await (await post()).json()).toEqual({ revokeFailed: false });
    expect(revoked).toEqual([]);
    expect(await drive()).toBeNull();
    expect(await history()).toEqual([
      { old_value: 'broken', new_value: 'none', acting_account_id: SYSADMIN },
    ]);
  });

  it('keeps working during a write freeze', async () => {
    configure();
    await seedSealed();
    await freezeWrites();
    stubRevoke(true);
    expect((await post()).status).toBe(200);
    expect(await drive()).toBeNull();
  });

  it('answers 204 and records nothing when there is no connection', async () => {
    configure();
    stubRevoke(true);
    expect((await post()).status).toBe(204);
    expect(await history()).toEqual([]);
  });

  it('refuses a board admin who is not a System Administrator', async () => {
    configure();
    await seedSealed();
    expect((await post(boardAdmin())).status).toBe(403);
    expect(await drive()).not.toBeNull();
  });
});
