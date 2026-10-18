import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import { fetchAdminDocuments } from '../../../server/content/reads';
import { documents } from '../../../server/db/schema';
import { DOCUMENT_CATEGORIES, INPUT_LIMITS } from '../../../lib/types';
import {
  MAX_DOCUMENT_BYTES,
  deleteDocuments,
  storeDocument,
  type Visibility,
} from '../../../server/documents/store';

export const prerender = false;

const VISIBILITIES = ['public', 'homeowner', 'board'] as const;
const CATEGORIES: readonly string[] = DOCUMENT_CATEGORIES;

function formText(form: FormData, key: string): string | null {
  const value = form.get(key);
  return typeof value === 'string' ? value : null;
}

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  return Response.json(await fetchAdminDocuments(env));
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const ctx = await resolveAuthContext(locals, request, env);
  const form = await request.formData();
  const file = form.get('file');
  const title = (formText(form, 'title') ?? '').trim();
  const category = (formText(form, 'category') ?? '').trim();
  const visibility = formText(form, 'visibility') ?? 'board';
  if (!(file instanceof File) || !title)
    return new Response('Bad Request', { status: 400 });
  if (title.length > INPUT_LIMITS.title)
    return new Response('title is too long', { status: 400 });
  if (!CATEGORIES.includes(category))
    return new Response('Invalid category', { status: 400 });
  if (!(VISIBILITIES as readonly string[]).includes(visibility))
    return new Response('Bad Request', { status: 400 });
  // Refuse an oversized file before reading it into memory; the store checks
  // the bytes it is handed as well.
  if (file.size > MAX_DOCUMENT_BYTES)
    return new Response('Too large', { status: 413 });

  const result = await storeDocument(env, {
    bytes: await file.arrayBuffer(),
    filename: file.name,
    title,
    category,
    visibility: visibility as Visibility,
    uploadedBy: ctx?.userId ?? null,
    confirmDuplicate: formText(form, 'confirmDuplicate') === 'true',
  });
  switch (result.kind) {
    case 'stored':
      return new Response(null, { status: 201 });
    case 'too-large':
      return new Response('Too large', { status: 413 });
    case 'unsupported-type':
      return new Response('Unsupported file type', { status: 415 });
    case 'exact-duplicate':
      return Response.json(
        { error: 'exact-duplicate', existing: result.existing },
        { status: 409 },
      );
    case 'near-duplicate':
      return Response.json(
        { warning: 'near-duplicate', similar: result.similar },
        { status: 409 },
      );
  }
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
  // Answer 404 for an id that is not there rather than 204: a silent success
  // for a document that does not exist tells the caller their edit landed.
  const updated = await getDb(env)
    .update(documents)
    .set(patch)
    .where(eq(documents.id, id))
    .returning({ id: documents.id });
  if (updated.length === 0)
    return new Response('Document not found', { status: 404 });
  return new Response(null, { status: 204 });
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const id = stringField(parsed.value, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  const result = await deleteDocuments(env, [id]);
  if (result.kind === 'cited')
    return Response.json(
      { error: 'document-cited', citedBy: result.citedBy },
      { status: 409 },
    );
  return new Response(null, { status: 204 });
};
