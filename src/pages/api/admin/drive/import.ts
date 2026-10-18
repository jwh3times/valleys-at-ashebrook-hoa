import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../../server/authz/api-guards';
import { readJson } from '../../../../server/http';
import { DOCUMENT_CATEGORIES, INPUT_LIMITS } from '../../../../lib/types';
import type { Visibility } from '../../../../lib/types';
import { driveConfig, notConfigured } from '../../../../server/drive/config';
import {
  googleUnavailable,
  mintAccessToken,
  noConnection,
  touchLastUsed,
} from '../../../../server/drive/connection';
import {
  MAX_EXPORT_BYTES,
  fetchDriveContent,
  getDriveFile,
  isNotPicked,
  planFor,
} from '../../../../server/drive/files';
import {
  MAX_DOCUMENT_BYTES,
  storeDocument,
} from '../../../../server/documents/store';

export const prerender = false;

const VISIBILITIES: readonly string[] = ['public', 'homeowner', 'board'];
const CATEGORIES: readonly string[] = DOCUMENT_CATEGORIES;
const TOO_LARGE =
  'Too large to import from Drive. Export it from Google and upload it here instead.';

const conflict = (body: object) => Response.json(body, { status: 409 });

/**
 * Import one picked Drive file as a document (#290 slice 3, spec decision 4).
 * The browser sends one request per file of a batch. Every check preview made
 * is repeated here, and the Drive-duplicate rule is enforced inside the write
 * by drive_imports' unique index, so two board admins importing the same
 * version at once get one import and one refusal (spec review Q5).
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const config = driveConfig(env);
  if (!config) return notConfigured();
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });

  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const body = (parsed.value ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof body[k] === 'string' ? body[k] : '');
  const fileId = str('fileId');
  const expectedModifiedTime = str('expectedModifiedTime');
  const title = str('title').trim();
  const category = str('category').trim();
  const visibility = str('visibility');
  if (!fileId || !expectedModifiedTime)
    return new Response('fileId and expectedModifiedTime are required', {
      status: 400,
    });
  if (!title) return new Response('title is required', { status: 400 });
  if (title.length > INPUT_LIMITS.title)
    return new Response('title is too long', { status: 400 });
  if (!CATEGORIES.includes(category))
    return new Response('Invalid category', { status: 400 });
  if (!VISIBILITIES.includes(visibility))
    return new Response('Invalid visibility', { status: 400 });
  const confirmDuplicate = body.confirmDuplicate === true;

  let minted;
  try {
    minted = await mintAccessToken(env, config, ctx.userId);
  } catch (err) {
    console.error('[drive] minting an import token failed', err);
    return googleUnavailable();
  }
  if (minted.kind !== 'minted') return noConnection();
  const connection = await env.DATABASE.prepare(
    'SELECT google_sub FROM drive_connection WHERE id = 1',
  ).first<{ google_sub: string }>();
  if (!connection) return noConnection();

  const got = await getDriveFile(minted.accessToken, fileId);
  if (!got.ok)
    return isNotPicked(got)
      ? conflict({ error: 'not-picked' })
      : googleUnavailable();
  const { file } = got;
  if (file.modifiedTime !== expectedModifiedTime)
    return conflict({ error: 'changed-since-preview' });
  const plan = planFor(file);
  if (plan.kind === 'refused')
    return conflict({ error: 'refused', refusal: plan.refusal });

  const { results: earlier } = await env.DATABASE.prepare(
    `SELECT d.id AS id, d.title AS title, d.filename AS filename,
            d.category AS category, d.visibility AS visibility,
            i.drive_modified_time AS modifiedTime
       FROM drive_imports i JOIN documents d ON d.id = i.document_id
      WHERE i.drive_file_id = ?`,
  )
    .bind(fileId)
    .all<{
      id: string;
      title: string;
      filename: string;
      category: string;
      visibility: string;
      modifiedTime: string;
    }>();
  const sameVersion = earlier.find((e) => e.modifiedTime === file.modifiedTime);
  if (sameVersion)
    return conflict({
      error: 'drive-duplicate',
      existing: { id: sameVersion.id, title: sameVersion.title },
    });
  if (earlier.length > 0 && !confirmDuplicate)
    return conflict({
      warning: 'near-duplicate',
      similar: earlier.map((e) => ({
        id: e.id,
        title: e.title,
        filename: e.filename,
        category: e.category,
        visibility: e.visibility,
      })),
    });

  const content = await fetchDriveContent(
    minted.accessToken,
    file,
    plan,
    plan.kind === 'export' ? MAX_EXPORT_BYTES : MAX_DOCUMENT_BYTES,
  );
  if (!content.ok) {
    if (content.kind === 'too-large')
      return new Response(TOO_LARGE, { status: 413 });
    if (content.kind === 'not-picked') return conflict({ error: 'not-picked' });
    return googleUnavailable();
  }

  const exportFormat = plan.kind === 'export' ? plan.format : null;
  let result;
  try {
    result = await storeDocument(env, {
      bytes: content.bytes,
      filename: plan.filename,
      title,
      category,
      visibility: visibility as Visibility,
      uploadedBy: ctx.userId,
      confirmDuplicate,
      alsoInBatch: (documentId) => [
        env.DATABASE.prepare(
          `INSERT INTO drive_imports (document_id, drive_file_id, drive_mime_type, drive_modified_time, export_format, google_sub, imported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          documentId,
          file.id,
          file.mimeType,
          file.modifiedTime,
          exportFormat,
          connection.google_sub,
          Date.now(),
        ),
      ],
    });
  } catch (err) {
    // Another board admin imported this version since the check above; the
    // store has already removed its R2 objects.
    if (/UNIQUE constraint failed: drive_imports\./.test(String(err)))
      return conflict({ error: 'drive-duplicate' });
    throw err;
  }
  await touchLastUsed(env, minted.version);

  switch (result.kind) {
    case 'stored':
      return Response.json({ id: result.id }, { status: 201 });
    case 'too-large':
      return new Response(TOO_LARGE, { status: 413 });
    case 'unsupported-type':
      return conflict({
        error: 'refused',
        refusal: "This isn't a type the document library accepts.",
      });
    case 'exact-duplicate':
      return conflict({ error: 'exact-duplicate', existing: result.existing });
    case 'near-duplicate':
      return conflict({ warning: 'near-duplicate', similar: result.similar });
  }
};
