import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import { boardPeople, boardTerms } from '../../../server/db/schema';
import { normalizeBoardTermInput, termRangeError } from '../../../lib/types';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const result = normalizeBoardTermInput(parsed.value, 'create');
  if (!result.ok) return new Response(result.error, { status: 400 });
  const input = result.value;
  const db = getDb(env);
  const person = await db
    .select({ id: boardPeople.id })
    .from(boardPeople)
    .where(eq(boardPeople.id, input.personId!))
    .limit(1);
  if (person.length === 0)
    return new Response('Board person not found', { status: 404 });
  const now = new Date();
  const id = crypto.randomUUID();
  await db.insert(boardTerms).values({
    id,
    // create mode guarantees personId and termStart are present
    personId: input.personId!,
    title: input.title ?? null,
    termStart: input.termStart!,
    termEnd: input.termEnd ?? null,
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
  const result = normalizeBoardTermInput(parsed.value, 'patch');
  if (!result.ok) return new Response(result.error, { status: 400 });
  const patch = result.value;
  if (Object.keys(patch).length === 0)
    return new Response('No fields to update', { status: 400 });
  const db = getDb(env);
  const existing = await db
    .select({
      termStart: boardTerms.termStart,
      termEnd: boardTerms.termEnd,
    })
    .from(boardTerms)
    .where(eq(boardTerms.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Term not found', { status: 404 });
  // A patch may supply either end alone, so re-check the merged range.
  const merged = {
    termStart: patch.termStart ?? existing[0].termStart,
    termEnd: patch.termEnd !== undefined ? patch.termEnd : existing[0].termEnd,
  };
  const rangeError = termRangeError(merged.termStart, merged.termEnd);
  if (rangeError) return new Response(rangeError, { status: 400 });
  await db
    .update(boardTerms)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(boardTerms.id, id));
  return new Response(null, { status: 204 });
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const id = stringField(parsed.value, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  await getDb(env).delete(boardTerms).where(eq(boardTerms.id, id));
  return new Response(null, { status: 204 });
};
