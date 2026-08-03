import type { APIRoute } from 'astro';
import { eq, inArray } from 'drizzle-orm';
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
  boardAttendance,
  memberAttendance,
  motions,
  resolutions,
  elections,
} from '../../../server/db/schema';
import { normalizeMeetingInput } from '../../../lib/types';
import { proxyUseError } from '../../../server/content/proxy-guards';
import {
  fetchAdminMeetings,
  fetchAdminMeeting,
} from '../../../server/content/reads';

export const prerender = false;

interface AttendanceEntry {
  personId: string;
  present: boolean;
}

/** Validate the raw `entries` payload for `setAttendance`. */
function parseAttendanceEntries(
  body: unknown,
): { ok: true; value: AttendanceEntry[] } | { ok: false; error: string } {
  const raw = (body as Record<string, unknown> | null | undefined)?.entries;
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'entries must be an array' };
  }
  const entries: AttendanceEntry[] = [];
  for (const item of raw) {
    const record = item as Record<string, unknown> | null;
    const personId = record?.personId;
    const present = record?.present;
    if (
      typeof personId !== 'string' ||
      personId.trim() === '' ||
      typeof present !== 'boolean'
    ) {
      return {
        ok: false,
        error: 'Each attendance entry needs a personId and a present boolean',
      };
    }
    entries.push({ personId, present });
  }
  return { ok: true, value: entries };
}

async function setAttendance(db: Db, body: unknown): Promise<Response> {
  const meetingId = stringField(body, 'meetingId');
  if (!meetingId) return new Response('meetingId is required', { status: 400 });
  const parsedEntries = parseAttendanceEntries(body);
  if (!parsedEntries.ok)
    return new Response(parsedEntries.error, { status: 400 });
  const existing = await db
    .select({ id: meetings.id, body: meetings.body })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);
  if (existing.length === 0)
    return new Response('Meeting not found', { status: 404 });
  // Board attendance against a member meeting (or vice versa) would silently
  // produce a meeting with both kinds of attendance and an incoherent quorum.
  if (existing[0].body !== 'board')
    return new Response('Meeting is not a board meeting', { status: 409 });
  const rows = parsedEntries.value.map((e) => ({
    id: crypto.randomUUID(),
    meetingId,
    personId: e.personId,
    present: e.present,
  }));
  // Full replace, atomically: a person omitted from `entries` is removed, not
  // left at their previous value. db.batch() requires a non-empty array, and
  // clearing attendance entirely (rows.length === 0) is legitimate, so the
  // insert statement is only included when there is something to insert.
  await db.batch([
    db.delete(boardAttendance).where(eq(boardAttendance.meetingId, meetingId)),
    ...(rows.length > 0 ? [db.insert(boardAttendance).values(rows)] : []),
  ] as never);
  return new Response(null, { status: 204 });
}

interface MemberAttendanceEntry {
  propertyId: string;
  present: boolean;
  representedByOwnerId: string | null;
  proxyId: string | null;
}

/** Validate the raw `entries` payload for `setMemberAttendance`. */
function parseMemberAttendanceEntries(
  body: unknown,
): { ok: true; value: MemberAttendanceEntry[] } | { ok: false; error: string } {
  const raw = (body as Record<string, unknown> | null | undefined)?.entries;
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'entries must be an array' };
  }
  const entries: MemberAttendanceEntry[] = [];
  for (const item of raw) {
    const record = item as Record<string, unknown> | null;
    const propertyId = record?.propertyId;
    const present = record?.present;
    const representedByOwnerId = record?.representedByOwnerId;
    if (
      typeof propertyId !== 'string' ||
      propertyId.trim() === '' ||
      typeof present !== 'boolean'
    ) {
      return {
        ok: false,
        error: 'Each attendance entry needs a propertyId and a present boolean',
      };
    }
    if (
      representedByOwnerId !== undefined &&
      representedByOwnerId !== null &&
      typeof representedByOwnerId !== 'string'
    ) {
      return {
        ok: false,
        error: 'representedByOwnerId must be a string when present',
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
    if (parsedProxyId !== null && typeof representedByOwnerId === 'string') {
      return {
        ok: false,
        error:
          'An entry cannot carry both proxyId and representedByOwnerId — who acted lives on the proxy record',
      };
    }
    entries.push({
      propertyId,
      present,
      representedByOwnerId:
        typeof representedByOwnerId === 'string' ? representedByOwnerId : null,
      proxyId: parsedProxyId,
    });
  }
  return { ok: true, value: entries };
}

async function setMemberAttendance(db: Db, body: unknown): Promise<Response> {
  const meetingId = stringField(body, 'meetingId');
  if (!meetingId) return new Response('meetingId is required', { status: 400 });
  const parsedEntries = parseMemberAttendanceEntries(body);
  if (!parsedEntries.ok)
    return new Response(parsedEntries.error, { status: 400 });
  const existing = await db
    .select({ id: meetings.id, body: meetings.body })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);
  if (existing.length === 0)
    return new Response('Meeting not found', { status: 404 });
  // Recording member attendance against a board meeting would silently
  // produce a meeting with both kinds of attendance and an incoherent quorum.
  if (existing[0].body !== 'member')
    return new Response('Meeting is not a member meeting', { status: 409 });
  const proxyFailure = await proxyUseError(
    db,
    parsedEntries.value
      .filter((e) => e.proxyId !== null)
      .map((e) => ({ propertyId: e.propertyId, proxyId: e.proxyId! })),
    { meetingId },
  );
  if (proxyFailure)
    return new Response(proxyFailure.message, {
      status: proxyFailure.status,
    });
  const rows = parsedEntries.value.map((e) => ({
    id: crypto.randomUUID(),
    meetingId,
    propertyId: e.propertyId,
    present: e.present,
    representedByOwnerId: e.representedByOwnerId,
    proxyId: e.proxyId,
  }));
  // Full replace, atomically: a property omitted from `entries` is removed,
  // not left at its previous value. Weight is intentionally not stamped here
  // — member_attendance has no weight column, and attendance weight is
  // resolved live from properties.vote_weight at read time, because quorum
  // is a question about the roster as it stands today. db.batch() requires a
  // non-empty array, and clearing attendance entirely (rows.length === 0) is
  // legitimate, so the insert statement is only included when there is
  // something to insert.
  await db.batch([
    db
      .delete(memberAttendance)
      .where(eq(memberAttendance.meetingId, meetingId)),
    ...(rows.length > 0 ? [db.insert(memberAttendance).values(rows)] : []),
  ] as never);
  return new Response(null, { status: 204 });
}

async function approveMeeting(
  db: Db,
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
): Promise<Response> {
  const meetingId = stringField(body, 'meetingId');
  if (!meetingId) return new Response('meetingId is required', { status: 400 });
  const approvedByMotionId = stringField(body, 'approvedByMotionId') || null;
  const existing = await db
    .select({ status: meetings.status })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);
  if (existing.length === 0)
    return new Response('Meeting not found', { status: 404 });
  if (existing[0].status === 'approved')
    return new Response('Meeting is already approved', { status: 409 });
  const ctx = await resolveAuthContext(locals, request, env);
  await db
    .update(meetings)
    .set({
      status: 'approved',
      approvedAt: new Date(),
      approvedBy: ctx?.userId ?? 'unknown',
      approvedByMotionId,
      updatedAt: new Date(),
    })
    .where(eq(meetings.id, meetingId));
  return new Response(null, { status: 204 });
}

async function unapproveMeeting(db: Db, body: unknown): Promise<Response> {
  const meetingId = stringField(body, 'meetingId');
  if (!meetingId) return new Response('meetingId is required', { status: 400 });
  const existing = await db
    .select({ id: meetings.id })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);
  if (existing.length === 0)
    return new Response('Meeting not found', { status: 404 });
  // Stale approval provenance sitting on a draft would be a lie about the
  // record, so every approval column is cleared, not just `status`.
  await db
    .update(meetings)
    .set({
      status: 'draft',
      approvedAt: null,
      approvedBy: null,
      approvedByMotionId: null,
      updatedAt: new Date(),
    })
    .where(eq(meetings.id, meetingId));
  return new Response(null, { status: 204 });
}

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get('id');
  if (id) {
    const meeting = await fetchAdminMeeting(env, id);
    if (!meeting) return new Response('Meeting not found', { status: 404 });
    return Response.json(meeting);
  }
  return Response.json(await fetchAdminMeetings(env));
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const db = getDb(env);
  const action = stringField(parsed.value, 'action');

  switch (action) {
    case 'setAttendance':
      return setAttendance(db, parsed.value);
    case 'setMemberAttendance':
      return setMemberAttendance(db, parsed.value);
    case 'approve':
      return approveMeeting(db, parsed.value, locals, request);
    case 'unapprove':
      return unapproveMeeting(db, parsed.value);
    case '':
      break;
    default:
      return new Response('Unknown action', { status: 400 });
  }

  const result = normalizeMeetingInput(parsed.value, 'create');
  if (!result.ok) return new Response(result.error, { status: 400 });
  const ctx = await resolveAuthContext(locals, request, env);
  const now = new Date();
  const id = crypto.randomUUID();
  await db.insert(meetings).values({
    id,
    // create mode guarantees body, kind, date, and title are present
    body: result.value.body!,
    kind: result.value.kind!,
    date: result.value.date!,
    title: result.value.title!,
    startTime: result.value.startTime ?? null,
    location: result.value.location ?? null,
    summaryMd: result.value.summaryMd ?? null,
    documentId: result.value.documentId ?? null,
    quorumRequired: result.value.quorumRequired ?? null,
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
  // The normalizer rejects any payload carrying `status` — approval can only
  // change through the approve/unapprove actions.
  const result = normalizeMeetingInput(parsed.value, 'patch');
  if (!result.ok) return new Response(result.error, { status: 400 });
  if (Object.keys(result.value).length === 0)
    return new Response('No fields to update', { status: 400 });
  const db = getDb(env);
  const existing = await db
    .select({ id: meetings.id })
    .from(meetings)
    .where(eq(meetings.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Meeting not found', { status: 404 });
  await db
    .update(meetings)
    .set({ ...result.value, updatedAt: new Date() })
    .where(eq(meetings.id, id));
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
  const existing = await db
    .select({ status: meetings.status })
    .from(meetings)
    .where(eq(meetings.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Meeting not found', { status: 404 });
  if (existing[0].status === 'approved')
    return new Response(
      'Approved meetings cannot be deleted — unapprove first.',
      { status: 409 },
    );
  // motions.meeting_id is ON DELETE CASCADE, which routes straight around a
  // motions-only precondition: deleting this meeting deletes its motions,
  // and resolutions.adopted_by_motion_id (ON DELETE SET NULL) would then
  // silently blank any resolution's adoption provenance that cited one of
  // them. Pre-check every motion this meeting owns, not just the meeting
  // row. See ADR 0016 and the matching guard in motions.ts's DELETE.
  const meetingMotions = await db
    .select({ id: motions.id })
    .from(motions)
    .where(eq(motions.meetingId, id));
  if (meetingMotions.length > 0) {
    const cited = await db
      .select({ id: resolutions.id })
      .from(resolutions)
      .where(
        inArray(
          resolutions.adoptedByMotionId,
          meetingMotions.map((m) => m.id),
        ),
      )
      .limit(1);
    if (cited.length > 0)
      return new Response(
        "A motion in this meeting is cited as a resolution's adopting motion — it cannot be deleted while that citation stands.",
        { status: 409 },
      );
  }
  // elections.meeting_id is ON DELETE SET NULL, the identical pattern to
  // resolutions.adopted_by_motion_id above — deleting this meeting would
  // otherwise silently blank an election's record of where it was held, with
  // nothing left to recover which meeting that was.
  const linkedElections = await db
    .select({ id: elections.id })
    .from(elections)
    .where(eq(elections.meetingId, id))
    .limit(1);
  if (linkedElections.length > 0)
    return new Response(
      'An election records this meeting as where it was held — unlink it from the Elections tab first.',
      { status: 409 },
    );
  // Deleting a draft cascades its attendance, motions, and votes via FK.
  await db.delete(meetings).where(eq(meetings.id, id));
  return new Response(null, { status: 204 });
};
