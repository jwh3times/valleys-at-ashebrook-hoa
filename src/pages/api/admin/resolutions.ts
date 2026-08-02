import type { APIRoute } from 'astro';
import { and, eq, ne } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import type { Db } from '../../../server/db/client';
import { resolutions, motions } from '../../../server/db/schema';
import { normalizeResolutionInput, isoDateOrError } from '../../../lib/types';
import { fetchAdminResolutions } from '../../../server/content/reads';

export const prerender = false;

const DUPLICATE_NUMBER = 'A resolution with this number already exists.';

/** Check whether `number` is already used by another resolution row. `excludeId` lets PATCH ignore the row being updated. */
async function numberInUse(
  db: Db,
  number: string,
  excludeId?: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: resolutions.id })
    .from(resolutions)
    .where(
      excludeId
        ? and(eq(resolutions.number, number), ne(resolutions.id, excludeId))
        : eq(resolutions.number, number),
    )
    .limit(1);
  return rows.length > 0;
}

async function adopt(db: Db, body: unknown): Promise<Response> {
  const id = stringField(body, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  const effectiveDate = stringField(body, 'effectiveDate');
  if (!effectiveDate)
    return new Response('effectiveDate is required', { status: 400 });
  // Same format+calendar check the create/patch path runs via
  // normalizeResolutionInput -> nullableIsoDate; adopt/supersede read this
  // field as a transition argument via stringField instead, so without this
  // call they would skip validation entirely and write garbage straight to
  // the column (see ADR 0016 — a resolution that has ever been in_force is
  // supposed to have a real effective date).
  const dateCheck = isoDateOrError(effectiveDate, 'effectiveDate');
  if (!dateCheck.ok) return new Response(dateCheck.error, { status: 400 });
  const motionId = stringField(body, 'motionId') || null;

  const existing = await db
    .select({ status: resolutions.status })
    .from(resolutions)
    .where(eq(resolutions.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Resolution not found', { status: 404 });
  if (existing[0].status !== 'draft')
    return new Response('Resolution is not a draft', { status: 409 });

  if (motionId) {
    const motion = await db
      .select({ id: motions.id })
      .from(motions)
      .where(eq(motions.id, motionId))
      .limit(1);
    if (motion.length === 0)
      return new Response('Motion not found', { status: 404 });
  }

  await db
    .update(resolutions)
    .set({
      status: 'in_force',
      effectiveDate,
      adoptedByMotionId: motionId,
      updatedAt: new Date(),
    })
    .where(eq(resolutions.id, id));
  return new Response(null, { status: 204 });
}

async function supersede(db: Db, body: unknown): Promise<Response> {
  const id = stringField(body, 'id');
  const supersedesId = stringField(body, 'supersedesId');
  if (!id || !supersedesId)
    return new Response('id and supersedesId are required', { status: 400 });
  const effectiveDate = stringField(body, 'effectiveDate');
  if (!effectiveDate)
    return new Response('effectiveDate is required', { status: 400 });
  // Same format+calendar check as adopt — see the comment there.
  const dateCheck = isoDateOrError(effectiveDate, 'effectiveDate');
  if (!dateCheck.ok) return new Response(dateCheck.error, { status: 400 });

  // Preconditions are checked in this exact order so the returned status
  // code is deterministic: a self-supersession on a missing row must read as
  // 404, not 409, and a not-in-force predecessor must be reported before an
  // already-superseded one.
  const newRow = await db
    .select({ id: resolutions.id, status: resolutions.status })
    .from(resolutions)
    .where(eq(resolutions.id, id))
    .limit(1);
  const oldRow =
    id === supersedesId
      ? newRow
      : await db
          .select({ id: resolutions.id, status: resolutions.status })
          .from(resolutions)
          .where(eq(resolutions.id, supersedesId))
          .limit(1);
  if (newRow.length === 0 || oldRow.length === 0)
    return new Response('Resolution not found', { status: 404 });
  if (id === supersedesId)
    return new Response('A resolution cannot supersede itself', {
      status: 409,
    });
  if (oldRow[0].status !== 'in_force')
    return new Response('Predecessor is not in force', { status: 409 });
  // The unique index on supersedes_id would reject this insert anyway; this
  // pre-check exists only so the caller gets a readable message instead of a
  // raw D1 constraint error.
  const alreadySuperseded = await db
    .select({ id: resolutions.id })
    .from(resolutions)
    .where(eq(resolutions.supersedesId, supersedesId))
    .limit(1);
  if (alreadySuperseded.length > 0)
    return new Response('Predecessor is already superseded', {
      status: 409,
    });
  if (newRow[0].status !== 'draft')
    return new Response('Superseding resolution must be a draft', {
      status: 409,
    });

  // Mirrors adopt: real supersession happens by motion at a meeting, and
  // PATCH cannot write adoptedByMotionId, so without recording it here a
  // resolution adopted by supersession could never have its adopting motion
  // on record — a permanent hole, not a simplification.
  const motionId = stringField(body, 'motionId') || null;
  if (motionId) {
    const motion = await db
      .select({ id: motions.id })
      .from(motions)
      .where(eq(motions.id, motionId))
      .limit(1);
    if (motion.length === 0)
      return new Response('Motion not found', { status: 404 });
  }

  // Both writes must land together: a new resolution taking effect with no
  // predecessor marked superseded (or vice versa) would leave the chain
  // inconsistent, so this is the one action that needs db.batch().
  await db.batch([
    db
      .update(resolutions)
      .set({
        status: 'in_force',
        supersedesId,
        effectiveDate,
        adoptedByMotionId: motionId,
        updatedAt: new Date(),
      })
      .where(eq(resolutions.id, id)),
    db
      .update(resolutions)
      .set({ status: 'superseded', updatedAt: new Date() })
      .where(eq(resolutions.id, supersedesId)),
  ] as never);
  return new Response(null, { status: 204 });
}

async function repeal(db: Db, body: unknown): Promise<Response> {
  const id = stringField(body, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  const existing = await db
    .select({ status: resolutions.status })
    .from(resolutions)
    .where(eq(resolutions.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Resolution not found', { status: 404 });
  if (existing[0].status !== 'in_force')
    return new Response('Resolution is not in force', { status: 409 });
  // Only this row's status changes — supersedesId links (on this row and on
  // any row that points at it) are left exactly as they are, so the chain
  // that led here stays readable.
  await db
    .update(resolutions)
    .set({ status: 'repealed', updatedAt: new Date() })
    .where(eq(resolutions.id, id));
  return new Response(null, { status: 204 });
}

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  return Response.json(await fetchAdminResolutions(env));
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const db = getDb(env);
  const action = stringField(parsed.value, 'action');

  switch (action) {
    case 'adopt':
      return adopt(db, parsed.value);
    case 'supersede':
      return supersede(db, parsed.value);
    case 'repeal':
      return repeal(db, parsed.value);
    case '':
      break;
    default:
      return new Response('Unknown action', { status: 400 });
  }

  const result = normalizeResolutionInput(parsed.value, 'create');
  if (!result.ok) return new Response(result.error, { status: 400 });
  // create mode guarantees number, title, and bodyMd are present
  if (await numberInUse(db, result.value.number!))
    return new Response(DUPLICATE_NUMBER, { status: 409 });
  const ctx = await resolveAuthContext(locals, request, env);
  const now = new Date();
  const id = crypto.randomUUID();
  await db.insert(resolutions).values({
    id,
    number: result.value.number!,
    title: result.value.title!,
    bodyMd: result.value.bodyMd!,
    effectiveDate: result.value.effectiveDate ?? null,
    visibility: result.value.visibility ?? 'board',
    createdBy: ctx?.userId ?? 'unknown',
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
  // The normalizer rejects any payload carrying status, supersedesId, or
  // adoptedByMotionId — those are transition-only, maintained by
  // adopt/supersede/repeal together with their preconditions.
  const result = normalizeResolutionInput(parsed.value, 'patch');
  if (!result.ok) return new Response(result.error, { status: 400 });
  const input = result.value;
  if (Object.keys(input).length === 0)
    return new Response('No fields to update', { status: 400 });
  const db = getDb(env);
  const existing = await db
    .select({ id: resolutions.id, status: resolutions.status })
    .from(resolutions)
    .where(eq(resolutions.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Resolution not found', { status: 404 });
  if (input.number !== undefined && (await numberInUse(db, input.number, id)))
    return new Response(DUPLICATE_NUMBER, { status: 409 });
  // nullableIsoDate maps both an explicit null and a blank string to null, so
  // this also catches `effectiveDate: ''`. Clearing the date on a resolution
  // that has already taken effect would reproduce exactly the state adopt's
  // required-effectiveDate rule exists to prevent; clearing it on a draft
  // (which never had one that mattered) stays legal.
  if (input.effectiveDate === null && existing[0].status !== 'draft')
    return new Response(
      'effectiveDate cannot be cleared on a resolution that has taken effect',
      { status: 409 },
    );
  // A resolution is not moved between chains via PATCH — only these fields.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.number !== undefined) set.number = input.number;
  if (input.title !== undefined) set.title = input.title;
  if (input.bodyMd !== undefined) set.bodyMd = input.bodyMd;
  if (input.effectiveDate !== undefined)
    set.effectiveDate = input.effectiveDate;
  if (input.visibility !== undefined) set.visibility = input.visibility;
  await db.update(resolutions).set(set).where(eq(resolutions.id, id));
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
  // A record that has been in force is history; unadopting is not a concept,
  // so the only removable resolution is one that never took effect.
  const existing = await db
    .select({ status: resolutions.status })
    .from(resolutions)
    .where(eq(resolutions.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Resolution not found', { status: 404 });
  if (existing[0].status !== 'draft')
    return new Response(
      'Only a draft resolution can be deleted — one that has taken effect is part of the record.',
      { status: 409 },
    );
  // The RESTRICT foreign key would reject this anyway; pre-checking gives a
  // readable message instead of a raw D1 constraint error, same reasoning as
  // board-people.ts's delete guard.
  const superseding = await db
    .select({ id: resolutions.id })
    .from(resolutions)
    .where(eq(resolutions.supersedesId, id))
    .limit(1);
  if (superseding.length > 0)
    return new Response(
      'This resolution is superseded by another — that link must be removed first.',
      { status: 409 },
    );
  await db.delete(resolutions).where(eq(resolutions.id, id));
  return new Response(null, { status: 204 });
};
