import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { driveKeepalive } from '../../src/server/drive/keepalive';
import { sealRefreshToken } from '../../src/server/drive/seal';

// #290 slice 2 (spec decision 1, "Keepalive and the broken state"): the daily
// job refreshes the stored token so neither it nor the OAuth client reaches
// Google's six-month inactivity limit, and records a dead token as broken.

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ROTATED_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const DRIVE_SECRETS = {
  DRIVE_CLIENT_ID: 'drive-client.apps.googleusercontent.example',
  DRIVE_CLIENT_SECRET: 'drive-client-secret-not-real',
  DRIVE_PICKER_API_KEY: 'picker-key-not-real',
  DRIVE_PROJECT_NUMBER: '100000000001',
  DRIVE_TOKEN_KEY: KEY,
};
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
const configure = (overrides: Record<string, string> = {}) =>
  Object.assign(mutableEnv, DRIVE_SECRETS, overrides);

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

afterEach(async () => {
  for (const k of Object.keys(DRIVE_SECRETS)) delete mutableEnv[k];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await env.DATABASE.exec('DELETE FROM drive_connection');
  await env.DATABASE.exec(
    "DELETE FROM setting_changes WHERE key = 'drive_connection'",
  );
});

async function seedConnected(revision = 1) {
  const sealed = await sealRefreshToken(KEY, 'stored-refresh-token', {
    googleSub: 'google-sub-1',
    keyVersion: 1,
  });
  await env.DATABASE.prepare(
    `INSERT INTO drive_connection (id, status, google_sub, google_email, refresh_token_sealed, key_version, granted_scope, connected_by, connected_at, revision)
     VALUES (1, 'connected', 'google-sub-1', 'association@example.test', ?, 1, 'openid email drive.file', 'sysadmin-1', 1, ?)`,
  )
    .bind(sealed, revision)
    .run();
}

/** Stub Google's token endpoint; `onRefresh` may act before it answers. */
function stubRefresh(
  answer: { status: number; body: object },
  onRefresh?: () => Promise<void>,
) {
  const forms: URLSearchParams[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (urlOf(input) !== 'https://oauth2.googleapis.com/token')
        throw new Error(`unexpected fetch to ${urlOf(input)}`);
      forms.push(formOf(init));
      await onRefresh?.();
      return Response.json(answer.body, { status: answer.status });
    }),
  );
  return forms;
}

const ok = { status: 200, body: { access_token: 'fresh', expires_in: 3599 } };
const dead = { status: 400, body: { error: 'invalid_grant' } };

async function row() {
  return env.DATABASE.prepare('SELECT * FROM drive_connection').first<{
    status: string;
    refresh_token_sealed: string | null;
    last_refreshed_at: number | null;
    broken_at: number | null;
    broken_reason: string | null;
    revision: number;
  }>();
}
async function history() {
  const { results } = await env.DATABASE.prepare(
    "SELECT old_value, new_value, acting_account_id FROM setting_changes WHERE key = 'drive_connection'",
  ).all();
  return results;
}

describe('the Drive keepalive', () => {
  it('skips, without calling Google, while the feature is not configured', async () => {
    await seedConnected();
    const forms = stubRefresh(ok);
    expect(await driveKeepalive(env)).toBe('skipped');
    expect(forms).toEqual([]);
  });

  it('skips when there is no working connection', async () => {
    configure();
    const forms = stubRefresh(ok);
    expect(await driveKeepalive(env)).toBe('skipped');
    expect(forms).toEqual([]);
  });

  it('refreshes the stored token and records when', async () => {
    configure();
    await seedConnected();
    const forms = stubRefresh(ok);
    expect(await driveKeepalive(env)).toBe('refreshed');
    expect(forms[0].get('grant_type')).toBe('refresh_token');
    expect(forms[0].get('refresh_token')).toBe('stored-refresh-token');
    const after = await row();
    expect(after?.last_refreshed_at).toBeGreaterThan(0);
    expect(after?.revision).toBe(1);
    expect(await history()).toEqual([]);
  });

  it('marks the connection broken when Google says the grant is gone', async () => {
    configure();
    await seedConnected();
    stubRefresh(dead);
    expect(await driveKeepalive(env)).toBe('broken');
    expect(await row()).toMatchObject({
      status: 'broken',
      refresh_token_sealed: null,
      broken_reason: 'invalid_grant',
      revision: 2,
    });
    expect((await row())?.broken_at).toBeGreaterThan(0);
    expect(await history()).toEqual([
      {
        old_value: 'connected',
        new_value: 'broken',
        acting_account_id: 'scheduled-job',
      },
    ]);
  });

  it('marks the connection broken when the key that sealed it is gone', async () => {
    configure({ DRIVE_TOKEN_KEY: ROTATED_KEY });
    await seedConnected();
    const forms = stubRefresh(ok);
    expect(await driveKeepalive(env)).toBe('broken');
    expect(forms).toEqual([]);
    expect(await row()).toMatchObject({
      status: 'broken',
      broken_reason: 'key-unavailable',
    });
  });

  it('fails the run on a transient error, leaving the connection alone', async () => {
    configure();
    await seedConnected();
    stubRefresh({ status: 503, body: { error: 'backend_error' } });
    await expect(driveKeepalive(env)).rejects.toThrow();
    expect(await row()).toMatchObject({ status: 'connected', revision: 1 });
    expect(await history()).toEqual([]);
  });

  it('never breaks a new connection made after a disconnect while Google answered', async () => {
    // Disconnect deletes the row, so the next connect starts again at
    // revision 1: revision alone cannot tell the old connection from the new.
    configure();
    await seedConnected();
    const newer = await sealRefreshToken(KEY, 'newer-refresh-token', {
      googleSub: 'google-sub-1',
      keyVersion: 1,
    });
    stubRefresh(dead, async () => {
      await env.DATABASE.exec('DELETE FROM drive_connection');
      await env.DATABASE.prepare(
        `INSERT INTO drive_connection (id, status, google_sub, google_email, refresh_token_sealed, key_version, granted_scope, connected_by, connected_at)
         VALUES (1, 'connected', 'google-sub-1', 'association@example.test', ?, 1, 'openid email drive.file', 'sysadmin-1', 2)`,
      )
        .bind(newer)
        .run();
    });
    expect(await driveKeepalive(env)).toBe('skipped');
    expect(await row()).toMatchObject({
      status: 'connected',
      refresh_token_sealed: newer,
      revision: 1,
    });
    expect(await history()).toEqual([]);
  });

  it('never overwrites a connection that changed while Google answered', async () => {
    configure();
    await seedConnected();
    // A System Administrator reconnects while the refresh is in flight.
    stubRefresh(dead, async () => {
      await env.DATABASE.exec(
        "UPDATE drive_connection SET refresh_token_sealed = 'v1.newer.token', revision = 2",
      );
    });
    expect(await driveKeepalive(env)).toBe('skipped');
    expect(await row()).toMatchObject({
      status: 'connected',
      refresh_token_sealed: 'v1.newer.token',
      revision: 2,
    });
    expect(await history()).toEqual([]);
  });
});
