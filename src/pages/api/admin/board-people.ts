import type { APIRoute } from 'astro';
import { eq, asc } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import { boardPeople, boardTerms } from '../../../server/db/schema';
import { normalizeBoardPersonInput } from '../../../lib/types';

export const prerender = false;

/** People with their terms nested, mirroring the properties/owners read. */
export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const db = getDb(env);
  const people = await db
    .select({
      id: boardPeople.id,
      fullName: boardPeople.fullName,
      userId: boardPeople.userId,
    })
    .from(boardPeople)
    .orderBy(asc(boardPeople.fullName));
  const terms = await db
    .select({
      id: boardTerms.id,
      personId: boardTerms.personId,
      title: boardTerms.title,
      termStart: boardTerms.termStart,
      termEnd: boardTerms.termEnd,
    })
    .from(boardTerms)
    .orderBy(asc(boardTerms.termStart));
  const byPerson = new Map<string, typeof terms>();
  for (const t of terms) {
    const list = byPerson.get(t.personId) ?? [];
    list.push(t);
    byPerson.set(t.personId, list);
  }
  return Response.json(
    people.map((p) => ({ ...p, terms: byPerson.get(p.id) ?? [] })),
  );
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const result = normalizeBoardPersonInput(parsed.value, 'create');
  if (!result.ok) return new Response(result.error, { status: 400 });
  const now = new Date();
  const id = crypto.randomUUID();
  await getDb(env)
    .insert(boardPeople)
    .values({
      id,
      // create mode guarantees fullName is present
      fullName: result.value.fullName!,
      userId: result.value.userId ?? null,
      createdAt: now,
      updatedAt: now,
    });
  return Response.json({ id }, { status: 201 });
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const id = stringField(parsed.value, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  const result = normalizeBoardPersonInput(parsed.value, 'patch');
  if (!result.ok) return new Response(result.error, { status: 400 });
  if (Object.keys(result.value).length === 0)
    return new Response('No fields to update', { status: 400 });
  await getDb(env)
    .update(boardPeople)
    .set({ ...result.value, updatedAt: new Date() })
    .where(eq(boardPeople.id, id));
  return new Response(null, { status: 204 });
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const id = stringField(parsed.value, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  const db = getDb(env);
  // Service history is the record. Refuse explicitly rather than relying on
  // the ON DELETE RESTRICT foreign key, so the 409 is deterministic.
  const served = await db
    .select({ id: boardTerms.id })
    .from(boardTerms)
    .where(eq(boardTerms.personId, id))
    .limit(1);
  if (served.length > 0)
    return new Response(
      'This person has a term of service on record — remove their terms first.',
      { status: 409 },
    );
  await db.delete(boardPeople).where(eq(boardPeople.id, id));
  return new Response(null, { status: 204 });
};
