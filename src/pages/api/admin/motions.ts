import type { APIRoute } from 'astro';
import { desc, eq, inArray } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import type { Db } from '../../../server/db/client';
import {
  meetings,
  motions,
  boardVotes,
  memberVotes,
  properties,
  resolutions,
} from '../../../server/db/schema';
import {
  normalizeMotionInput,
  VOTE_CHOICES,
  MEMBER_VOTE_CHOICES,
} from '../../../lib/types';
import type { VoteChoice, MemberVoteChoice } from '../../../lib/types';
import { proxyUseError } from '../../../server/content/proxy-guards';

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

/**
 * Look up the `body` of the meeting a motion belongs to, and that meeting's
 * own id — needed by setMemberVotes to scope the proxy guard to the right
 * occasion. Reaching the meeting from a motion takes a second lookup —
 * `motions.meetingId` then `meetings.body` — since `motions` does not carry
 * `body` directly.
 */
async function meetingBodyForMotion(
  db: Db,
  motionId: string,
): Promise<
  { found: false } | { found: true; body: string; meetingId: string }
> {
  const existing = await db
    .select({ meetingId: motions.meetingId })
    .from(motions)
    .where(eq(motions.id, motionId))
    .limit(1);
  if (existing.length === 0) return { found: false };
  const meeting = await db
    .select({ body: meetings.body })
    .from(meetings)
    .where(eq(meetings.id, existing[0].meetingId))
    .limit(1);
  return {
    found: true,
    body: meeting[0]?.body ?? '',
    meetingId: existing[0].meetingId,
  };
}

async function setVotes(db: Db, body: unknown): Promise<Response> {
  const motionId = stringField(body, 'motionId');
  if (!motionId) return new Response('motionId is required', { status: 400 });
  const parsedEntries = parseVoteEntries(body);
  if (!parsedEntries.ok)
    return new Response(parsedEntries.error, { status: 400 });
  const lookup = await meetingBodyForMotion(db, motionId);
  if (!lookup.found) return new Response('Motion not found', { status: 404 });
  // A board roll call against a member meeting's motion (or vice versa) would
  // silently produce a motion with an incoherent electorate.
  if (lookup.body !== 'board')
    return new Response('Motion is not on a board meeting', { status: 409 });
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

interface MemberVoteEntry {
  propertyId: string;
  choice: MemberVoteChoice;
  castByOwnerId: string | null;
  proxyId: string | null;
}

/** Validate the raw `entries` payload for `setMemberVotes`. */
function parseMemberVoteEntries(
  body: unknown,
): { ok: true; value: MemberVoteEntry[] } | { ok: false; error: string } {
  const raw = (body as Record<string, unknown> | null | undefined)?.entries;
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'entries must be an array' };
  }
  const entries: MemberVoteEntry[] = [];
  for (const item of raw) {
    const record = item as Record<string, unknown> | null;
    const propertyId = record?.propertyId;
    const choice = record?.choice;
    const castByOwnerId = record?.castByOwnerId;
    if (
      typeof propertyId !== 'string' ||
      propertyId.trim() === '' ||
      typeof choice !== 'string' ||
      // Member votes are yes/no/abstain only — `recused` and `absent` are
      // board roll-call concepts, deliberately not accepted here.
      !(MEMBER_VOTE_CHOICES as readonly string[]).includes(choice)
    ) {
      return {
        ok: false,
        error: 'Each vote entry needs a propertyId and a valid choice',
      };
    }
    if (
      castByOwnerId !== undefined &&
      castByOwnerId !== null &&
      typeof castByOwnerId !== 'string'
    ) {
      return {
        ok: false,
        error: 'castByOwnerId must be a string when present',
      };
    }
    const proxyId = record?.proxyId;
    if (
      proxyId !== undefined &&
      proxyId !== null &&
      typeof proxyId !== 'string'
    ) {
      return { ok: false, error: 'proxyId must be a string when present' };
    }
    const parsedProxyId = typeof proxyId === 'string' ? proxyId : null;
    // Mutual exclusion: who acted for the lot lives on the (board-only)
    // proxy row, never beside it — a row carrying both could name two
    // different people, and the public read would leak the holder.
    if (parsedProxyId !== null && typeof castByOwnerId === 'string') {
      return {
        ok: false,
        error:
          'An entry cannot carry both proxyId and castByOwnerId — who acted lives on the proxy record',
      };
    }
    entries.push({
      propertyId,
      choice: choice as MemberVoteChoice,
      castByOwnerId: typeof castByOwnerId === 'string' ? castByOwnerId : null,
      proxyId: parsedProxyId,
    });
  }
  return { ok: true, value: entries };
}

async function setMemberVotes(db: Db, body: unknown): Promise<Response> {
  const motionId = stringField(body, 'motionId');
  if (!motionId) return new Response('motionId is required', { status: 400 });
  const parsedEntries = parseMemberVoteEntries(body);
  if (!parsedEntries.ok)
    return new Response(parsedEntries.error, { status: 400 });
  const lookup = await meetingBodyForMotion(db, motionId);
  if (!lookup.found) return new Response('Motion not found', { status: 404 });
  // A member vote against a board meeting's motion (or vice versa) would
  // silently produce a motion with an incoherent electorate.
  if (lookup.body !== 'member')
    return new Response('Motion is not on a member meeting', { status: 409 });

  const proxyFailure = await proxyUseError(
    db,
    parsedEntries.value
      .filter((e) => e.proxyId !== null)
      .map((e) => ({ propertyId: e.propertyId, proxyId: e.proxyId! })),
    { meetingId: lookup.meetingId },
  );
  if (proxyFailure)
    return new Response(proxyFailure.message, {
      status: proxyFailure.status,
    });

  // Weight is stamped from the database, never trusted from the client — a
  // client-supplied weight would let a caller silently rewrite the
  // electorate on a governance record. See properties.voteWeight and
  // memberVotes.weight in schema.ts.
  const propertyIds = parsedEntries.value.map((e) => e.propertyId);
  const weightRows =
    propertyIds.length > 0
      ? await db
          .select({ id: properties.id, voteWeight: properties.voteWeight })
          .from(properties)
          .where(inArray(properties.id, propertyIds))
      : [];
  const weightById = new Map(weightRows.map((r) => [r.id, r.voteWeight]));
  const rows: {
    id: string;
    motionId: string;
    propertyId: string;
    castByOwnerId: string | null;
    proxyId: string | null;
    weight: number;
    choice: MemberVoteChoice;
  }[] = [];
  for (const e of parsedEntries.value) {
    const weight = weightById.get(e.propertyId);
    if (weight === undefined)
      return new Response('Unknown property in entries', { status: 400 });
    rows.push({
      id: crypto.randomUUID(),
      motionId,
      propertyId: e.propertyId,
      castByOwnerId: e.castByOwnerId,
      proxyId: e.proxyId,
      weight,
      choice: e.choice,
    });
  }
  // Full replace, atomically: a property omitted from `entries` is removed,
  // not left at its previous value. db.batch() requires a non-empty array,
  // and clearing the vote set entirely (rows.length === 0) is legitimate, so
  // the insert statement is only included when there is something to insert.
  await db.batch([
    db.delete(memberVotes).where(eq(memberVotes.motionId, motionId)),
    ...(rows.length > 0 ? [db.insert(memberVotes).values(rows)] : []),
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
    case 'setMemberVotes':
      return setMemberVotes(db, parsed.value);
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
  const db = getDb(env);
  // resolutions.adopted_by_motion_id is ON DELETE SET NULL, so without this
  // pre-check deleting a cited motion would silently blank an in-force
  // resolution's adoption provenance instead of refusing — and PATCH
  // deliberately cannot write that column back, so the loss would be
  // unrecoverable through the API. Pre-checking gives a readable message
  // instead of a silent SET NULL. See ADR 0016.
  const cited = await db
    .select({ id: resolutions.id })
    .from(resolutions)
    .where(eq(resolutions.adoptedByMotionId, id))
    .limit(1);
  if (cited.length > 0)
    return new Response(
      "This motion is cited as a resolution's adopting motion — it cannot be deleted while that citation stands.",
      { status: 409 },
    );
  // Deleting a motion cascades its votes via FK.
  await db.delete(motions).where(eq(motions.id, id));
  return new Response(null, { status: 204 });
};
