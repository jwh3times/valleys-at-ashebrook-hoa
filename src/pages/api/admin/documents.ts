import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { getDb } from '../../../server/db/client';
import { documents } from '../../../server/db/schema';

export const prerender = false;

const MAX_BYTES = 25 * 1024 * 1024;
const VISIBILITIES = ['public', 'homeowner', 'board'] as const;

// Server-side allowlist keyed by extension. Client MIME is unreliable for
// .md/.csv, so derive the stored content type here. text/html and image/svg+xml
// are deliberately excluded — they are the stored-XSS vectors when served inline.
const EXT_TO_TYPE: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const form = await request.formData();
  const file = form.get('file');
  const title = String(form.get('title') ?? '');
  const category = String(form.get('category') ?? '');
  const visibility = String(form.get('visibility') ?? 'board');
  if (!(file instanceof File) || !title || !category)
    return new Response('Bad Request', { status: 400 });
  if (!(VISIBILITIES as readonly string[]).includes(visibility))
    return new Response('Bad Request', { status: 400 });
  if (file.size > MAX_BYTES) return new Response('Too large', { status: 413 });
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const contentType = EXT_TO_TYPE[ext];
  if (!contentType)
    return new Response('Unsupported file type', { status: 415 });
  const id = crypto.randomUUID();
  const r2Key = `documents/${id}/${file.name.replace(/[^\w.\-]/g, '_')}`;
  await env.DOCS.put(r2Key, await file.arrayBuffer(), {
    httpMetadata: { contentType },
  });
  const now = new Date();
  await getDb(env)
    .insert(documents)
    .values({
      id,
      title,
      category,
      visibility: visibility as 'public' | 'homeowner' | 'board',
      r2Key,
      filename: file.name,
      sizeBytes: file.size,
      contentType,
      uploadedAt: now,
      updatedAt: now,
    });
  return new Response(null, { status: 201 });
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const body = (await request.json()) as {
    id?: string;
    title?: string;
    category?: string;
    visibility?: string;
  };
  if (!body.id) return new Response('Bad Request', { status: 400 });
  if (
    body.visibility !== undefined &&
    !(VISIBILITIES as readonly string[]).includes(body.visibility)
  )
    return new Response('Bad Request', { status: 400 });
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ['title', 'category', 'visibility'] as const)
    if (k in body) patch[k] = body[k];
  await getDb(env)
    .update(documents)
    .set(patch)
    .where(eq(documents.id, body.id));
  return new Response(null, { status: 204 });
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const body = (await request.json()) as { id?: string };
  if (!body.id) return new Response('Bad Request', { status: 400 });
  const [doc] = await getDb(env)
    .select()
    .from(documents)
    .where(eq(documents.id, body.id));
  if (doc) {
    await env.DOCS.delete(doc.r2Key);
    await getDb(env).delete(documents).where(eq(documents.id, body.id));
  }
  return new Response(null, { status: 204 });
};
