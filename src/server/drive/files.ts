import { DOCUMENT_TYPES } from '../../lib/document-types';
import { MAX_DOCUMENT_BYTES } from '../documents/store';

// Reading picked files from the association's Drive (#290 slice 3, spec
// decisions 3-4): what each item is, what the library would store it as, and
// fetching its bytes within a size cap. Every call is a plain fetch with the
// server-minted access token, which tests stub.

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

/** Files per Picker batch (spec decision 2). */
export const MAX_FILES_PER_BATCH = 10;

/** Google's `files.export` limit (spec decision 4). */
export const MAX_EXPORT_BYTES = 10 * 1024 * 1024;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size: number | null;
  trashed: boolean;
  canDownload: boolean;
}

export type DriveFileResult =
  | { ok: true; file: DriveFile }
  | { ok: false; status: number; reason: string | null };

async function driveError(res: Response) {
  const body = (await res.json().catch(() => ({}))) as {
    error?: { errors?: { reason?: unknown }[] };
  };
  const reason = body.error?.errors?.[0]?.reason;
  return {
    ok: false as const,
    status: res.status,
    reason: typeof reason === 'string' ? reason : null,
  };
}

export async function getDriveFile(
  accessToken: string,
  fileId: string,
): Promise<DriveFileResult> {
  const url = new URL(`${DRIVE_FILES}/${encodeURIComponent(fileId)}`);
  url.search = new URLSearchParams({
    supportsAllDrives: 'true',
    fields:
      'id,name,mimeType,modifiedTime,size,trashed,capabilities/canDownload',
  }).toString();
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return driveError(res);
  const f = (await res.json()) as Record<string, unknown>;
  const capabilities = (f.capabilities ?? {}) as { canDownload?: unknown };
  return {
    ok: true,
    file: {
      id: typeof f.id === 'string' ? f.id : fileId,
      name: typeof f.name === 'string' ? f.name : fileId,
      mimeType: typeof f.mimeType === 'string' ? f.mimeType : '',
      modifiedTime: typeof f.modifiedTime === 'string' ? f.modifiedTime : '',
      size: typeof f.size === 'string' ? Number(f.size) : null,
      trashed: f.trashed === true,
      canDownload: capabilities.canDownload !== false,
    },
  };
}

/** Whether Drive's answer means the app may not (or no longer) read the file. */
export const isNotPicked = (r: { status: number; reason: string | null }) =>
  r.status === 404 ||
  r.reason === 'appNotAuthorizedToFile' ||
  r.reason === 'notFound';

const EXPORTS: Record<string, { mimeType: string; format: 'pdf' | 'xlsx' }> = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/pdf',
    format: 'pdf',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/pdf',
    format: 'pdf',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    format: 'xlsx',
  },
};

export type DrivePlan =
  | {
      kind: 'export';
      exportMimeType: string;
      format: 'pdf' | 'xlsx';
      filename: string;
      title: string;
    }
  | { kind: 'download'; extension: string; filename: string; title: string }
  | { kind: 'refused'; refusal: string };

const extensionOf = (name: string) =>
  name.includes('.') ? (name.split('.').pop()?.toLowerCase() ?? '') : '';

/** What the library would store a Drive item as, or why it can't. */
export function planFor(file: DriveFile): DrivePlan {
  if (file.mimeType === 'application/vnd.google-apps.shortcut')
    return {
      kind: 'refused',
      refusal: 'Pick the original file, not a shortcut.',
    };
  if (file.trashed)
    return { kind: 'refused', refusal: 'This file is in the Drive trash.' };
  if (!file.canDownload)
    return {
      kind: 'refused',
      refusal: "This file's owner doesn't allow downloading it.",
    };
  const exported = EXPORTS[file.mimeType];
  if (exported)
    return {
      kind: 'export',
      exportMimeType: exported.mimeType,
      format: exported.format,
      filename: `${file.name}.${exported.format}`,
      title: file.name,
    };
  const ext = extensionOf(file.name);
  if (
    !file.mimeType.startsWith('application/vnd.google-apps.') &&
    DOCUMENT_TYPES[ext]
  ) {
    if (file.size !== null && file.size > MAX_DOCUMENT_BYTES)
      return {
        kind: 'refused',
        refusal: 'This file is larger than 25 MB, the upload limit.',
      };
    return {
      kind: 'download',
      extension: ext,
      filename: file.name,
      title: file.name.slice(0, -(ext.length + 1)) || file.name,
    };
  }
  return {
    kind: 'refused',
    refusal: "This isn't a type the document library accepts.",
  };
}

export type ContentResult =
  | { ok: true; bytes: ArrayBuffer }
  | { ok: false; kind: 'too-large' | 'not-picked' | 'google-error' };

/**
 * Fetch a picked file's bytes: exported for a Google file, as stored for any
 * other. Counts bytes as they arrive and stops at `cap`, so an oversized file
 * is never held in memory whole.
 */
export async function fetchDriveContent(
  accessToken: string,
  file: DriveFile,
  plan: Extract<DrivePlan, { kind: 'export' | 'download' }>,
  cap: number,
): Promise<ContentResult> {
  const url =
    plan.kind === 'export'
      ? new URL(`${DRIVE_FILES}/${encodeURIComponent(file.id)}/export`)
      : new URL(`${DRIVE_FILES}/${encodeURIComponent(file.id)}`);
  url.search = new URLSearchParams(
    plan.kind === 'export'
      ? { mimeType: plan.exportMimeType }
      : { alt: 'media', supportsAllDrives: 'true' },
  ).toString();
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const err = await driveError(res);
    if (isNotPicked(err)) return { ok: false, kind: 'not-picked' };
    // Google documents no specific reason for the export limit; any other
    // export refusal is reported as too large (spec decision 4).
    console.error(
      '[drive] fetching file content failed',
      err.status,
      err.reason,
    );
    return {
      ok: false,
      kind:
        plan.kind === 'export' && err.status < 500
          ? 'too-large'
          : 'google-error',
    };
  }
  const reader = res.body?.getReader();
  if (!reader) return { ok: true, bytes: new ArrayBuffer(0) };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return { ok: false, kind: 'too-large' };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, bytes: bytes.buffer };
}
