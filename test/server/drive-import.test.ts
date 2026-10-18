import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { POST as pickerSession } from '../../src/pages/api/admin/drive/picker-session';
import { POST as preview } from '../../src/pages/api/admin/drive/preview';
import { POST as importFile } from '../../src/pages/api/admin/drive/import';
import { DELETE as deleteDocument } from '../../src/pages/api/admin/documents';
import { fetchDocumentsFor } from '../../src/server/content/reads';
import { pauseNextBatch } from './fixtures';
import {
  DRIVE_SECRETS,
  boardCaller,
  configureDrive,
  seedDriveConnection,
  stubGoogleDrive,
  unconfigureDrive,
} from './drive-fixtures';

// #290 slice 3 (spec 2026-10-18 decisions 2-4): picking files, previewing
// them, and importing them into the document library. Google is a stubbed
// fetch throughout.

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

afterEach(async () => {
  unconfigureDrive();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await env.DATABASE.exec('DELETE FROM drive_imports');
  await env.DATABASE.exec('DELETE FROM documents');
  await env.DATABASE.exec('DELETE FROM drive_connection');
  await env.DATABASE.exec(
    "DELETE FROM setting_changes WHERE key = 'drive_connection'",
  );
});

function post(
  handler: typeof pickerSession,
  path: string,
  body?: unknown,
  locals: object = boardCaller(),
) {
  return handler({
    request: new Request(`http://localhost/api/admin/drive/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    locals,
  } as never) as Promise<Response>;
}

describe('POST /api/admin/drive/picker-session', () => {
  it('gives a board admin a fresh token, the Picker key and the project number', async () => {
    configureDrive();
    await seedDriveConnection();
    const calls = stubGoogleDrive();
    const before = Date.now();
    const res = await post(pickerSession, 'picker-session');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      accessToken: 'server-access-token',
      developerKey: DRIVE_SECRETS.DRIVE_PICKER_API_KEY,
      appId: DRIVE_SECRETS.DRIVE_PROJECT_NUMBER,
    });
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + 3_000_000);
    expect(calls.map((c) => c.url)).toEqual([
      'https://oauth2.googleapis.com/token',
    ]);
    const stored = await env.DATABASE.prepare(
      'SELECT last_used_at FROM drive_connection',
    ).first<{ last_used_at: number | null }>();
    expect(stored?.last_used_at).toBeGreaterThanOrEqual(before);
    expect(JSON.stringify(stored)).not.toContain('server-access-token');
  });

  it('answers 409 when Google Drive is not connected', async () => {
    configureDrive();
    stubGoogleDrive();
    expect((await post(pickerSession, 'picker-session')).status).toBe(409);
  });

  it('answers 409 when the connection is broken', async () => {
    configureDrive();
    await seedDriveConnection('broken');
    stubGoogleDrive();
    expect((await post(pickerSession, 'picker-session')).status).toBe(409);
  });

  it('records the connection broken when Google refuses the grant', async () => {
    configureDrive();
    await seedDriveConnection();
    stubGoogleDrive({
      token: { status: 400, body: { error: 'invalid_grant' } },
    });
    expect((await post(pickerSession, 'picker-session')).status).toBe(409);
    const stored = await env.DATABASE.prepare(
      'SELECT status FROM drive_connection',
    ).first<{ status: string }>();
    expect(stored?.status).toBe('broken');
  });

  it('answers 503 on a transient Google error, leaving the connection alone', async () => {
    configureDrive();
    await seedDriveConnection();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubGoogleDrive({ token: { status: 503, body: { error: 'backend' } } });
    expect((await post(pickerSession, 'picker-session')).status).toBe(503);
    const stored = await env.DATABASE.prepare(
      'SELECT status FROM drive_connection',
    ).first<{ status: string }>();
    expect(stored?.status).toBe('connected');
  });

  it('answers 404 while the feature is not configured', async () => {
    await seedDriveConnection();
    expect((await post(pickerSession, 'picker-session')).status).toBe(404);
  });

  it('refuses a caller without Board Access', async () => {
    configureDrive();
    const { callerContext } = await import('./caller-context');
    const res = await post(pickerSession, 'picker-session', undefined, {
      authContext: callerContext('h', 'homeowner', []),
    });
    expect(res.status).toBe(403);
  });
});

const DOC = 'application/vnd.google-apps.document';
const SHEET = 'application/vnd.google-apps.spreadsheet';
const SLIDES = 'application/vnd.google-apps.presentation';

/** Insert an existing document, optionally recorded as a Drive import. */
async function seedDocument(
  id: string,
  title: string,
  drive?: { fileId: string; modifiedTime: string },
) {
  await env.DATABASE.prepare(
    `INSERT INTO documents (id, title, category, visibility, r2_key, filename, size_bytes, content_type, uploaded_at, updated_at)
     VALUES (?, ?, 'Governing Documents', 'board', ?, ?, 10, 'application/pdf', 1, 1)`,
  )
    .bind(id, title, `documents/${id}/${title}.pdf`, `${title}.pdf`)
    .run();
  if (drive)
    await env.DATABASE.prepare(
      `INSERT INTO drive_imports (document_id, drive_file_id, drive_mime_type, drive_modified_time, export_format, google_sub, imported_at)
       VALUES (?, ?, ?, ?, 'pdf', 'google-sub-1', 1)`,
    )
      .bind(id, drive.fileId, DOC, drive.modifiedTime)
      .run();
}

type PreviewRow = {
  fileId: string;
  name: string;
  plan: 'export' | 'download' | 'refused';
  storedAs?: string;
  filename?: string;
  title?: string;
  modifiedTime?: string;
  refusal?: string;
  newerVersionOf?: { id: string; title: string }[];
  nearDuplicates?: { id: string; title: string }[];
};

async function previewRows(fileIds: string[]): Promise<PreviewRow[]> {
  const res = await post(preview, 'preview', { fileIds });
  expect(res.status).toBe(200);
  return ((await res.json()) as { files: PreviewRow[] }).files;
}

describe('POST /api/admin/drive/preview', () => {
  it('plans each picked file by what Drive says it is', async () => {
    configureDrive();
    await seedDriveConnection();
    stubGoogleDrive({
      files: [
        { id: 'f-doc', name: 'Bylaws draft', mimeType: DOC },
        { id: 'f-slides', name: 'Annual meeting', mimeType: SLIDES },
        { id: 'f-sheet', name: 'Budget 2027', mimeType: SHEET },
        {
          id: 'f-pdf',
          name: 'Survey.pdf',
          mimeType: 'application/pdf',
          size: '2048',
        },
      ],
    });
    const rows = await previewRows(['f-doc', 'f-slides', 'f-sheet', 'f-pdf']);
    expect(
      rows.map((r) => [r.fileId, r.plan, r.storedAs, r.filename, r.title]),
    ).toEqual([
      ['f-doc', 'export', 'pdf', 'Bylaws draft.pdf', 'Bylaws draft'],
      ['f-slides', 'export', 'pdf', 'Annual meeting.pdf', 'Annual meeting'],
      ['f-sheet', 'export', 'xlsx', 'Budget 2027.xlsx', 'Budget 2027'],
      ['f-pdf', 'download', 'pdf', 'Survey.pdf', 'Survey'],
    ]);
    expect(rows[0].modifiedTime).toBe('2026-10-01T12:00:00.000Z');
  });

  it.each([
    [
      'a shortcut',
      { mimeType: 'application/vnd.google-apps.shortcut', name: 'Link' },
      /original file, not a shortcut/,
    ],
    ['a trashed file', { mimeType: DOC, name: 'Old', trashed: true }, /trash/],
    [
      'a file its owner blocks downloading',
      { mimeType: DOC, name: 'Locked', canDownload: false },
      /doesn't allow downloading/,
    ],
    [
      'a type the library does not accept',
      { mimeType: 'image/jpeg', name: 'Photo.jpg' },
      /isn't a type the document library accepts/,
    ],
    [
      'a Google Form',
      { mimeType: 'application/vnd.google-apps.form', name: 'Survey form' },
      /isn't a type the document library accepts/,
    ],
    [
      'a file over the 25 MiB upload cap',
      {
        mimeType: 'application/pdf',
        name: 'Huge.pdf',
        size: String(26 * 1024 * 1024),
      },
      /larger than 25 MB/,
    ],
  ])('refuses %s, with the reason', async (_, file, reason) => {
    configureDrive();
    await seedDriveConnection();
    stubGoogleDrive({ files: [{ id: 'f-x', ...file }] });
    const [row] = await previewRows(['f-x']);
    expect(row.plan).toBe('refused');
    expect(row.refusal).toMatch(reason);
  });

  it.each([
    [{ status: 404, reason: 'notFound' }],
    [{ status: 403, reason: 'appNotAuthorizedToFile' }],
  ])(
    'asks for the file to be picked again when Drive answers %o',
    async (error) => {
      configureDrive();
      await seedDriveConnection();
      stubGoogleDrive({
        files: [{ id: 'f-gone', name: 'Gone', mimeType: DOC, error }],
      });
      const [row] = await previewRows(['f-gone']);
      expect(row.plan).toBe('refused');
      expect(row.refusal).toMatch(/Pick it again/);
    },
  );

  it('refuses a Drive version that was already imported', async () => {
    configureDrive();
    await seedDriveConnection();
    await seedDocument('d-1', 'Bylaws draft', {
      fileId: 'f-doc',
      modifiedTime: '2026-10-01T12:00:00.000Z',
    });
    stubGoogleDrive({
      files: [{ id: 'f-doc', name: 'Bylaws draft', mimeType: DOC }],
    });
    const [row] = await previewRows(['f-doc']);
    expect(row.plan).toBe('refused');
    expect(row.refusal).toMatch(/already imported this version/);
  });

  it('warns about an earlier version of the same Drive file', async () => {
    configureDrive();
    await seedDriveConnection();
    await seedDocument('d-1', 'Bylaws draft', {
      fileId: 'f-doc',
      modifiedTime: '2026-09-01T12:00:00.000Z',
    });
    stubGoogleDrive({
      files: [{ id: 'f-doc', name: 'Bylaws draft', mimeType: DOC }],
    });
    const [row] = await previewRows(['f-doc']);
    expect(row.plan).toBe('export');
    expect(row.newerVersionOf).toEqual([{ id: 'd-1', title: 'Bylaws draft' }]);
  });

  it('warns about a document with a near-identical name', async () => {
    configureDrive();
    await seedDriveConnection();
    await seedDocument('d-2', 'Pool rules 2027');
    stubGoogleDrive({
      files: [{ id: 'f-doc', name: 'Pool rules 2027 (1)', mimeType: DOC }],
    });
    const [row] = await previewRows(['f-doc']);
    expect(row.nearDuplicates?.map((d) => d.id)).toEqual(['d-2']);
  });

  it.each([
    [[]],
    [Array.from({ length: 11 }, (_, i) => `f-${i}`)],
    [['f-1', 7]],
  ])('answers 400 for %o', async (fileIds) => {
    configureDrive();
    await seedDriveConnection();
    stubGoogleDrive();
    expect((await post(preview, 'preview', { fileIds })).status).toBe(400);
  });

  it('answers 409 when Google Drive is not connected', async () => {
    configureDrive();
    stubGoogleDrive();
    expect((await post(preview, 'preview', { fileIds: ['f-1'] })).status).toBe(
      409,
    );
  });
});

describe('POST /api/admin/drive/import', () => {
  const MODIFIED = '2026-10-01T12:00:00.000Z';

  function importBody(overrides: Record<string, unknown> = {}) {
    return {
      fileId: 'f-doc',
      expectedModifiedTime: MODIFIED,
      title: 'Bylaws draft',
      category: 'Governing Documents',
      visibility: 'board',
      confirmDuplicate: false,
      ...overrides,
    };
  }

  async function documentRows() {
    const { results } = await env.DATABASE.prepare(
      `SELECT d.id, d.title, d.filename, d.content_type, d.visibility, d.uploaded_by,
              i.drive_file_id, i.drive_mime_type, i.drive_modified_time, i.export_format, i.google_sub
         FROM documents d LEFT JOIN drive_imports i ON i.document_id = d.id
        ORDER BY d.uploaded_at, d.rowid`,
    ).all<Record<string, unknown>>();
    return results;
  }

  async function r2Keys() {
    return (await env.DOCS.list()).objects.map((o) => o.key).sort();
  }

  it('exports a Google Doc as PDF and stores it, with where it came from', async () => {
    configureDrive();
    await seedDriveConnection();
    const calls = stubGoogleDrive({
      files: [
        {
          id: 'f-doc',
          name: 'Bylaws draft',
          mimeType: DOC,
          content: 'Article I. The association shall meet annually.',
        },
      ],
    });
    const res = await post(importFile, 'import', importBody());
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(
      calls.some(
        (c) =>
          c.url.includes('/files/f-doc/export') &&
          c.url.includes('mimeType=application%2Fpdf'),
      ),
    ).toBe(true);
    expect(await documentRows()).toEqual([
      {
        id,
        title: 'Bylaws draft',
        filename: 'Bylaws draft.pdf',
        content_type: 'application/pdf',
        visibility: 'board',
        uploaded_by: 'board-1',
        drive_file_id: 'f-doc',
        drive_mime_type: DOC,
        drive_modified_time: MODIFIED,
        export_format: 'pdf',
        google_sub: 'google-sub-1',
      },
    ]);
    const stored = await env.DOCS.get(`documents/${id}/Bylaws_draft.pdf`);
    expect(await stored?.text()).toBe(
      'Article I. The association shall meet annually.',
    );
  });

  it('downloads a stored PDF unchanged, recording no export format', async () => {
    configureDrive();
    await seedDriveConnection();
    const calls = stubGoogleDrive({
      files: [
        {
          id: 'f-pdf',
          name: 'Survey.pdf',
          mimeType: 'application/pdf',
          content: '%PDF-1.7 survey',
        },
      ],
    });
    const res = await post(
      importFile,
      'import',
      importBody({ fileId: 'f-pdf', title: 'Survey' }),
    );
    expect(res.status).toBe(201);
    expect(calls.some((c) => c.url.includes('/files/f-pdf?alt=media'))).toBe(
      true,
    );
    expect(await documentRows()).toMatchObject([
      { filename: 'Survey.pdf', export_format: null },
    ]);
  });

  it('refuses a file edited since it was previewed', async () => {
    configureDrive();
    await seedDriveConnection();
    stubGoogleDrive({
      files: [
        {
          id: 'f-doc',
          name: 'Bylaws draft',
          mimeType: DOC,
          modifiedTime: '2026-10-02T09:00:00.000Z',
        },
      ],
    });
    const res = await post(importFile, 'import', importBody());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'changed-since-preview' });
    expect(await documentRows()).toEqual([]);
  });

  it('refuses an export over 10 MB, stopping the download part-way', async () => {
    configureDrive();
    await seedDriveConnection();
    const before = await r2Keys();
    stubGoogleDrive({
      files: [
        {
          id: 'f-doc',
          name: 'Photo album',
          mimeType: DOC,
          content: new Uint8Array(10 * 1024 * 1024 + 1),
        },
      ],
    });
    const res = await post(importFile, 'import', importBody());
    expect(res.status).toBe(413);
    expect(await res.text()).toMatch(/Export it from Google and upload it/);
    expect(await documentRows()).toEqual([]);
    expect(await r2Keys()).toEqual(before);
  });

  it('allows a downloaded file up to the 25 MB upload cap, and no further', async () => {
    configureDrive();
    await seedDriveConnection();
    stubGoogleDrive({
      files: [
        {
          id: 'f-pdf',
          name: 'Plans.pdf',
          mimeType: 'application/pdf',
          content: new Uint8Array(25 * 1024 * 1024 + 1),
        },
      ],
    });
    const res = await post(
      importFile,
      'import',
      importBody({ fileId: 'f-pdf', title: 'Plans' }),
    );
    expect(res.status).toBe(413);
  });

  it('refuses a byte-identical document, whatever confirmDuplicate says', async () => {
    configureDrive();
    await seedDriveConnection();
    stubGoogleDrive({
      files: [
        { id: 'f-a', name: 'Notice', mimeType: DOC, content: 'same bytes' },
        {
          id: 'f-b',
          name: 'Notice copy',
          mimeType: DOC,
          content: 'same bytes',
        },
      ],
    });
    expect(
      (
        await post(
          importFile,
          'import',
          importBody({ fileId: 'f-a', title: 'Notice' }),
        )
      ).status,
    ).toBe(201);
    const res = await post(
      importFile,
      'import',
      importBody({
        fileId: 'f-b',
        title: 'Notice copy',
        confirmDuplicate: true,
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'exact-duplicate' });
  });

  it('refuses the same Drive version twice, whatever confirmDuplicate says', async () => {
    configureDrive();
    await seedDriveConnection();
    stubGoogleDrive({
      files: [{ id: 'f-sheet', name: 'Budget', mimeType: SHEET }],
    });
    // A Sheet exports to different bytes every time (prototype P3), so the
    // Drive version is checked before anything is fetched or hashed.
    const body = importBody({ fileId: 'f-sheet', title: 'Budget' });
    expect((await post(importFile, 'import', body)).status).toBe(201);
    const again = await post(importFile, 'import', {
      ...body,
      title: 'Budget again',
      confirmDuplicate: true,
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'drive-duplicate' });
  });

  it('asks before importing a newer version of an imported file', async () => {
    configureDrive();
    await seedDriveConnection();
    await seedDocument('d-1', 'Bylaws draft', {
      fileId: 'f-doc',
      modifiedTime: '2026-09-01T12:00:00.000Z',
    });
    stubGoogleDrive({
      files: [{ id: 'f-doc', name: 'Bylaws draft', mimeType: DOC }],
    });
    const first = await post(importFile, 'import', importBody());
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({
      warning: 'near-duplicate',
      similar: [{ id: 'd-1', title: 'Bylaws draft' }],
    });
    const anyway = await post(
      importFile,
      'import',
      importBody({ confirmDuplicate: true }),
    );
    expect(anyway.status).toBe(201);
  });

  it('gives one import and one drive-duplicate when two land at once', async () => {
    configureDrive();
    await seedDriveConnection();
    const before = await r2Keys();
    stubGoogleDrive({
      files: [{ id: 'f-doc', name: 'Bylaws draft', mimeType: DOC }],
    });
    const paused = pauseNextBatch();
    const first = post(importFile, 'import', importBody());
    await paused.reached;
    paused.restore();
    // Neither import's earlier checks can see the other, which hasn't
    // committed yet: only the unique index on the Drive version stops one.
    const second = await post(
      importFile,
      'import',
      importBody({ title: 'Bylaws draft (again)' }),
    );
    paused.release();
    const statuses = [(await first).status, second.status].sort(
      (a, b) => a - b,
    );
    expect(statuses).toEqual([201, 409]);
    expect((await documentRows()).length).toBe(1);
    const [row] = await documentRows();
    const added = (await r2Keys()).filter((k) => !before.includes(k));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((k) => k.includes(String(row.id)))).toBe(true);
  });

  it('frees a Drive version to be imported again once its document is deleted', async () => {
    configureDrive();
    await seedDriveConnection();
    stubGoogleDrive({
      files: [{ id: 'f-doc', name: 'Bylaws draft', mimeType: DOC }],
    });
    const created = await post(importFile, 'import', importBody());
    const { id } = (await created.json()) as { id: string };
    const del = await deleteDocument({
      request: new Request('http://localhost/api/admin/documents', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      }),
      locals: boardCaller(),
    } as never);
    expect(del.status).toBe(204);
    expect(
      await env.DATABASE.prepare(
        'SELECT COUNT(*) AS n FROM drive_imports',
      ).first('n'),
    ).toBe(0);
    expect((await post(importFile, 'import', importBody())).status).toBe(201);
  });

  it.each([
    [{ title: '' }],
    [{ title: 'x'.repeat(500) }],
    [{ category: 'Not a category' }],
    [{ visibility: 'everyone' }],
    [{ fileId: '' }],
    [{ expectedModifiedTime: '' }],
  ])('answers 400 for %o', async (overrides) => {
    configureDrive();
    await seedDriveConnection();
    stubGoogleDrive({
      files: [{ id: 'f-doc', name: 'Bylaws', mimeType: DOC }],
    });
    expect(
      (await post(importFile, 'import', importBody(overrides))).status,
    ).toBe(400);
  });

  it('accepts a downloaded file between the export cap and the upload cap', async () => {
    configureDrive();
    await seedDriveConnection();
    stubGoogleDrive({
      files: [
        {
          id: 'f-pdf',
          name: 'Plans.pdf',
          mimeType: 'application/pdf',
          content: new Uint8Array(15 * 1024 * 1024).fill(1),
        },
      ],
    });
    const res = await post(
      importFile,
      'import',
      importBody({ fileId: 'f-pdf', title: 'Plans' }),
    );
    expect(res.status).toBe(201);
  });

  it('stops reading an export as soon as it passes the cap', async () => {
    // An endless body: only a reader that stops at the cap can answer at all.
    configureDrive();
    await seedDriveConnection();
    let pulled = 0;
    stubGoogleDrive({
      files: [
        {
          id: 'f-doc',
          name: 'Endless',
          mimeType: DOC,
          content: () =>
            new ReadableStream({
              pull(controller) {
                pulled++;
                controller.enqueue(new Uint8Array(1024 * 1024));
              },
            }),
        },
      ],
    });
    const res = await post(importFile, 'import', importBody());
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(20);
  });

  it.each([
    [{ status: 429, reason: 'rateLimitExceeded' }],
    [{ status: 403, reason: 'userRateLimitExceeded' }],
    [{ status: 401, reason: 'authError' }],
    [{ status: 500, reason: 'backendError' }],
  ])(
    'answers 503, not "too large", when the export fails with %o',
    async (contentError) => {
      configureDrive();
      await seedDriveConnection();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      stubGoogleDrive({
        files: [
          { id: 'f-doc', name: 'Bylaws draft', mimeType: DOC, contentError },
        ],
      });
      expect((await post(importFile, 'import', importBody())).status).toBe(503);
    },
  );

  it('answers 413 when Google refuses an export for its size', async () => {
    configureDrive();
    await seedDriveConnection();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubGoogleDrive({
      files: [
        {
          id: 'f-doc',
          name: 'Bylaws draft',
          mimeType: DOC,
          contentError: { status: 403, reason: 'exportSizeLimitExceeded' },
        },
      ],
    });
    expect((await post(importFile, 'import', importBody())).status).toBe(413);
  });

  it('asks for the file to be picked again when Drive no longer grants it', async () => {
    configureDrive();
    await seedDriveConnection();
    stubGoogleDrive({
      files: [
        {
          id: 'f-doc',
          name: 'Bylaws draft',
          mimeType: DOC,
          error: { status: 403, reason: 'appNotAuthorizedToFile' },
        },
      ],
    });
    const res = await post(importFile, 'import', importBody());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not-picked' });
  });

  it('refuses a file the library would not accept', async () => {
    configureDrive();
    await seedDriveConnection();
    stubGoogleDrive({
      files: [
        {
          id: 'f-doc',
          name: 'Link',
          mimeType: 'application/vnd.google-apps.shortcut',
        },
      ],
    });
    const res = await post(importFile, 'import', importBody());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'refused' });
  });

  it('records the Google account the file was actually read from', async () => {
    configureDrive();
    await seedDriveConnection();
    stubGoogleDrive({
      files: [{ id: 'f-doc', name: 'Bylaws draft', mimeType: DOC }],
      // A System Administrator reconnects to another account mid-import.
      onToken: async () => {
        await env.DATABASE.exec(
          "UPDATE drive_connection SET google_sub = 'google-sub-2', revision = revision + 1",
        );
      },
    });
    expect((await post(importFile, 'import', importBody())).status).toBe(201);
    expect(
      await env.DATABASE.prepare('SELECT google_sub FROM drive_imports').first(
        'google_sub',
      ),
    ).toBe('google-sub-1');
  });

  it.each(['..', '.', 'a/b', 'x'.repeat(300)])(
    'answers 400 for a malformed file ID %j',
    async (fileId) => {
      configureDrive();
      await seedDriveConnection();
      const calls = stubGoogleDrive();
      expect(
        (await post(importFile, 'import', importBody({ fileId }))).status,
      ).toBe(400);
      expect(
        (await post(preview, 'preview', { fileIds: [fileId] })).status,
      ).toBe(400);
      expect(calls).toEqual([]);
    },
  );

  it('answers 409 when Google Drive is not connected', async () => {
    configureDrive();
    stubGoogleDrive();
    expect((await post(importFile, 'import', importBody())).status).toBe(409);
  });

  it('looks exactly like an uploaded document to public and homeowner reads', async () => {
    configureDrive();
    await seedDriveConnection();
    stubGoogleDrive({
      files: [{ id: 'f-doc', name: 'Pool rules', mimeType: DOC }],
    });
    await post(
      importFile,
      'import',
      importBody({ title: 'Pool rules', visibility: 'public' }),
    );
    await seedDocument('d-up', 'Uploaded');
    await env.DATABASE.exec("UPDATE documents SET visibility = 'public'");
    for (const role of ['visitor', 'homeowner'] as const) {
      const rows = await fetchDocumentsFor(env, role);
      expect(rows).toHaveLength(2);
      const [a, b] = rows.map((r) => Object.keys(r).sort());
      expect(a).toEqual(b);
      for (const keys of [a, b])
        for (const k of keys) expect(k).not.toMatch(/^(uploadedBy|drive)/);
    }
  });
});
