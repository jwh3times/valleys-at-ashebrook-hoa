import type { APIRoute } from 'astro';
import { eq, ne, inArray } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { generateTwin } from '../../../server/ai/twin';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import { fetchAdminDocuments } from '../../../server/content/reads';
import { documents } from '../../../server/db/schema';
import { DOCUMENT_CATEGORIES, INPUT_LIMITS } from '../../../lib/types';
import {
  sha256Hex,
  nearScore,
  NEAR_THRESHOLD,
  type DocLike,
} from '../../../server/content/dedupe';

export const prerender = false;

const MAX_BYTES = 25 * 1024 * 1024;
const VISIBILITIES = ['public', 'homeowner', 'board'] as const;
const CATEGORIES: readonly string[] = DOCUMENT_CATEGORIES;

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

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  return Response.json(await fetchAdminDocuments(env));
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const form = await request.formData();
  const file = form.get('file');
  const title = String(form.get('title') ?? '').trim();
  const category = String(form.get('category') ?? '').trim();
  const visibility = String(form.get('visibility') ?? 'board');
  if (!(file instanceof File) || !title)
    return new Response('Bad Request', { status: 400 });
  if (title.length > INPUT_LIMITS.title)
    return new Response('title is too long', { status: 400 });
  if (!CATEGORIES.includes(category))
    return new Response('Invalid category', { status: 400 });
  if (!(VISIBILITIES as readonly string[]).includes(visibility))
    return new Response('Bad Request', { status: 400 });
  if (file.size > MAX_BYTES) return new Response('Too large', { status: 413 });
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const contentType = EXT_TO_TYPE[ext];
  if (!contentType)
    return new Response('Unsupported file type', { status: 415 });

  const bytes = await file.arrayBuffer();
  const contentHash = await sha256Hex(bytes);
  const db = getDb(env);

  const [exact] = await db
    .select({
      id: documents.id,
      title: documents.title,
      category: documents.category,
      visibility: documents.visibility,
    })
    .from(documents)
    .where(eq(documents.contentHash, contentHash));
  if (exact) {
    return Response.json(
      { error: 'exact-duplicate', existing: exact },
      { status: 409 },
    );
  }

  const confirmDuplicate =
    String(form.get('confirmDuplicate') ?? '') === 'true';
  if (!confirmDuplicate) {
    const existing = await db
      .select({
        id: documents.id,
        title: documents.title,
        filename: documents.filename,
        sizeBytes: documents.sizeBytes,
        contentType: documents.contentType,
        category: documents.category,
        visibility: documents.visibility,
      })
      .from(documents);
    const candidate: DocLike = {
      id: 'new',
      title,
      filename: file.name,
      sizeBytes: file.size,
      contentType,
      visibility: visibility as DocLike['visibility'],
    };
    const similar = existing
      .filter((e) => nearScore(candidate, e as DocLike) >= NEAR_THRESHOLD)
      .map((e) => ({
        id: e.id,
        title: e.title,
        filename: e.filename,
        category: e.category,
        visibility: e.visibility,
      }));
    if (similar.length > 0) {
      return Response.json(
        { warning: 'near-duplicate', similar },
        { status: 409 },
      );
    }
  }

  const id = crypto.randomUUID();
  const r2Key = `documents/${id}/${file.name.replace(/[^\w.\-]/g, '_')}`;
  await env.DOCS.put(r2Key, bytes, {
    httpMetadata: { contentType },
  });

  // Best-effort RAG twin (ADR 0009 §1). Never fatal to the upload: generateTwin
  // does not throw, and a twin-write failure only downgrades searchability.
  let ragStatus: 'ok' | 'unsupported' = 'unsupported';
  try {
    const twin = await generateTwin(env, {
      filename: file.name,
      contentType,
      bytes,
    });
    ragStatus = twin.status;
    if (twin.markdown) {
      await env.DOCS.put(`rag/${id}.md`, twin.markdown, {
        httpMetadata: { contentType: 'text/markdown' },
      });
    }
  } catch {
    ragStatus = 'unsupported';
  }

  const now = new Date();
  await db.insert(documents).values({
    id,
    title,
    category,
    visibility: visibility as 'public' | 'homeowner' | 'board',
    r2Key,
    filename: file.name,
    sizeBytes: file.size,
    contentType,
    contentHash,
    ragStatus,
    uploadedAt: now,
    updatedAt: now,
  });

  // A confirmed near-duplicate is the only path that stores a file with
  // existing near-matches (a clean upload has none; an exact match is blocked
  // above). When it happens, the board's earlier "keep" decisions on those
  // matches are stale — clear them so the group resurfaces for re-review.
  if (confirmDuplicate) {
    const candidate: DocLike = {
      id,
      title,
      filename: file.name,
      sizeBytes: file.size,
      contentType,
      visibility: visibility as DocLike['visibility'],
    };
    const others = await db
      .select({
        id: documents.id,
        title: documents.title,
        filename: documents.filename,
        sizeBytes: documents.sizeBytes,
        contentType: documents.contentType,
        visibility: documents.visibility,
      })
      .from(documents)
      .where(ne(documents.id, id));
    const matchedIds = others
      .filter((e) => nearScore(candidate, e as DocLike) >= NEAR_THRESHOLD)
      .map((e) => e.id);
    if (matchedIds.length > 0) {
      await db
        .update(documents)
        .set({ keepVerifiedAt: null, keepVerifiedBy: null })
        .where(inArray(documents.id, matchedIds));
    }
  }

  return new Response(null, { status: 201 });
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const id = stringField(parsed.value, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  const body =
    parsed.value && typeof parsed.value === 'object'
      ? (parsed.value as Record<string, unknown>)
      : {};
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if ('title' in body) {
    const t = typeof body.title === 'string' ? body.title.trim() : '';
    if (!t) return new Response('title is required', { status: 400 });
    if (t.length > INPUT_LIMITS.title)
      return new Response('title is too long', { status: 400 });
    patch.title = t;
  }
  if ('category' in body) {
    const c = typeof body.category === 'string' ? body.category.trim() : '';
    if (!CATEGORIES.includes(c))
      return new Response('Invalid category', { status: 400 });
    patch.category = c;
  }
  if ('visibility' in body) {
    const v = body.visibility;
    if (v !== 'public' && v !== 'homeowner' && v !== 'board')
      return new Response('Invalid visibility', { status: 400 });
    patch.visibility = v;
  }
  await getDb(env).update(documents).set(patch).where(eq(documents.id, id));
  return new Response(null, { status: 204 });
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const id = stringField(parsed.value, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  const [doc] = await getDb(env)
    .select()
    .from(documents)
    .where(eq(documents.id, id));
  if (doc) {
    await env.DOCS.delete(doc.r2Key);
    await env.DOCS.delete(`rag/${id}.md`); // remove the AI-index twin (ADR 0009 §1)
    await getDb(env).delete(documents).where(eq(documents.id, id));
  }
  return new Response(null, { status: 204 });
};
