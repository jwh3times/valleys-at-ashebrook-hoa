import { inArray, desc, and, eq, asc } from 'drizzle-orm';
import { getDb } from '../db/client';
import {
  announcements,
  documents,
  meetings,
  boardAttendance,
  motions,
  boardVotes,
  boardPeople,
} from '../db/schema';
import { visibleTiers } from './visibility';
import type { Role } from '../authz/guards';
import { tallyVotes } from '../../lib/types';
import type { MeetingSummary, MeetingDetail } from '../../lib/types';

export async function fetchDocumentsFor(env: Env, role: Role) {
  // Project only the DocumentItem contract columns. A bare .select() would ship
  // internal storage metadata (r2Key, filename, sizeBytes, contentType) to every
  // caller; the download path re-reads the row server-side, so the public list
  // never needs them.
  return getDb(env)
    .select({
      id: documents.id,
      title: documents.title,
      category: documents.category,
      visibility: documents.visibility,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .where(inArray(documents.visibility, visibleTiers(role)));
}

export async function fetchAdminDocuments(env: Env) {
  // Board-only: includes rag_status (searchability), which the public
  // DocumentItem projection deliberately omits. All tiers, newest first.
  return getDb(env)
    .select({
      id: documents.id,
      title: documents.title,
      category: documents.category,
      visibility: documents.visibility,
      updatedAt: documents.updatedAt,
      ragStatus: documents.ragStatus,
      filename: documents.filename,
    })
    .from(documents)
    .orderBy(desc(documents.updatedAt));
}

export async function fetchAnnouncementsFor(
  env: Env,
  role: Role,
  limit?: number,
) {
  const query = getDb(env)
    .select()
    .from(announcements)
    .where(inArray(announcements.visibility, visibleTiers(role)))
    .orderBy(desc(announcements.pinned), desc(announcements.date));
  return typeof limit === 'number' ? query.limit(limit) : query;
}

/**
 * Approved meetings visible to `role`, newest first.
 *
 * The status filter is UNCONDITIONAL and is deliberately NOT relaxed for a
 * board caller: a board member browsing /meetings sees exactly what a homeowner
 * sees, and drafts are reachable only through the admin panel. This is stricter
 * than visibleTiers alone and removes a whole class of accidental-publish bug.
 */
export async function fetchMeetingsFor(
  env: Env,
  role: Role,
): Promise<MeetingSummary[]> {
  const db = getDb(env);
  const rows = await db
    .select({
      id: meetings.id,
      body: meetings.body,
      kind: meetings.kind,
      date: meetings.date,
      title: meetings.title,
      status: meetings.status,
      visibility: meetings.visibility,
    })
    .from(meetings)
    .where(
      and(
        eq(meetings.status, 'approved'),
        inArray(meetings.visibility, visibleTiers(role)),
      ),
    )
    .orderBy(desc(meetings.date), desc(meetings.createdAt));
  return withMotionCounts(env, rows);
}

/** Board-only: every meeting including drafts, newest first. */
export async function fetchAdminMeetings(env: Env): Promise<MeetingSummary[]> {
  const rows = await getDb(env)
    .select({
      id: meetings.id,
      body: meetings.body,
      kind: meetings.kind,
      date: meetings.date,
      title: meetings.title,
      status: meetings.status,
      visibility: meetings.visibility,
    })
    .from(meetings)
    .orderBy(desc(meetings.date), desc(meetings.createdAt));
  return withMotionCounts(env, rows);
}

async function withMotionCounts(
  env: Env,
  rows: Omit<MeetingSummary, 'motionCount'>[],
): Promise<MeetingSummary[]> {
  if (rows.length === 0) return [];
  // Scoped to the meetings already selected by the caller's tier/status
  // filter — an unscoped read would pull every motion in the archive,
  // including ones that belong to draft or out-of-tier meetings.
  const counts = await getDb(env)
    .select({ meetingId: motions.meetingId, id: motions.id })
    .from(motions)
    .where(
      inArray(
        motions.meetingId,
        rows.map((r) => r.id),
      ),
    );
  const byMeeting = new Map<string, number>();
  for (const m of counts)
    byMeeting.set(m.meetingId, (byMeeting.get(m.meetingId) ?? 0) + 1);
  return rows.map((r) => ({ ...r, motionCount: byMeeting.get(r.id) ?? 0 }));
}

/** One approved, in-tier meeting with attendance, motions, and roll calls. */
export async function fetchMeetingFor(
  env: Env,
  role: Role,
  id: string,
): Promise<MeetingDetail | null> {
  const db = getDb(env);
  const found = await db
    .select()
    .from(meetings)
    .where(
      and(
        eq(meetings.id, id),
        eq(meetings.status, 'approved'),
        inArray(meetings.visibility, visibleTiers(role)),
      ),
    )
    .limit(1);
  if (found.length === 0) return null;
  const m = found[0];

  const people = await db
    .select({ id: boardPeople.id, fullName: boardPeople.fullName })
    .from(boardPeople);
  const nameOf = new Map(people.map((p) => [p.id, p.fullName]));

  const attendanceRows = await db
    .select({
      personId: boardAttendance.personId,
      present: boardAttendance.present,
    })
    .from(boardAttendance)
    .where(eq(boardAttendance.meetingId, id));

  const motionRows = await db
    .select()
    .from(motions)
    .where(eq(motions.meetingId, id))
    .orderBy(asc(motions.sequence));

  // Scoped to this meeting's own motions — an unscoped read would pull every
  // roll call in the archive, including ones cast at draft or board-tier
  // meetings this caller has no access to.
  const voteRows =
    motionRows.length === 0
      ? []
      : await db
          .select({
            motionId: boardVotes.motionId,
            personId: boardVotes.personId,
            choice: boardVotes.choice,
          })
          .from(boardVotes)
          .where(
            inArray(
              boardVotes.motionId,
              motionRows.map((mo) => mo.id),
            ),
          );
  const votesByMotion = new Map<string, typeof voteRows>();
  for (const v of voteRows) {
    const list = votesByMotion.get(v.motionId) ?? [];
    list.push(v);
    votesByMotion.set(v.motionId, list);
  }

  return {
    id: m.id,
    body: m.body,
    kind: m.kind,
    date: m.date,
    title: m.title,
    status: m.status,
    visibility: m.visibility,
    startTime: m.startTime,
    location: m.location,
    summaryMd: m.summaryMd,
    documentId: m.documentId,
    quorumRequired: m.quorumRequired,
    motionCount: motionRows.length,
    attendance: attendanceRows.map((a) => ({
      personId: a.personId,
      fullName: nameOf.get(a.personId) ?? 'Unknown',
      present: a.present,
    })),
    motions: motionRows.map((mo) => {
      const votes = votesByMotion.get(mo.id) ?? [];
      return {
        id: mo.id,
        sequence: mo.sequence,
        text: mo.text,
        moverName: mo.moverPersonId
          ? (nameOf.get(mo.moverPersonId) ?? null)
          : null,
        secondName: mo.secondPersonId
          ? (nameOf.get(mo.secondPersonId) ?? null)
          : null,
        outcome: mo.outcome,
        tally: tallyVotes(votes),
        votes: votes.map((v) => ({
          personId: v.personId,
          fullName: nameOf.get(v.personId) ?? 'Unknown',
          choice: v.choice,
        })),
      };
    }),
  };
}
