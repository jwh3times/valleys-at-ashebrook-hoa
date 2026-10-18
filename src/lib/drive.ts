// Admin-panel client for the association's Google Drive connection (#290
// slice 2). Separate from lib/admin.ts so the Site Settings and Documents
// panels can show the connection without depending on each other's mocks.

export type DriveConnectionState = 'none' | 'connected' | 'broken';

export interface DriveStatus {
  configured: true;
  status: DriveConnectionState;
  /** Whether this caller (a System Administrator) may connect or disconnect. */
  canManage: boolean;
  googleEmail?: string;
  connectedBy?: string;
  connectedByName?: string | null;
  connectedAt?: number;
  lastUsedAt?: number | null;
  lastRefreshedAt?: number | null;
  brokenAt?: number | null;
}

/** The connection's status, or null while the Drive import isn't configured. */
export async function fetchDriveStatus(): Promise<DriveStatus | null> {
  const res = await fetch('/api/admin/drive/status');
  if (res.status === 404) return null;
  if (!res.ok)
    throw new Error(
      (await res.text()) || `Load Drive status failed: ${res.status}`,
    );
  return (await res.json()) as DriveStatus;
}

export async function disconnectDrive(): Promise<{ revokeFailed: boolean }> {
  const res = await fetch('/api/admin/drive/disconnect', { method: 'POST' });
  if (res.status === 204) return { revokeFailed: false };
  if (!res.ok)
    throw new Error((await res.text()) || `Disconnect failed: ${res.status}`);
  return (await res.json()) as { revokeFailed: boolean };
}

/** Connect and Reconnect are browser navigations through Google's consent. */
export const driveConnectHref = (reconnect: boolean) =>
  reconnect
    ? '/api/admin/drive/connect?reconnect=1'
    : '/api/admin/drive/connect';

/** What the callback's `?drive=` outcome means, in the board's words. */
export const DRIVE_OUTCOME_MESSAGES: Record<string, string> = {
  connected: 'Google Drive is connected.',
  cancelled: "Connecting Google Drive was cancelled on Google's screen.",
  expired:
    'That connection attempt expired or was started by someone else. Start again.',
  'google-error': "Google didn't complete the connection. Try again.",
  'drive-not-granted':
    "Google didn't grant access to Google Drive. Connect again and tick “See, edit, create and delete only the specific Google Drive files that you use with this app”.",
  'no-refresh-token':
    "Google didn't return a lasting credential. Connect again; if it repeats, remove the app from the Google account's third-party connections first.",
  'wrong-account':
    'This connection belongs to a different Google account. Disconnect it first to connect another account.',
  'save-failed': "The site couldn't save the connection. Try again.",
  conflict:
    'The connection changed while Google was asked. Check its status below and try again if needed.',
};
