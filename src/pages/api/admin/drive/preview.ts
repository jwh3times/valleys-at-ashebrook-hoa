import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../../server/authz/api-guards';
import { readJson } from '../../../../server/http';
import { DOCUMENT_TYPES } from '../../../../lib/document-types';
import { driveConfig, notConfigured } from '../../../../server/drive/config';
import {
  googleUnavailable,
  mintAccessToken,
  noConnection,
  touchLastUsed,
} from '../../../../server/drive/connection';
import {
  MAX_FILES_PER_BATCH,
  getDriveFile,
  isNotPicked,
  planFor,
} from '../../../../server/drive/files';
import { nearMatches } from '../../../../server/documents/store';

export const prerender = false;

/** Earlier imports of one Drive file, oldest first. */
async function earlierImports(db: D1Database, fileId: string) {
  const { results } = await db
    .prepare(
      `SELECT d.id AS id, d.title AS title, i.drive_modified_time AS modifiedTime
       FROM drive_imports i JOIN documents d ON d.id = i.document_id
      WHERE i.drive_file_id = ?
      ORDER BY i.imported_at`,
    )
    .bind(fileId)
    .all<{ id: string; title: string; modifiedTime: string }>();
  return results;
}

/**
 * Describe picked Drive files before anything is imported (#290 slice 3, spec
 * decision 3): what each would be stored as, or why it can't be, and any
 * duplicate warnings. Reads only — nothing is fetched or stored — but it is a
 * POST, so the write freeze covers it like every admin POST.
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
  const raw = (parsed.value as { fileIds?: unknown } | null)?.fileIds;
  if (
    !Array.isArray(raw) ||
    raw.length < 1 ||
    raw.length > MAX_FILES_PER_BATCH ||
    !raw.every((id) => typeof id === 'string' && id.length > 0)
  )
    return new Response(
      `fileIds must list 1 to ${MAX_FILES_PER_BATCH} Drive file IDs`,
      { status: 400 },
    );
  const fileIds = [...new Set(raw as string[])];

  let minted;
  try {
    minted = await mintAccessToken(env, config, ctx.userId);
  } catch (err) {
    console.error('[drive] minting a preview token failed', err);
    return googleUnavailable();
  }
  if (minted.kind !== 'minted') return noConnection();

  const files = [];
  for (const fileId of fileIds) {
    const got = await getDriveFile(minted.accessToken, fileId);
    if (!got.ok) {
      files.push({
        fileId,
        name: fileId,
        plan: 'refused' as const,
        refusal: isNotPicked(got)
          ? 'The site no longer has access to this file. Pick it again in Google Drive.'
          : "Google didn't describe this file. Try again.",
      });
      continue;
    }
    const { file } = got;
    const plan = planFor(file);
    const base = {
      fileId,
      name: file.name,
      driveMimeType: file.mimeType,
      modifiedTime: file.modifiedTime,
      size: file.size,
    };
    if (plan.kind === 'refused') {
      files.push({ ...base, plan: 'refused' as const, refusal: plan.refusal });
      continue;
    }
    const earlier = await earlierImports(env.DATABASE, fileId);
    const sameVersion = earlier.find(
      (e) => e.modifiedTime === file.modifiedTime,
    );
    if (sameVersion) {
      files.push({
        ...base,
        plan: 'refused' as const,
        refusal: `You already imported this version of the file, as "${sameVersion.title}".`,
      });
      continue;
    }
    const storedAs = plan.kind === 'export' ? plan.format : plan.extension;
    const newerVersionOf = earlier.map((e) => ({ id: e.id, title: e.title }));
    const near = await nearMatches(env, {
      id: 'new',
      title: plan.title,
      filename: plan.filename,
      sizeBytes: 0,
      contentType: DOCUMENT_TYPES[storedAs],
      visibility: 'board',
    });
    files.push({
      ...base,
      plan: plan.kind,
      storedAs,
      filename: plan.filename,
      title: plan.title,
      newerVersionOf,
      nearDuplicates: near
        .filter((n) => !newerVersionOf.some((e) => e.id === n.id))
        .map((n) => ({ id: n.id, title: n.title })),
    });
  }
  await touchLastUsed(env, minted.version);
  return Response.json({ files });
};
