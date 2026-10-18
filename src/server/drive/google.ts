import { DRIVE_FILE_SCOPE, GOOGLE_REVOKE_URL, GOOGLE_TOKEN_URL } from './oauth';
import type { DriveConfig } from './config';

// Calls to Google's OAuth endpoints for the Drive connection (#290 slice 2).
// Every call goes through the global fetch, which tests stub; nothing here
// logs a token.

export interface GrantedTokens {
  accessToken: string;
  refreshToken: string | null;
  scope: string[];
  googleSub: string;
  googleEmail: string;
}

export class GoogleTokenError extends Error {
  constructor(
    readonly status: number,
    /** Google's `error` field, such as `invalid_grant`, or null. */
    readonly code: string | null,
  ) {
    super(
      `Google token endpoint answered ${status}${code ? ` (${code})` : ''}`,
    );
    this.name = 'GoogleTokenError';
  }

  /** The refresh token or client is gone for good: the connection is broken. */
  get isPermanent(): boolean {
    return this.code === 'invalid_grant' || this.code === 'deleted_client';
  }
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';

async function tokenRequest(form: Record<string, string>) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok)
    throw new GoogleTokenError(
      res.status,
      typeof body.error === 'string' ? body.error : null,
    );
  return body;
}

/**
 * The `sub` and `email` claims of an id_token. The token came straight from
 * Google's token endpoint over TLS, so OpenID Connect lets the client trust it
 * without checking the signature (Core §3.1.3.7).
 */
function idTokenClaims(idToken: unknown): { sub: string; email: string } {
  if (typeof idToken !== 'string') throw new Error('Google sent no id_token');
  const payload = idToken.split('.')[1] ?? '';
  const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const claims = JSON.parse(
    atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)),
  ) as { sub?: unknown; email?: unknown };
  if (typeof claims.sub !== 'string' || typeof claims.email !== 'string')
    throw new Error('Google id_token lacks sub or email');
  return { sub: claims.sub, email: claims.email };
}

export async function exchangeCode(
  config: DriveConfig,
  input: { code: string; codeVerifier: string; redirectUri: string },
): Promise<GrantedTokens> {
  const body = await tokenRequest({
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const { sub, email } = idTokenClaims(body.id_token);
  return {
    accessToken: text(body.access_token),
    refreshToken:
      typeof body.refresh_token === 'string' ? body.refresh_token : null,
    scope: typeof body.scope === 'string' ? body.scope.split(' ') : [],
    googleSub: sub,
    googleEmail: email,
  };
}

/** Mint a fresh access token from the stored refresh token. */
export async function refreshAccessToken(
  config: DriveConfig,
  refreshToken: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const body = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  return {
    accessToken: text(body.access_token),
    expiresIn: Number(body.expires_in ?? 0),
  };
}

/**
 * Revoke a token at Google. Revocation is project-wide for the account: it
 * removes everything that account granted to every client in the Cloud
 * project. Returns whether Google accepted it; never throws.
 */
export async function revokeToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const grantsDriveFile = (scope: string[]) =>
  scope.includes(DRIVE_FILE_SCOPE);
