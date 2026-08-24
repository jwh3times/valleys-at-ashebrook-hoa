import type { APIRoute } from 'astro';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
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
  motionEligibility,
  resolutions,
  elections,
  proxies,
  ballots,
  properties,
} from '../../../server/db/schema';
import { people, parties } from '../../../server/db/roster-schema';
import { associationDateIso, personDisplayLabel } from '../../../lib/format';
import { fetchLotAuthorityHistory } from '../../../server/roster/authority';
import { normalizeMeetingInput } from '../../../lib/types';
import {
  proxyUseError,
  parseProvenance,
  personExistenceError,
} from '../../../server/content/proxy-guards';
import { chunkedIn, D1_MAX_BOUND_PARAMS } from '../../../server/db/chunked';
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
  // person_id is a NOT NULL FK to people(party_id), so an unknown id would
  // otherwise throw a raw D1 FOREIGN KEY error out of the batch below — a 500
  // the panel cannot tell from a genuine server fault (#234). Checked for the
  // whole entry set, matching the member and ballot actions.
  const personFailure = await personExistenceError(
    db,
    parsedEntries.value.map((e) => e.personId),
    'personId',
  );
  if (personFailure)
    return new Response(personFailure.message, {
      status: personFailure.status,
    });
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
  representedByPersonId: string | null;
  proxyId: string | null;
}

/**
 * The lots in `propertyIds` that do not exist.
 *
 * `member_attendance.property_id` is a NOT NULL FK to `properties`, so an
 * unknown id reaches D1 as a raw FOREIGN KEY error rather than a 400 (#234).
 * The sibling actions get this for free — `setMemberVotes` and `setBallots`
 * each resolve a weight per lot and already fail the entry on a miss — but
 * this action stamps no weight, so nothing else asks the question.
 *
 * Chunked: this is a full replace and the Meetings panel submits EVERY lot, so
 * a large member meeting legitimately exceeds D1's bound-parameter limit. One
 * bound parameter per id and no other predicate, so the default size applies.
 */
async function unknownLots(db: Db, propertyIds: string[]): Promise<string[]> {
  const ids = [...new Set(propertyIds)];
  if (ids.length === 0) return [];
  const found = await chunkedIn(ids, (batch) =>
    db
      .select({ id: properties.id })
      .from(properties)
      .where(inArray(properties.id, batch)),
  );
  const known = new Set(found.map((r) => r.id));
  return ids.filter((id) => !known.has(id));
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
    const provenance = parseProvenance(record, 'representedByPersonId');
    if (!provenance.ok) return { ok: false, error: provenance.error };
    entries.push({
      propertyId,
      present,
      representedByPersonId: provenance.value.personId,
      proxyId: provenance.value.proxyId,
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
  const personFailure = await personExistenceError(
    db,
    parsedEntries.value.map((e) => e.representedByPersonId),
    'representedByPersonId',
  );
  if (personFailure)
    return new Response(personFailure.message, {
      status: personFailure.status,
    });

  // Before the inactive check below, which asks a narrower question: it is
  // scoped to lots marked present and reports nothing for an id that matches
  // no row at all, so an unknown lot would fall through it to the FK.
  const unknown = await unknownLots(
    db,
    parsedEntries.value.map((e) => e.propertyId),
  );
  if (unknown.length > 0)
    return new Response(`Unknown lots in entries: ${unknown.join(', ')}`, {
      status: 400,
    });

  // ADR 0015 makes `status = 'inactive'` the sanctioned way to pull a lot out
  // of member voting, and totalActiveWeight — the quorum denominator — sums
  // active lots only, so counting an inactive lot present inflates the
  // numerator against a denominator that already excludes it.
  //
  // Scoped to lots marked PRESENT, not to every entry. This is a full replace:
  // the Meetings panel renders only active lots but submits every property, so
  // a lot that has since been deactivated legitimately arrives as absent, and
  // rejecting those would make a historical roll impossible to re-save.
  const presentIds = parsedEntries.value
    .filter((e) => e.present)
    .map((e) => e.propertyId);
  if (presentIds.length > 0) {
    // Chunked: one bound parameter per present lot, and a large member
    // meeting legitimately exceeds D1's limit.
    const inactive = await chunkedIn(
      presentIds,
      (batch) =>
        db
          .select({ id: properties.id })
          .from(properties)
          .where(
            and(inArray(properties.id, batch), ne(properties.status, 'active')),
          ),
      // One less than the limit: the status predicate binds a parameter too,
      // which is the caveat chunkedIn documents.
      D1_MAX_BOUND_PARAMS - 1,
    );
    if (inactive.length > 0)
      return new Response(
        `Inactive lots cannot be recorded present: ${inactive
          .map((r) => r.id)
          .join(', ')}`,
        { status: 409 },
      );
  }
  const rows = parsedEntries.value.map((e) => ({
    id: crypto.randomUUID(),
    meetingId,
    propertyId: e.propertyId,
    present: e.present,
    representedByPersonId: e.representedByPersonId,
    proxyId: e.proxyId,
  }));
  // D1's 100-bound-parameter ceiling applies per statement. Drizzle binds all
  // six member-attendance columns for every row, so a 22-Lot roll would try to
  // use 132 parameters and fail with a raw 500. Split the insert into at most
  // 16 rows (96 binds) per statement while keeping every statement beside the
  // delete in one atomic D1 batch.
  const insertChunkSize = Math.floor(D1_MAX_BOUND_PARAMS / 6);
  const insertStatements = [];
  for (let start = 0; start < rows.length; start += insertChunkSize) {
    insertStatements.push(
      db
        .insert(memberAttendance)
        .values(rows.slice(start, start + insertChunkSize)),
    );
  }
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
    ...insertStatements,
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
  if (approvedByMotionId) {
    const approvingMotion = await db
      .select({ id: motions.id })
      .from(motions)
      .where(eq(motions.id, approvedByMotionId))
      .limit(1);
    if (approvingMotion.length === 0)
      return new Response('Motion not found', { status: 400 });
  }
  const ctx = await resolveAuthContext(locals, request, env);
  const now = Math.floor(Date.now() / 1000);
  const approved = await env.DATABASE.prepare(
    `UPDATE meetings
     SET status = 'approved', approved_at = ?, approved_by = ?,
         approved_by_motion_id = ?, updated_at = ?
     WHERE id = ?
       AND status = 'draft'
       AND NOT EXISTS (
         SELECT 1 FROM motions
         WHERE motions.meeting_id = meetings.id
           AND motions.voting_state = 'open'
       )
     RETURNING id`,
  )
    .bind(now, ctx?.userId ?? 'unknown', approvedByMotionId, now, meetingId)
    .run();
  if (approved.results.length !== 1)
    return new Response(
      'Meeting cannot be approved while a motion vote is open',
      { status: 409 },
    );
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
  const url = new URL(request.url);
  // The record-keeping pickers (attendance rolls, mover/second, roll-call, the
  // candidate link) read a flat identity list from the surface that owns the
  // record. #248 repointed it at the party roster: the meeting record now
  // names a Person, not the retired `board_people` identity, closing the
  // repointing #203 deferred and unblocking #212's drop of that table.
  //
  // A consolidated Party is a duplicate that already points at its survivor,
  // so offering it would invite recording a fact against an identity the
  // roster has superseded. Redacted names render their durable-ID fallback.
  if (url.searchParams.get('roster') === 'people') {
    const rows = await getDb(env)
      .select({ id: people.partyId, fullName: people.fullName })
      .from(people)
      .innerJoin(parties, eq(parties.id, people.partyId))
      .where(isNull(parties.consolidatedIntoPartyId));
    return Response.json(
      rows
        .map((r) => ({
          id: r.id,
          fullName: personDisplayLabel(r.fullName, r.id),
        }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName)),
    );
  }
  // The member-side record pickers (member attendance, member votes, ballots)
  // ask a narrower question than the flat list above: not "who is on the
  // roster" but "who may act for THIS lot". #248 part 2 repointed those
  // columns at `people`, so the answer is the roster's Lot Authority —
  // Ownership, or Representation of an owning Organization — rather than the
  // lot's legacy `owners` rows. Former holders are included and flagged
  // `current: false`, because a past meeting was attended by whoever held the
  // lot THEN; the same reason the legacy picker listed inactive owners.
  // Board-gated like every branch here: this is the association's whole
  // authority map.
  if (url.searchParams.get('roster') === 'lot-people') {
    const holders = await fetchLotAuthorityHistory(
      getDb(env),
      associationDateIso(),
    );
    const byLot = new Map<
      string,
      { id: string; fullName: string; current: boolean }[]
    >();
    for (const holder of holders) {
      const list = byLot.get(holder.lotId) ?? [];
      list.push({
        id: holder.personId,
        fullName: holder.fullName,
        current: holder.current,
      });
      byLot.set(holder.lotId, list);
    }
    return Response.json(
      [...byLot].map(([lotId, persons]) => ({ lotId, persons })),
    );
  }
  const id = url.searchParams.get('id');
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
    .select({ id: motions.id, votingState: motions.votingState })
    .from(motions)
    .where(eq(motions.meetingId, id));
  if (meetingMotions.length > 0) {
    if (meetingMotions.some((motion) => motion.votingState !== 'none'))
      return new Response(
        'A motion in this meeting has live-voting history — the meeting cannot be deleted.',
        { status: 409 },
      );
    const frozen = await db
      .select({ motionId: motionEligibility.motionId })
      .from(motionEligibility)
      .where(
        inArray(
          motionEligibility.motionId,
          meetingMotions.map((motion) => motion.id),
        ),
      )
      .limit(1);
    if (frozen.length > 0)
      return new Response(
        'A motion in this meeting has live-voting history — the meeting cannot be deleted.',
        { status: 409 },
      );
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
  // proxies.meeting_id is ON DELETE CASCADE — deleting this meeting deletes
  // its proxies. A ballot can cite one of those proxies even after its
  // election's meetingId has been detached from this meeting (the
  // linkedElections check above only catches an election that STILL points
  // here), because "an election held at this meeting" is a one-time lookup
  // rule at write time, not a standing link. ballots.proxy_id carries no ON
  // DELETE action (deliberate, see schema.ts), so without this pre-check the
  // cascade would leave a dangling reference and D1 would throw a raw FK
  // constraint error instead of a readable 409.
  const meetingProxies = await db
    .select({ id: proxies.id })
    .from(proxies)
    .where(eq(proxies.meetingId, id));
  if (meetingProxies.length > 0) {
    const citingBallots = await db
      .select({ id: ballots.id })
      .from(ballots)
      .where(
        inArray(
          ballots.proxyId,
          meetingProxies.map((p) => p.id),
        ),
      )
      .limit(1);
    if (citingBallots.length > 0)
      return new Response(
        'An election ballot cites a proxy for this meeting — remove those ballots first',
        { status: 409 },
      );
  }
  // Repeat the live-history predicate in the final mutation so a child
  // motion's first open cannot commit between the pre-checks and this cascade.
  const deleted = await env.DATABASE.prepare(
    `DELETE FROM meetings
     WHERE id = ?
       AND NOT EXISTS (
         SELECT 1 FROM motions
         WHERE motions.meeting_id = meetings.id
           AND (
             motions.voting_state <> 'none'
             OR EXISTS (
               SELECT 1 FROM motion_eligibility
               WHERE motion_eligibility.motion_id = motions.id
             )
           )
       )
     RETURNING id`,
  )
    .bind(id)
    .run();
  // `meta.changes` can include cascaded attendance/motions/votes; RETURNING
  // identifies the one parent meeting this guarded statement deleted.
  if (deleted.results.length !== 1)
    return new Response(
      'A motion in this meeting has live-voting history — the meeting cannot be deleted.',
      { status: 409 },
    );
  return new Response(null, { status: 204 });
};
