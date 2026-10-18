// Google's OAuth endpoints and the Drive connection's request (#290 slice 2).
// The connection asks for exactly `openid email drive.file`: identity, so the
// site knows which Google account it holds, and the one non-sensitive Drive
// scope. Every broader Drive scope is restricted (ADR 0027).

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_SCOPES = ['openid', 'email', DRIVE_FILE_SCOPE] as const;

export const OAUTH_COOKIE = '__Host-drive_oauth';
export const OAUTH_COOKIE_MAX_AGE_SECONDS = 600;

/** The callback URL on whichever origin the request came in on. */
export function callbackUrl(request: Request): string {
  return new URL('/api/admin/drive/callback', request.url).toString();
}
