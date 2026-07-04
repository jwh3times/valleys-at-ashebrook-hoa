import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { getDb } from '../../../server/db/client';
import { announcements } from '../../../server/db/schema';

export const prerender = false;

const VISIBILITIES = ['public', 'homeowner', 'board'] as const;

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const body = (await request.json()) as {
    title?: string;
    body?: string;
    date?: string;
    pinned?: boolean;
    visibility?: string;
  };
  if (!body.title || !body.body || !body.date)
    return new Response('Bad Request', { status: 400 });
  if (
    body.visibility !== undefined &&
    !(VISIBILITIES as readonly string[]).includes(body.visibility)
  )
    return new Response('Bad Request', { status: 400 });
  await getDb(env)
    .insert(announcements)
    .values({
      id: crypto.randomUUID(),
      title: body.title,
      body: body.body,
      date: body.date,
      pinned: body.pinned ?? false,
      visibility: (body.visibility ?? 'public') as
        'public' | 'homeowner' | 'board',
    });
  return new Response(null, { status: 201 });
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const body = (await request.json()) as {
    id?: string;
    title?: string;
    body?: string;
    date?: string;
    pinned?: boolean;
    visibility?: string;
  };
  if (!body.id) return new Response('Bad Request', { status: 400 });
  if (
    body.visibility !== undefined &&
    !(VISIBILITIES as readonly string[]).includes(body.visibility)
  )
    return new Response('Bad Request', { status: 400 });
  const patch: Record<string, unknown> = {};
  for (const k of ['title', 'body', 'date', 'pinned', 'visibility'] as const)
    if (k in body) patch[k] = body[k];
  if (Object.keys(patch).length === 0)
    return new Response('Bad Request', { status: 400 });
  await getDb(env)
    .update(announcements)
    .set(patch)
    .where(eq(announcements.id, body.id));
  return new Response(null, { status: 204 });
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const body = (await request.json()) as { id?: string };
  if (!body.id) return new Response('Bad Request', { status: 400 });
  await getDb(env).delete(announcements).where(eq(announcements.id, body.id));
  return new Response(null, { status: 204 });
};
