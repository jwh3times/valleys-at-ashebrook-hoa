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

// ---------------------------------------------------------------------------
// Import (#290 slice 3).

export interface PickerSession {
  accessToken: string;
  expiresAt: number;
  developerKey: string;
  appId: string;
}

export async function startPickerSession(): Promise<PickerSession> {
  const res = await fetch('/api/admin/drive/picker-session', {
    method: 'POST',
  });
  if (!res.ok)
    throw new Error(
      (await res.text()) || `Opening Google Drive failed: ${res.status}`,
    );
  return (await res.json()) as PickerSession;
}

export interface DocumentRef {
  id: string;
  title: string;
}

export interface PreviewFile {
  fileId: string;
  name: string;
  plan: 'export' | 'download' | 'refused';
  refusal?: string;
  storedAs?: string;
  filename?: string;
  title?: string;
  modifiedTime?: string;
  newerVersionOf?: DocumentRef[];
  nearDuplicates?: DocumentRef[];
}

export async function previewDriveFiles(
  fileIds: string[],
): Promise<PreviewFile[]> {
  const res = await fetch('/api/admin/drive/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileIds }),
  });
  if (!res.ok)
    throw new Error((await res.text()) || `Preview failed: ${res.status}`);
  return ((await res.json()) as { files: PreviewFile[] }).files;
}

export interface ImportRequest {
  fileId: string;
  expectedModifiedTime: string;
  title: string;
  category: string;
  visibility: string;
  confirmDuplicate: boolean;
}

export type ImportResult =
  | { kind: 'imported'; id: string }
  | { kind: 'near-duplicate'; similar: DocumentRef[] }
  | { kind: 'failed'; message: string };

const IMPORT_REFUSALS: Record<string, string> = {
  'changed-since-preview':
    'This file changed in Drive after the preview. Preview it again.',
  'not-picked':
    'The site no longer has access to this file. Pick it again in Google Drive.',
  'drive-duplicate': 'This version of the file was already imported.',
};

/** Import one picked file, turning each refusal into a sentence. */
export async function importDriveFile(
  request: ImportRequest,
): Promise<ImportResult> {
  const res = await fetch('/api/admin/drive/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const text = await res.text();
  if (res.status === 201)
    return { kind: 'imported', id: (JSON.parse(text) as { id: string }).id };
  let body: {
    error?: string;
    warning?: string;
    refusal?: string;
    existing?: DocumentRef;
    similar?: DocumentRef[];
  } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    // Plain text: the message below.
  }
  if (body.warning === 'near-duplicate')
    return { kind: 'near-duplicate', similar: body.similar ?? [] };
  if (body.error === 'exact-duplicate')
    return {
      kind: 'failed',
      message: `An identical file is already in the library${body.existing ? `: "${body.existing.title}"` : ''}.`,
    };
  if (body.error === 'refused' && body.refusal)
    return { kind: 'failed', message: body.refusal };
  if (body.error && IMPORT_REFUSALS[body.error])
    return { kind: 'failed', message: IMPORT_REFUSALS[body.error] };
  return { kind: 'failed', message: text || `Import failed: ${res.status}` };
}
