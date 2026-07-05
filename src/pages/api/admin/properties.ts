import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import { properties, owners } from '../../../server/db/schema';
import { normalizeAddress } from '../../../server/roster/lookup';
import { normalizePropertyInput } from '../../../lib/types';

export const prerender = false;

// Drizzle wraps the D1 error ("Failed query: …") and puts the SQLite message on
// the cause chain, so walk it rather than checking the top-level message.
function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause)
    if (/UNIQUE constraint failed/i.test(e.message)) return true;
  return false;
}

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
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

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const result = normalizePropertyInput(parsed.value, 'create');
  if (!result.ok) return new Response(result.error, { status: 400 });
  const input = result.value;
  const address = input.address!; // create mode guarantees address
  const now = new Date();
  try {
    await getDb(env)
      .insert(properties)
      .values({
        id: crypto.randomUUID(),
        address,
        addressNormalized: normalizeAddress(address),
        unit: input.unit ?? null,
        status: input.status ?? 'active',
        notes: input.notes ?? null,
        createdAt: now,
        updatedAt: now,
      });
  } catch (err) {
    // Unique on address_normalized: a home with this address already exists.
    if (isUniqueViolation(err))
      return new Response('A property with this address already exists', {
        status: 409,
      });
    throw err;
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
  const result = normalizePropertyInput(parsed.value, 'patch');
  if (!result.ok) return new Response(result.error, { status: 400 });
  const input = result.value;
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.address !== undefined) {
    patch.address = input.address;
    patch.addressNormalized = normalizeAddress(input.address);
  }
  if (input.unit !== undefined) patch.unit = input.unit;
  if (input.status !== undefined) patch.status = input.status;
  if (input.notes !== undefined) patch.notes = input.notes;
  try {
    await getDb(env).update(properties).set(patch).where(eq(properties.id, id));
  } catch (err) {
    if (isUniqueViolation(err))
      return new Response('A property with this address already exists', {
        status: 409,
      });
    throw err;
  }
  return new Response(null, { status: 204 });
};
