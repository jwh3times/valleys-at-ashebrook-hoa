import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { getDb } from '../../../server/db/client';
import { owners } from '../../../server/db/schema';
import { normalizeAddress } from '../../../server/roster/lookup';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const denied = await requireBoard(request, env);
  if (denied) return denied;
  const rows = await getDb(env).select().from(owners);
  return Response.json(rows);
};

export const POST: APIRoute = async ({ request }) => {
  const denied = await requireBoard(request, env);
  if (denied) return denied;
  const body = (await request.json()) as {
    fullName: string;
    address: string;
    unit?: string;
    phone?: string;
    email?: string;
    notes?: string;
  };
  if (!body.fullName || !body.address)
    return new Response('Bad Request', { status: 400 });
  const now = new Date();
  await getDb(env)
    .insert(owners)
    .values({
      id: crypto.randomUUID(),
      fullName: body.fullName,
      address: body.address,
      addressNormalized: normalizeAddress(body.address),
      unit: body.unit ?? null,
      phone: body.phone ?? null,
      email: body.email ?? null,
      status: 'active',
      notes: body.notes ?? null,
      createdAt: now,
      updatedAt: now,
    });
  return new Response(null, { status: 201 });
};

export const PATCH: APIRoute = async ({ request }) => {
  const denied = await requireBoard(request, env);
  if (denied) return denied;
  const body = (await request.json()) as {
    id: string;
    fullName?: string;
    address?: string;
    unit?: string;
    phone?: string;
    email?: string;
    status?: 'active' | 'inactive';
    notes?: string;
  };
  if (!body.id) return new Response('Bad Request', { status: 400 });
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  const src = body as Record<string, unknown>;
  for (const k of [
    'fullName',
    'address',
    'unit',
    'phone',
    'email',
    'status',
    'notes',
  ]) {
    if (k in src) patch[k] = src[k];
  }
  if (body.address !== undefined)
    patch.addressNormalized = normalizeAddress(body.address);
  await getDb(env).update(owners).set(patch).where(eq(owners.id, body.id));
  return new Response(null, { status: 204 });
};
