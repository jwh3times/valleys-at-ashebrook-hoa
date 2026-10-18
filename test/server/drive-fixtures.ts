import { env } from 'cloudflare:test';
import { vi } from 'vitest';
import { sealRefreshToken } from '../../src/server/drive/seal';
import { callerContext } from './caller-context';

// Shared set-up for the Drive import tests (#290 slice 3): the five secrets,
// a stored connection, callers, and a stubbed Google. Synthetic values only.

export const DRIVE_KEY = btoa(
  String.fromCharCode(...new Uint8Array(32).fill(7)),
);
export const DRIVE_SECRETS = {
  DRIVE_CLIENT_ID: 'drive-client.apps.googleusercontent.example',
  DRIVE_CLIENT_SECRET: 'drive-client-secret-not-real',
  DRIVE_PICKER_API_KEY: 'picker-key-not-real',
  DRIVE_PROJECT_NUMBER: '100000000001',
  DRIVE_TOKEN_KEY: DRIVE_KEY,
};

const mutableEnv = env as unknown as Record<string, unknown>;
export const configureDrive = () => Object.assign(mutableEnv, DRIVE_SECRETS);
export const unconfigureDrive = () => {
  for (const k of Object.keys(DRIVE_SECRETS)) delete mutableEnv[k];
};

export const ASSOCIATION_SUB = 'google-sub-1';

export async function seedDriveConnection(
  status: 'connected' | 'broken' = 'connected',
) {
  const sealed =
    status === 'connected'
      ? await sealRefreshToken(DRIVE_KEY, 'stored-refresh-token', {
          googleSub: ASSOCIATION_SUB,
          keyVersion: 1,
        })
      : null;
  await env.DATABASE.prepare(
    `INSERT INTO drive_connection (id, status, google_sub, google_email, refresh_token_sealed, key_version, granted_scope, connected_by, connected_at, broken_at, broken_reason)
     VALUES (1, ?, ?, 'association@example.test', ?, 1, 'openid email drive.file', 'sysadmin-1', 1, ?, ?)`,
  )
    .bind(
      status,
      ASSOCIATION_SUB,
      sealed,
      status === 'broken' ? 2 : null,
      status === 'broken' ? 'invalid_grant' : null,
    )
    .run();
}

export const boardCaller = (userId = 'board-1') => ({
  authContext: callerContext(userId, 'board', []),
});

/** The URL a stubbed fetch was called with. */
export const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

export interface DriveFileStub {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  trashed?: boolean;
  canDownload?: boolean;
  /** What `files.get?alt=media` or `files.export` returns. */
  content?: string | Uint8Array<ArrayBuffer> | (() => ReadableStream);
  /** Make the content request answer this error instead. */
  contentError?: { status: number; reason: string };
  /** Make metadata answer this error instead. */
  error?: { status: number; reason: string };
}

export interface GoogleStubOptions {
  files?: DriveFileStub[];
  /** The token endpoint's answer when the server refreshes. */
  token?: { status: number; body: object };
  /** Runs when the server refreshes, before Google answers. */
  onToken?: () => Promise<void>;
}

/**
 * Stub Google: the token endpoint, Drive `files.get` (metadata and
 * `alt=media`) and `files.export`. Returns every call made, so a test can
 * assert what was (and wasn't) asked of Google.
 */
export function stubGoogleDrive(options: GoogleStubOptions = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const files = new Map((options.files ?? []).map((f) => [f.id, f]));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      calls.push({ url, init });
      if (url === 'https://oauth2.googleapis.com/token') {
        await options.onToken?.();
        const t = options.token ?? {
          status: 200,
          body: { access_token: 'server-access-token', expires_in: 3599 },
        };
        return Response.json(t.body, { status: t.status });
      }
      const m =
        /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?]+)(\/export)?\??(.*)$/.exec(
          url,
        );
      if (!m) throw new Error(`unexpected fetch to ${url}`);
      const file = files.get(decodeURIComponent(m[1]));
      const params = new URLSearchParams(m[3]);
      if (!file || file.error) {
        const err = file?.error ?? { status: 404, reason: 'notFound' };
        return Response.json(
          { error: { code: err.status, errors: [{ reason: err.reason }] } },
          { status: err.status },
        );
      }
      if (m[2] || params.get('alt') === 'media') {
        if (file.contentError)
          return Response.json(
            {
              error: {
                code: file.contentError.status,
                errors: [{ reason: file.contentError.reason }],
              },
            },
            { status: file.contentError.status },
          );
        if (typeof file.content === 'function')
          return new Response(file.content(), { status: 200 });
        const body =
          typeof file.content === 'string'
            ? new TextEncoder().encode(file.content)
            : (file.content ?? new TextEncoder().encode(`bytes of ${file.id}`));
        return new Response(body, { status: 200 });
      }
      return Response.json({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime ?? '2026-10-01T12:00:00.000Z',
        ...(file.size ? { size: file.size } : {}),
        trashed: file.trashed ?? false,
        capabilities: { canDownload: file.canDownload ?? true },
      });
    }),
  );
  return calls;
}
