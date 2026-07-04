import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import { announcements } from '../../../server/db/schema';
import { normalizeAnnouncementInput } from '../../../lib/types';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const result = normalizeAnnouncementInput(parsed.value, 'create');
  if (!result.ok) return new Response(result.error, { status: 400 });
  const input = result.value;
  await getDb(env)
    .insert(announcements)
    .values({
      id: crypto.randomUUID(),
      // create mode guarantees these are present
      title: input.title!,
      body: input.body!,
      date: input.date!,
      pinned: input.pinned ?? false,
      visibility: input.visibility ?? 'public',
    });
  return new Response(null, { status: 201 });
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const id = stringField(parsed.value, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  const result = normalizeAnnouncementInput(parsed.value, 'patch');
  if (!result.ok) return new Response(result.error, { status: 400 });
  const patch = result.value;
  if (Object.keys(patch).length === 0)
    return new Response('No fields to update', { status: 400 });
  await getDb(env)
    .update(announcements)
    .set(patch)
    .where(eq(announcements.id, id));
  return new Response(null, { status: 204 });
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const id = stringField(parsed.value, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  await getDb(env).delete(announcements).where(eq(announcements.id, id));
  return new Response(null, { status: 204 });
};
