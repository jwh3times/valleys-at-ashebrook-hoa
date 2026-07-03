import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { getDb } from '../../../server/db/client';
import { properties, owners } from '../../../server/db/schema';
import { normalizeAddress } from '../../../server/roster/lookup';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const denied = await requireBoard(request, env);
  if (denied) return denied;
  const db = getDb(env);
  const props = await db.select().from(properties);
  const people = await db.select().from(owners);
  const byProperty = new Map<string, typeof people>();
  for (const p of people) {
    const list = byProperty.get(p.propertyId) ?? [];
    list.push(p);
    byProperty.set(p.propertyId, list);
  }
  return Response.json(
    props.map((p) => ({ ...p, owners: byProperty.get(p.id) ?? [] })),
  );
};

export const POST: APIRoute = async ({ request }) => {
  const denied = await requireBoard(request, env);
  if (denied) return denied;
  const body = (await request.json()) as {
    address: string;
    unit?: string;
    notes?: string;
  };
  if (!body.address) return new Response('Bad Request', { status: 400 });
  const now = new Date();
  await getDb(env)
    .insert(properties)
    .values({
      id: crypto.randomUUID(),
      address: body.address,
      addressNormalized: normalizeAddress(body.address),
      unit: body.unit ?? null,
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
    address?: string;
    unit?: string;
    status?: 'active' | 'inactive';
    notes?: string;
  };
  if (!body.id) return new Response('Bad Request', { status: 400 });
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  const src = body as Record<string, unknown>;
  for (const k of ['address', 'unit', 'status', 'notes']) {
    if (k in src) patch[k] = src[k];
  }
  if (body.address !== undefined)
    patch.addressNormalized = normalizeAddress(body.address);
  await getDb(env)
    .update(properties)
    .set(patch)
    .where(eq(properties.id, body.id));
  return new Response(null, { status: 204 });
};
