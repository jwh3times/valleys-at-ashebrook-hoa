import { inArray, desc, and, eq, asc, count, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import type { Db } from '../db/client';
import {
  announcements,
  documents,
  meetings,
  boardAttendance,
  motions,
  boardVotes,
  boardPeople,
  properties,
  owners,
  memberAttendance,
  memberVotes,
  resolutions,
} from '../db/schema';
import { visibleTiers } from './visibility';
import type { Role } from '../authz/guards';
import { tallyVotes } from '../../lib/types';
import type {
  MeetingSummary,
  MeetingDetail,
  ResolutionDetail,
  ResolutionChainLink,
  ResolutionStatus,
  Visibility,
} from '../../lib/types';

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
  // including ones that belong to draft or out-of-tier meetings. Counted in
  // SQL with GROUP BY rather than selecting every motion row and tallying in
  // JS, so a meeting with many motions doesn't ship one row per motion over
  // the wire just to be counted client-side. Also the shape PR 3 needs when
  // this COUNT(*) becomes a SUM(weight) over property-weighted member votes.
  const counts = await getDb(env)
    .select({ meetingId: motions.meetingId, motionCount: count() })
    .from(motions)
    .where(
      inArray(
        motions.meetingId,
        rows.map((r) => r.id),
      ),
    )
    .groupBy(motions.meetingId);
  const byMeeting = new Map(counts.map((c) => [c.meetingId, c.motionCount]));
  return rows.map((r) => ({ ...r, motionCount: byMeeting.get(r.id) ?? 0 }));
}

/**
 * Assembles the MeetingDetail body (attendance, motions, roll calls, derived
 * tallies) for one already-selected meeting row. Shared by fetchMeetingFor
 * (public, status/tier-gated) and fetchAdminMeeting (board-only, no gate) so
 * the two cannot drift apart. Deliberately carries NO access control of its
 * own — the status filter and visibleTiers(role) check happen in the two
 * callers, before this function ever runs, and must stay there.
 */
async function assembleMeetingDetail(
  db: Db,
  m: typeof meetings.$inferSelect,
): Promise<MeetingDetail> {
  const id = m.id;

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

  // Property addresses and owner names, resolved the same way board_people
  // names are resolved above: one unscoped lookup, then a map. Both member
  // attendance and every motion's member votes need both maps, so they are
  // built once and shared.
  const propertyRows = await db
    .select({
      id: properties.id,
      address: properties.address,
      voteWeight: properties.voteWeight,
    })
    .from(properties);
  const addressOf = new Map(propertyRows.map((p) => [p.id, p.address]));
  const weightOf = new Map(propertyRows.map((p) => [p.id, p.voteWeight]));

  const ownerRows = await db
    .select({ id: owners.id, fullName: owners.fullName })
    .from(owners);
  const ownerNameOf = new Map(ownerRows.map((o) => [o.id, o.fullName]));

  const memberAttendanceRows = await db
    .select({
      propertyId: memberAttendance.propertyId,
      present: memberAttendance.present,
      representedByOwnerId: memberAttendance.representedByOwnerId,
      viaProxy: memberAttendance.viaProxy,
    })
    .from(memberAttendance)
    .where(eq(memberAttendance.meetingId, id));

  // Scoped to this meeting's own motions, same reasoning and the same
  // empty-list guard as the board votes query above — inArray(col, []) is a
  // runtime error in Drizzle, and a meeting with no motions is ordinary.
  const memberVoteRows =
    motionRows.length === 0
      ? []
      : await db
          .select({
            motionId: memberVotes.motionId,
            propertyId: memberVotes.propertyId,
            castByOwnerId: memberVotes.castByOwnerId,
            viaProxy: memberVotes.viaProxy,
            weight: memberVotes.weight,
            choice: memberVotes.choice,
          })
          .from(memberVotes)
          .where(
            inArray(
              memberVotes.motionId,
              motionRows.map((mo) => mo.id),
            ),
          );
  // This grouping, not the `where` above, is what actually prevents another
  // meeting's votes from leaking into this meeting's motions: motion ids are
  // unique across the whole table, so grouping by motionId and then reading
  // only `motionRows`' own ids back out of the map is isolation on its own.
  // The `where inArray(...)` is an overfetch guard (skip the round trip when
  // there are no motions to match) layered on top of that, not the thing
  // doing the scoping — do not remove this grouping believing the `where`
  // alone covers it.
  const memberVotesByMotion = new Map<string, typeof memberVoteRows>();
  for (const v of memberVoteRows) {
    const list = memberVotesByMotion.get(v.motionId) ?? [];
    list.push(v);
    memberVotesByMotion.set(v.motionId, list);
  }

  // SUM(vote_weight) over ACTIVE properties only — the member quorum
  // denominator. A single SQL aggregate, not a row scan totalled in JS.
  // SQLite's SUM returns NULL over zero rows, hence the coalesce.
  const [{ totalActiveWeight }] = await db
    .select({
      totalActiveWeight: sql<number>`coalesce(sum(${properties.voteWeight}), 0)`,
    })
    .from(properties)
    .where(eq(properties.status, 'active'));

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
    memberAttendance: memberAttendanceRows.map((a) => ({
      propertyId: a.propertyId,
      address: addressOf.get(a.propertyId) ?? 'Unknown',
      present: a.present,
      weight: weightOf.get(a.propertyId) ?? 0,
      representedByName: a.representedByOwnerId
        ? (ownerNameOf.get(a.representedByOwnerId) ?? null)
        : null,
      viaProxy: a.viaProxy,
    })),
    totalActiveWeight,
    motions: motionRows.map((mo) => {
      const votes = votesByMotion.get(mo.id) ?? [];
      const mVotes = memberVotesByMotion.get(mo.id) ?? [];
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
        memberVotes: mVotes.map((v) => ({
          propertyId: v.propertyId,
          address: addressOf.get(v.propertyId) ?? 'Unknown',
          choice: v.choice,
          weight: v.weight,
          castByName: v.castByOwnerId
            ? (ownerNameOf.get(v.castByOwnerId) ?? null)
            : null,
          viaProxy: v.viaProxy,
        })),
        // Weight comes from each vote's own stored `weight` snapshot, never
        // recomputed from the property's current voteWeight — that would
        // defeat the snapshot when a weight is corrected after the fact.
        memberTally: tallyVotes(mVotes),
      };
    }),
  };
}

/**
 * One approved, in-tier meeting with attendance, motions, and roll calls.
 * The status AND tier gate here is the public read path's whole invariant —
 * it stays in this function, not in the shared assembler, and is NOT relaxed
 * for a board caller: a board member browsing /meetings sees exactly what a
 * homeowner sees. Drafts are reachable only through fetchAdminMeeting.
 */
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
  return assembleMeetingDetail(db, found[0]);
}

/**
 * Board-only: one meeting including drafts, with attendance, motions, and
 * roll calls. Carries NO status or tier gate of its own — same contract as
 * fetchAdminMeetings — so every call site MUST be requireBoard-gated.
 */
export async function fetchAdminMeeting(
  env: Env,
  id: string,
): Promise<MeetingDetail | null> {
  const db = getDb(env);
  const found = await db
    .select()
    .from(meetings)
    .where(eq(meetings.id, id))
    .limit(1);
  if (found.length === 0) return null;
  return assembleMeetingDetail(db, found[0]);
}

// Every visibility tier — used by fetchAdminResolutions to share the masking
// helpers below without actually masking anything, since the admin read has
// no tier gate of its own.
const ALL_VISIBILITIES: Visibility[] = ['public', 'homeowner', 'board'];

type ResolutionRow = typeof resolutions.$inferSelect;

/**
 * Walks `row`'s supersession chain backwards through `supersedesId`,
 * newest-predecessor-first / oldest-last, re-applying the tier filter at
 * every step: a predecessor outside `tiers` is emitted as
 * `{ id: null, number: null, title: null, visible: false }` so the chain's
 * true length is still visible without leaking the hidden record's identity.
 * The walk still follows a masked link's OWN supersedesId — the point of the
 * masked entry is that the chain doesn't read as shorter than it actually
 * is, not that it gets truncated at the first hidden link.
 *
 * Carries a visited-set and stops on a repeat: `resolutions.supersedes_id`
 * is unique and RESTRICT-guarded, so cycles cannot arise through the admin
 * API (Task 4), but this function must not trust that from the read side —
 * bad data reachable only by direct DB access must still render, not hang.
 */
function buildChain(
  row: ResolutionRow,
  tiers: Visibility[],
  byId: Map<string, ResolutionRow>,
): ResolutionChainLink[] {
  const chain: ResolutionChainLink[] = [];
  const visited = new Set<string>([row.id]);
  let nextId = row.supersedesId;
  while (nextId) {
    if (visited.has(nextId)) break;
    visited.add(nextId);
    const pred = byId.get(nextId);
    if (!pred) break;
    chain.push(
      tiers.includes(pred.visibility)
        ? {
            id: pred.id,
            number: pred.number,
            title: pred.title,
            visible: true,
          }
        : { id: null, number: null, title: null, visible: false },
    );
    nextId = pred.supersedesId;
  }
  return chain;
}

/**
 * Assembles one ResolutionDetail from an already-selected row, given the
 * caller's tiers, a lookup of every resolution by id (for the chain walk),
 * and a reverse supersedesId index (for supersededByNumber). `byId` and
 * `supersededBy` are built once per call site over the full table — cheap
 * at this table's dozens-of-rows volume — rather than re-queried per row.
 */
function toResolutionDetail(
  row: ResolutionRow,
  tiers: Visibility[],
  byId: Map<string, ResolutionRow>,
  supersededBy: Map<string, ResolutionRow>,
): ResolutionDetail {
  const successor = supersededBy.get(row.id);
  // Subject to the same tier filter as everything else: an out-of-tier
  // successor must not leak its number here either, or the chain-walk
  // masking above would be pointless from the other direction.
  const supersededByNumber =
    successor && tiers.includes(successor.visibility) ? successor.number : null;
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status,
    visibility: row.visibility,
    effectiveDate: row.effectiveDate,
    bodyMd: row.bodyMd,
    adoptedByMotionId: row.adoptedByMotionId,
    supersedesId: row.supersedesId,
    supersededByNumber,
    chain: buildChain(row, tiers, byId),
  };
}

/**
 * Non-draft resolutions visible to `role`, each with its full body and
 * supersession chain. `status != 'draft'` is UNCONDITIONAL and is
 * deliberately NOT relaxed for a board caller — mirrors ADR 0014 for
 * meetings: a draft resolution is not a record of anything adopted yet, so
 * the public read path must never surface one regardless of who asks.
 * Drafts are reachable only through fetchAdminResolutions. By default only
 * `in_force` resolutions are returned; `includeHistoric: true` adds
 * `superseded` and `repealed` for the "?status=all" view — `draft` is never
 * included by either mode.
 *
 * Returns full ResolutionDetail rather than a summary: the resolutions book
 * renders each entry's body and chain inline on one page, and resolutions
 * are few enough in number and short enough in body that this costs
 * nothing. There is deliberately no single-resolution fetch — see the
 * task brief for why a fetchResolutionFor would have no consumer.
 */
export async function fetchResolutionsFor(
  env: Env,
  role: Role,
  opts?: { includeHistoric?: boolean },
): Promise<ResolutionDetail[]> {
  const db = getDb(env);
  const tiers = visibleTiers(role);
  const statuses: ResolutionStatus[] = opts?.includeHistoric
    ? ['in_force', 'superseded', 'repealed']
    : ['in_force'];

  // The full table is read once so the chain walk and supersededByNumber can
  // resolve any predecessor/successor by id, even one excluded from this
  // call's own status/tier filter (e.g. a superseded predecessor of an
  // in_force resolution, when includeHistoric is false).
  const all = await db.select().from(resolutions);
  const byId = new Map(all.map((r) => [r.id, r]));
  const supersededBy = new Map<string, ResolutionRow>();
  for (const r of all) {
    if (r.supersedesId) supersededBy.set(r.supersedesId, r);
  }

  return all
    .filter((r) => statuses.includes(r.status) && tiers.includes(r.visibility))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((r) => toResolutionDetail(r, tiers, byId, supersededBy));
}

/**
 * Board-only: every resolution including drafts, with no tier filter — same
 * contract as fetchAdminMeetings — so every call site MUST be
 * requireBoard-gated. Chain links and supersededByNumber are never masked
 * here since ALL_VISIBILITIES includes every tier.
 */
export async function fetchAdminResolutions(
  env: Env,
): Promise<ResolutionDetail[]> {
  const db = getDb(env);
  const all = await db.select().from(resolutions);
  const byId = new Map(all.map((r) => [r.id, r]));
  const supersededBy = new Map<string, ResolutionRow>();
  for (const r of all) {
    if (r.supersedesId) supersededBy.set(r.supersedesId, r);
  }

  return all
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((r) => toResolutionDetail(r, ALL_VISIBILITIES, byId, supersededBy));
}
