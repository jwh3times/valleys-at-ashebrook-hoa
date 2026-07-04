import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import { owners } from '../../../server/db/schema';
import { normalizeOwnerInput } from '../../../lib/types';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const rows = await getDb(env).select().from(owners);
  return Response.json(rows);
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const result = normalizeOwnerInput(parsed.value, 'create');
  if (!result.ok) return new Response(result.error, { status: 400 });
  const input = result.value;
  const now = new Date();
  await getDb(env)
    .insert(owners)
    .values({
      id: crypto.randomUUID(),
      // create mode guarantees these are present
      propertyId: input.propertyId!,
      fullName: input.fullName!,
      phone: input.phone ?? null,
      email: input.email ?? null,
      status: input.status ?? 'active',
      notes: input.notes ?? null,
      createdAt: now,
      updatedAt: now,
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
  const result = normalizeOwnerInput(parsed.value, 'patch');
  if (!result.ok) return new Response(result.error, { status: 400 });
  const input = result.value;
  // An owner is not moved between properties via PATCH — only these fields.
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.fullName !== undefined) patch.fullName = input.fullName;
  if (input.phone !== undefined) patch.phone = input.phone;
  if (input.email !== undefined) patch.email = input.email;
  if (input.status !== undefined) patch.status = input.status;
  if (input.notes !== undefined) patch.notes = input.notes;
  await getDb(env).update(owners).set(patch).where(eq(owners.id, id));
  return new Response(null, { status: 204 });
};
