import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { getAuthContext } from '../../../server/authz/context';
import { requireRole, Forbidden } from '../../../server/authz/guards';
import { getDb } from '../../../server/db/client';
import { owners } from '../../../server/db/schema';
import { normalizeAddress } from '../../../server/roster/lookup';

export const prerender = false;

async function requireBoard(request: Request): Promise<Response | null> {
  const ctx = await getAuthContext(request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });
  try {
    requireRole(ctx, 'board');
  } catch (e) {
    if (e instanceof Forbidden) return new Response('Forbidden', { status: 403 });
    throw e;
  }
  return null;
}

export const GET: APIRoute = async ({ request }) => {
  const denied = await requireBoard(request);
  if (denied) return denied;
  const rows = await getDb(env).select().from(owners);
  return Response.json(rows);
};

export const POST: APIRoute = async ({ request }) => {
  const denied = await requireBoard(request);
  if (denied) return denied;
  const body = (await request.json()) as {
    fullName: string;
    address: string;
    unit?: string;
    phone?: string;
    email?: string;
    notes?: string;
  };
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
  const denied = await requireBoard(request);
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
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  const src = body as Record<string, unknown>;
  for (const k of ['fullName', 'address', 'unit', 'phone', 'email', 'status', 'notes']) {
    if (k in src) patch[k] = src[k];
  }
  if (body.address !== undefined) patch.addressNormalized = normalizeAddress(body.address);
  await getDb(env).update(owners).set(patch).where(eq(owners.id, body.id));
  return new Response(null, { status: 204 });
};
