import type { APIRoute } from 'astro';
import { desc, eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import type { Db } from '../../../server/db/client';
import { meetings, motions, boardVotes } from '../../../server/db/schema';
import { normalizeMotionInput, VOTE_CHOICES } from '../../../lib/types';
import type { VoteChoice } from '../../../lib/types';

export const prerender = false;

interface VoteEntry {
  personId: string;
  choice: VoteChoice;
}

/** Validate the raw `entries` payload for `setVotes`. */
function parseVoteEntries(
  body: unknown,
): { ok: true; value: VoteEntry[] } | { ok: false; error: string } {
  const raw = (body as Record<string, unknown> | null | undefined)?.entries;
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'entries must be an array' };
  }
  const entries: VoteEntry[] = [];
  for (const item of raw) {
    const record = item as Record<string, unknown> | null;
    const personId = record?.personId;
    const choice = record?.choice;
    if (
      typeof personId !== 'string' ||
      personId.trim() === '' ||
      typeof choice !== 'string' ||
      !(VOTE_CHOICES as readonly string[]).includes(choice)
    ) {
      return {
        ok: false,
        error: 'Each vote entry needs a personId and a valid choice',
      };
    }
    entries.push({ personId, choice: choice as VoteChoice });
  }
  return { ok: true, value: entries };
}

async function setVotes(db: Db, body: unknown): Promise<Response> {
  const motionId = stringField(body, 'motionId');
  if (!motionId) return new Response('motionId is required', { status: 400 });
  const parsedEntries = parseVoteEntries(body);
  if (!parsedEntries.ok)
    return new Response(parsedEntries.error, { status: 400 });
  const existing = await db
    .select({ id: motions.id })
    .from(motions)
    .where(eq(motions.id, motionId))
    .limit(1);
  if (existing.length === 0)
    return new Response('Motion not found', { status: 404 });
  const rows = parsedEntries.value.map((e) => ({
    id: crypto.randomUUID(),
    motionId,
    personId: e.personId,
    choice: e.choice,
  }));
  // Full replace, atomically: a person omitted from `entries` is removed, not
  // left at their previous value. db.batch() requires a non-empty array, and
  // clearing the roll call entirely (rows.length === 0) is legitimate, so the
  // insert statement is only included when there is something to insert.
  await db.batch([
    db.delete(boardVotes).where(eq(boardVotes.motionId, motionId)),
    ...(rows.length > 0 ? [db.insert(boardVotes).values(rows)] : []),
  ] as never);
  return new Response(null, { status: 204 });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const db = getDb(env);
  const action = stringField(parsed.value, 'action');

  switch (action) {
    case 'setVotes':
      return setVotes(db, parsed.value);
    case '':
      break;
    default:
      return new Response('Unknown action', { status: 400 });
  }

  const result = normalizeMotionInput(parsed.value, 'create');
  if (!result.ok) return new Response(result.error, { status: 400 });
  const input = result.value;
  const meeting = await db
    .select({ id: meetings.id })
    .from(meetings)
    .where(eq(meetings.id, input.meetingId!))
    .limit(1);
  if (meeting.length === 0)
    return new Response('Meeting not found', { status: 404 });
  const existing = await db
    .select({ sequence: motions.sequence })
    .from(motions)
    .where(eq(motions.meetingId, input.meetingId!))
    .orderBy(desc(motions.sequence))
    .limit(1);
  const sequence = (existing[0]?.sequence ?? 0) + 1;
  const ctx = await resolveAuthContext(locals, request, env);
  const now = new Date();
  const id = crypto.randomUUID();
  await db.insert(motions).values({
    id,
    meetingId: input.meetingId!,
    sequence,
    // create mode guarantees text and outcome are present
    text: input.text!,
    moverPersonId: input.moverPersonId ?? null,
    secondPersonId: input.secondPersonId ?? null,
    outcome: input.outcome!,
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
  const result = normalizeMotionInput(parsed.value, 'patch');
  if (!result.ok) return new Response(result.error, { status: 400 });
  const input = result.value;
  const db = getDb(env);
  const existing = await db
    .select({ id: motions.id })
    .from(motions)
    .where(eq(motions.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Motion not found', { status: 404 });
  // A motion is not moved between meetings via PATCH — only these fields.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.text !== undefined) set.text = input.text;
  if (input.moverPersonId !== undefined)
    set.moverPersonId = input.moverPersonId;
  if (input.secondPersonId !== undefined)
    set.secondPersonId = input.secondPersonId;
  if (input.outcome !== undefined) set.outcome = input.outcome;
  await db.update(motions).set(set).where(eq(motions.id, id));
  return new Response(null, { status: 204 });
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const id = stringField(parsed.value, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  // Deleting a motion cascades its votes via FK.
  await getDb(env).delete(motions).where(eq(motions.id, id));
  return new Response(null, { status: 204 });
};
