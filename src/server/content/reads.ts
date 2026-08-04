import {
  inArray,
  desc,
  and,
  eq,
  ne,
  asc,
  count,
  sql,
  gte,
  notInArray,
  or,
} from 'drizzle-orm';
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
  elections,
  candidates,
  ballots,
  proxies,
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
  ElectionDetail,
  ElectionStatus,
  CandidateSummary,
  BallotRow,
  ProxyDetail,
  UpcomingOccasion,
  MemberLot,
  MemberProxyDetail,
  MemberProxyLists,
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
 *
 * `includeProxyIds` is the same admin-caller flag assembleElectionDetail
 * already takes for `ballots` (second instance of the ADR 0017 pattern,
 * recorded in ADR 0018): `viaProxy` is always derived and returned, but the
 * real `proxyId` — which would let a caller work backward to who holds a
 * given proxy — is attached only for the admin caller.
 */
async function assembleMeetingDetail(
  db: Db,
  m: typeof meetings.$inferSelect,
  includeProxyIds: boolean,
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
      proxyId: memberAttendance.proxyId,
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
            proxyId: memberVotes.proxyId,
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
      viaProxy: a.proxyId !== null,
      proxyId: includeProxyIds ? a.proxyId : null,
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
          viaProxy: v.proxyId !== null,
          proxyId: includeProxyIds ? v.proxyId : null,
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
  return assembleMeetingDetail(db, found[0], false);
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
  return assembleMeetingDetail(db, found[0], true);
}

// Every visibility tier — used by fetchAdminResolutions to share the masking
// helpers below without actually masking anything, since the admin read has
// no tier gate of its own.
const ALL_VISIBILITIES: Visibility[] = ['public', 'homeowner', 'board'];

type ResolutionRow = typeof resolutions.$inferSelect;

/**
 * The columns the chain walk and supersededByNumber actually need to resolve
 * a predecessor/successor's identity or continue the walk — never the full
 * row. Projected out as its own type (rather than reusing ResolutionRow) so
 * the public read path can select just these columns in SQL instead of
 * pulling every candidate row's full body_md into memory (see Important 3 in
 * the Task 3 review).
 */
interface ResolutionChainRow {
  id: string;
  number: string;
  title: string;
  visibility: Visibility;
  supersedesId: string | null;
}

function toChainRow(r: ResolutionRow): ResolutionChainRow {
  return {
    id: r.id,
    number: r.number,
    title: r.title,
    visibility: r.visibility,
    supersedesId: r.supersedesId,
  };
}

/** Indexes `rows` by the id of the resolution each one supersedes. */
function indexBySuccessor(
  rows: ResolutionChainRow[],
): Map<string, ResolutionChainRow> {
  const map = new Map<string, ResolutionChainRow>();
  for (const r of rows) {
    if (r.supersedesId) map.set(r.supersedesId, r);
  }
  return map;
}

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
 * Carries a visited-set, freshly created on every call and stopping on a
 * repeat: `resolutions.supersedes_id` is unique and RESTRICT-guarded, so
 * cycles cannot arise through the admin API (Task 4), but this function
 * must not trust that from the read side — bad data reachable only by
 * direct DB access must still render, not hang. This set MUST stay a local
 * declared fresh per call, never hoisted to module/function-call scope
 * shared across rows or requests: a Worker isolate can serve many requests
 * from one module instance, and multiple resolutions are walked within a
 * single fetchResolutionsFor/fetchAdminResolutions call — a shared set would
 * treat an earlier row's already-visited ids as "seen" for a later,
 * unrelated row's walk and truncate it. See "does not truncate a later
 * chain..." in resolution-reads.test.ts, which pins this down.
 */
function buildChain(
  row: { id: string; supersedesId: string | null },
  tiers: Visibility[],
  byId: Map<string, ResolutionChainRow>,
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
 * caller's tiers, a lookup of every (non-draft) resolution by id (for the
 * chain walk), and a reverse supersedesId index (for supersededByNumber).
 */
function toResolutionDetail(
  row: ResolutionRow,
  tiers: Visibility[],
  byId: Map<string, ResolutionChainRow>,
  supersededBy: Map<string, ResolutionChainRow>,
): ResolutionDetail {
  const chain = buildChain(row, tiers, byId);

  const successor = supersededBy.get(row.id);
  // Subject to the same tier filter as everything else: an out-of-tier
  // successor must not leak its number here either, or the chain-walk
  // masking above would be pointless from the other direction.
  const supersededByNumber =
    successor && tiers.includes(successor.visibility) ? successor.number : null;

  // supersedesId names the SAME record that chain[0] represents — chain[0],
  // when present, IS the immediate predecessor, computed by the same tier
  // check above. Reuse its `visible` flag rather than re-deriving it, so
  // this can never drift out of sync with the chain's own masking: leaking
  // the real id here after chain[0] already masked it would hand a visitor
  // the hidden resolution's identity from the other direction.
  const supersedesId =
    row.supersedesId !== null && chain[0]?.visible ? row.supersedesId : null;

  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status,
    visibility: row.visibility,
    effectiveDate: row.effectiveDate,
    bodyMd: row.bodyMd,
    adoptedByMotionId: row.adoptedByMotionId,
    supersedesId,
    supersededByNumber,
    chain,
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

  // A projected, non-draft lookup for the chain walk and supersededBy index.
  // Never the full row (no body_md — the walk only needs identity columns)
  // and never a draft: a draft predecessor/successor isn't producible
  // through the admin API (Task 4), so treating one as unresolvable bad
  // data and letting it hit the existing dangling-FK fallback in buildChain
  // is simpler than adding a second masking rule alongside the tier check.
  const lookupRows = await db
    .select({
      id: resolutions.id,
      number: resolutions.number,
      title: resolutions.title,
      visibility: resolutions.visibility,
      supersedesId: resolutions.supersedesId,
    })
    .from(resolutions)
    .where(ne(resolutions.status, 'draft'));
  const byId = new Map(lookupRows.map((r) => [r.id, r]));
  const supersededBy = indexBySuccessor(lookupRows);

  // The returned list's own status/tier predicates run in SQL, not a JS
  // filter over an unbounded SELECT * — this is the same shape as
  // fetchMeetingsFor's where(and(eq(status, 'approved'), inArray(...))).
  const rows = await db
    .select()
    .from(resolutions)
    .where(
      and(
        inArray(resolutions.status, statuses),
        inArray(resolutions.visibility, tiers),
      ),
    )
    .orderBy(desc(resolutions.createdAt));

  return rows.map((r) => toResolutionDetail(r, tiers, byId, supersededBy));
}

/**
 * Board-only: every resolution including drafts, with no tier filter — same
 * contract as fetchAdminMeetings — so every call site MUST be
 * requireBoard-gated. Chain links, supersedesId, and supersededByNumber are
 * never masked here since ALL_VISIBILITIES includes every tier.
 */
export async function fetchAdminResolutions(
  env: Env,
): Promise<ResolutionDetail[]> {
  const db = getDb(env);
  // Admin returns every row's full detail regardless of status or tier, so
  // there is no narrower SQL predicate to push down here — this SELECT * is
  // already exactly the rows the caller gets back, unlike the public read.
  const all = await db
    .select()
    .from(resolutions)
    .orderBy(desc(resolutions.createdAt));
  const chainRows = all.map(toChainRow);
  const byId = new Map(chainRows.map((r) => [r.id, r]));
  const supersededBy = indexBySuccessor(chainRows);

  return all.map((r) =>
    toResolutionDetail(r, ALL_VISIBILITIES, byId, supersededBy),
  );
}

type ElectionRow = typeof elections.$inferSelect;

/** The two eligible-voter denominators, shared across every election in one call. */
interface EligibleTotals {
  eligibleCount: number;
  eligibleWeight: number;
}

/**
 * COUNT(*) and SUM(vote_weight) over ACTIVE properties, from the same query —
 * the two distinct denominators ElectionTurnout needs. Reuses the aggregate
 * shape assembleMeetingDetail uses for totalActiveWeight. Computed once per
 * fetchElectionsFor/fetchAdminElections call and shared across every election
 * returned, since the active roster does not change mid-call.
 */
async function fetchEligibleTotals(db: Db): Promise<EligibleTotals> {
  const [row] = await db
    .select({
      eligibleCount: count(),
      eligibleWeight: sql<number>`coalesce(sum(${properties.voteWeight}), 0)`,
    })
    .from(properties)
    .where(eq(properties.status, 'active'));
  return row;
}

/** One election's candidates, ordered by sequence. */
async function fetchCandidatesFor(
  db: Db,
  electionId: string,
): Promise<CandidateSummary[]> {
  const rows = await db
    .select()
    .from(candidates)
    .where(eq(candidates.electionId, electionId))
    .orderBy(asc(candidates.sequence));
  return rows.map((c) => ({
    id: c.id,
    fullName: c.fullName,
    boardPersonId: c.boardPersonId,
    statementMd: c.statementMd,
    sequence: c.sequence,
    votes: c.votes,
    won: c.won,
    withdrawn: c.withdrawn,
  }));
}

/** ballotsCast and weightCast for one election, from a single aggregate query. */
async function fetchTurnoutCounts(
  db: Db,
  electionId: string,
): Promise<{ ballotsCast: number; weightCast: number }> {
  const [row] = await db
    .select({
      ballotsCast: count(),
      weightCast: sql<number>`coalesce(sum(${ballots.weight}), 0)`,
    })
    .from(ballots)
    .where(eq(ballots.electionId, electionId));
  return row;
}

/**
 * The per-lot ballot list for one election, with each property's address
 * resolved the same way board_people/property names are resolved elsewhere
 * in this file: an unscoped lookup, then a map. Board-only — never called
 * from the public read path. See fetchElectionsFor's ballots: null contract.
 */
async function fetchBallotRowsFor(
  db: Db,
  electionId: string,
): Promise<BallotRow[]> {
  const rows = await db
    .select({
      propertyId: ballots.propertyId,
      weight: ballots.weight,
      proxyId: ballots.proxyId,
      castByOwnerId: ballots.castByOwnerId,
    })
    .from(ballots)
    .where(eq(ballots.electionId, electionId))
    .orderBy(asc(ballots.propertyId));
  if (rows.length === 0) return [];
  const propertyRows = await db
    .select({ id: properties.id, address: properties.address })
    .from(properties)
    .where(
      inArray(
        properties.id,
        rows.map((r) => r.propertyId),
      ),
    );
  const addressOf = new Map(propertyRows.map((p) => [p.id, p.address]));
  return rows.map((r) => ({
    propertyId: r.propertyId,
    address: addressOf.get(r.propertyId) ?? 'Unknown',
    weight: r.weight,
    viaProxy: r.proxyId !== null,
    proxyId: r.proxyId,
    castByOwnerId: r.castByOwnerId,
  }));
}

/**
 * Assembles one ElectionDetail from an already-selected election row.
 * `includeBallots` is the ONLY thing that distinguishes the public and admin
 * assembly — turnout (a count and a sum) is always computed, but the per-lot
 * ballots list is fetched and attached only for the admin caller. This is a
 * privacy decision, not an optimization: publishing which lots returned a
 * ballot beside per-candidate tallies is exactly what lets someone deduce an
 * individual vote in a small race. Carries NO status or tier gate of its own
 * — those live in the two callers below, before this function ever runs.
 */
async function assembleElectionDetail(
  db: Db,
  row: ElectionRow,
  includeBallots: boolean,
  eligible: EligibleTotals,
): Promise<ElectionDetail> {
  const [candidateRows, turnout] = await Promise.all([
    fetchCandidatesFor(db, row.id),
    fetchTurnoutCounts(db, row.id),
  ]);
  const ballotRows = includeBallots
    ? await fetchBallotRowsFor(db, row.id)
    : null;

  return {
    id: row.id,
    meetingId: row.meetingId,
    title: row.title,
    seats: row.seats,
    electionDate: row.electionDate,
    source: row.source,
    status: row.status,
    visibility: row.visibility,
    candidates: candidateRows,
    turnout: {
      ballotsCast: turnout.ballotsCast,
      weightCast: turnout.weightCast,
      eligibleCount: eligible.eligibleCount,
      eligibleWeight: eligible.eligibleWeight,
    },
    ballots: ballotRows,
  };
}

// Elections that are a settled record, one way or another — a closed (tallied
// but not yet certified) or certified election. Never relaxed for a board
// caller: see fetchElectionsFor's own doc comment for why.
const RECORDED_ELECTION_STATUSES: ElectionStatus[] = ['closed', 'certified'];

/**
 * Closed or certified elections visible to `role`, each with full candidate
 * and turnout detail. The status filter is UNCONDITIONAL and is deliberately
 * NOT relaxed for a board caller — mirrors ADR 0014 for meetings and
 * fetchResolutionsFor's `status != 'draft'` gate: a draft election is not yet
 * a record of anything, and a void election is an abandoned one, so neither
 * belongs on a public surface regardless of who asks. Drafts and void
 * elections are reachable only through fetchAdminElections.
 *
 * `ballots` is always null here — see ElectionDetail's own doc comment and
 * assembleElectionDetail above for why the per-lot list is board-only.
 *
 * There is deliberately no single-election fetch — elections are roughly
 * annual, so a list page renders every one inline, same reasoning as
 * fetchResolutionsFor.
 */
export async function fetchElectionsFor(
  env: Env,
  role: Role,
): Promise<ElectionDetail[]> {
  const db = getDb(env);
  const rows = await db
    .select()
    .from(elections)
    .where(
      and(
        inArray(elections.status, RECORDED_ELECTION_STATUSES),
        inArray(elections.visibility, visibleTiers(role)),
      ),
    )
    .orderBy(desc(elections.electionDate));
  if (rows.length === 0) return [];
  const eligible = await fetchEligibleTotals(db);
  return Promise.all(
    rows.map((r) => assembleElectionDetail(db, r, false, eligible)),
  );
}

/**
 * Board-only: every election including drafts and void ones, newest first,
 * with the per-lot ballots list attached — same contract shape as
 * fetchAdminMeetings/fetchAdminResolutions, so every call site MUST be
 * requireBoard-gated. Carries no status or tier gate of its own.
 */
export async function fetchAdminElections(env: Env): Promise<ElectionDetail[]> {
  const db = getDb(env);
  const rows = await db
    .select()
    .from(elections)
    .orderBy(desc(elections.electionDate));
  if (rows.length === 0) return [];
  const eligible = await fetchEligibleTotals(db);
  return Promise.all(
    rows.map((r) => assembleElectionDetail(db, r, true, eligible)),
  );
}

/**
 * Board-only: every proxy, newest first, with property address and owner
 * names resolved so the panel needs no second lookup — the same
 * full-detail-on-list shape as fetchAdminElections. There is deliberately no
 * public or tier-gated sibling: who delegated to whom is more sensitive than
 * the fact of it, which the derived viaProxy already surfaces at the
 * meeting's own tier. Every call site MUST be requireBoard-gated.
 */
export async function fetchAdminProxies(env: Env): Promise<ProxyDetail[]> {
  const db = getDb(env);
  const rows = await db.select().from(proxies).orderBy(desc(proxies.createdAt));
  if (rows.length === 0) return [];
  const propertyRows = await db
    .select({ id: properties.id, address: properties.address })
    .from(properties);
  const addressOf = new Map(propertyRows.map((p) => [p.id, p.address]));
  const ownerRows = await db
    .select({ id: owners.id, fullName: owners.fullName })
    .from(owners);
  const ownerNameOf = new Map(ownerRows.map((o) => [o.id, o.fullName]));
  return rows.map((r) => ({
    id: r.id,
    propertyId: r.propertyId,
    address: addressOf.get(r.propertyId) ?? 'Unknown',
    grantorOwnerId: r.grantorOwnerId,
    grantorName: ownerNameOf.get(r.grantorOwnerId) ?? 'Unknown',
    holderName: r.holderName,
    holderOwnerId: r.holderOwnerId,
    holderOwnerName: r.holderOwnerId
      ? (ownerNameOf.get(r.holderOwnerId) ?? null)
      : null,
    meetingId: r.meetingId,
    electionId: r.electionId,
  }));
}

/**
 * Minimal metadata for occasions a homeowner can still grant a proxy for
 * (and, in PR 7c, vote at): member-body meetings and non-terminal elections
 * dated today or later, filtered by the caller's visibility tier but NOT by
 * status — a scheduled meeting whose minutes are still draft is exactly the
 * thing a proxy is granted for. This is the deliberate ADR 0019 narrowing of
 * ADR 0014: scheduled existence (title/date) at the occasion's own tier,
 * never content. `today` is an ISO date so callers and tests agree on the
 * boundary; dates are ISO strings, so lexical >= is date >=.
 */
export async function fetchUpcomingOccasionsFor(
  env: Env,
  role: Role,
  today: string,
): Promise<UpcomingOccasion[]> {
  const db = getDb(env);
  const tiers = visibleTiers(role);
  const meetingRows = await db
    .select({ id: meetings.id, title: meetings.title, date: meetings.date })
    .from(meetings)
    .where(
      and(
        eq(meetings.body, 'member'),
        gte(meetings.date, today),
        inArray(meetings.visibility, tiers),
      ),
    );
  const electionRows = await db
    .select({
      id: elections.id,
      title: elections.title,
      date: elections.electionDate,
      seats: elections.seats,
    })
    .from(elections)
    .where(
      and(
        gte(elections.electionDate, today),
        notInArray(elections.status, ['closed', 'certified', 'void']),
        inArray(elections.visibility, tiers),
      ),
    );
  const out: UpcomingOccasion[] = [
    ...meetingRows.map((m) => ({
      kind: 'meeting' as const,
      id: m.id,
      title: m.title,
      date: m.date,
      seats: null,
    })),
    ...electionRows.map((e) => ({
      kind: 'election' as const,
      id: e.id,
      title: e.title,
      date: e.date,
      seats: e.seats,
    })),
  ];
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** The caller's own active lots with their ACTIVE owners, for the grant form's pickers. */
export async function fetchMemberLots(
  env: Env,
  propertyIds: string[],
): Promise<MemberLot[]> {
  if (propertyIds.length === 0) return [];
  const db = getDb(env);
  const lots = await db
    .select({
      id: properties.id,
      address: properties.address,
      unit: properties.unit,
    })
    .from(properties)
    .where(
      and(inArray(properties.id, propertyIds), eq(properties.status, 'active')),
    );
  const ownerRows = await db
    .select({
      id: owners.id,
      propertyId: owners.propertyId,
      fullName: owners.fullName,
    })
    .from(owners)
    .where(
      and(inArray(owners.propertyId, propertyIds), eq(owners.status, 'active')),
    );
  return lots.map((l) => ({
    ...l,
    owners: ownerRows
      .filter((o) => o.propertyId === l.id)
      .map((o) => ({ id: o.id, fullName: o.fullName })),
  }));
}

/**
 * The caller's proxy lists: granted = proxies FOR the caller's lots; held =
 * proxies naming one of the caller's lots' active owners as holder. Scoped
 * reads only — this is the homeowner sibling of the board-only
 * fetchAdminProxies and must never widen to other lots' proxies. Every call
 * site is requireMemberApi-gated.
 *
 * Occasion title/date are resolved WITHOUT a visibility filter, deliberately:
 * a proxy binds the caller's own lot, so its owner may always see which
 * occasion their lot is committed to — title and date only, never the
 * occasion's content — even while the occasion itself is still
 * board-visibility. This is the own-lot exception to the occasion-tier rule,
 * recorded in ADR 0019.
 */
export async function fetchMemberProxies(
  env: Env,
  propertyIds: string[],
): Promise<MemberProxyLists> {
  if (propertyIds.length === 0) return { granted: [], held: [] };
  const db = getDb(env);
  const myOwnerRows = await db
    .select({ id: owners.id })
    .from(owners)
    .where(
      and(inArray(owners.propertyId, propertyIds), eq(owners.status, 'active')),
    );
  const myOwnerIds = myOwnerRows.map((o) => o.id);
  const rows = await db
    .select()
    .from(proxies)
    .where(
      myOwnerIds.length > 0
        ? or(
            inArray(proxies.propertyId, propertyIds),
            inArray(proxies.holderOwnerId, myOwnerIds),
          )
        : inArray(proxies.propertyId, propertyIds),
    )
    .orderBy(desc(proxies.createdAt));
  if (rows.length === 0) return { granted: [], held: [] };
  const propRows = await db
    .select({ id: properties.id, address: properties.address })
    .from(properties);
  const addressOf = new Map(propRows.map((p) => [p.id, p.address]));
  const ownerNameRows = await db
    .select({ id: owners.id, fullName: owners.fullName })
    .from(owners);
  const ownerNameOf = new Map(ownerNameRows.map((o) => [o.id, o.fullName]));
  const meetingRows = await db
    .select({ id: meetings.id, title: meetings.title, date: meetings.date })
    .from(meetings);
  const meetingOf = new Map(meetingRows.map((m) => [m.id, m]));
  const electionRows = await db
    .select({
      id: elections.id,
      title: elections.title,
      date: elections.electionDate,
    })
    .from(elections);
  const electionOf = new Map(electionRows.map((e) => [e.id, e]));
  const toDetail = (r: (typeof rows)[number]): MemberProxyDetail => {
    const occ = r.meetingId
      ? meetingOf.get(r.meetingId)
      : r.electionId
        ? electionOf.get(r.electionId)
        : undefined;
    return {
      id: r.id,
      propertyId: r.propertyId,
      address: addressOf.get(r.propertyId) ?? 'Unknown',
      grantorOwnerId: r.grantorOwnerId,
      grantorName: ownerNameOf.get(r.grantorOwnerId) ?? 'Unknown',
      holderName: r.holderName,
      holderOwnerId: r.holderOwnerId,
      holderOwnerName: r.holderOwnerId
        ? (ownerNameOf.get(r.holderOwnerId) ?? null)
        : null,
      meetingId: r.meetingId,
      electionId: r.electionId,
      occasionTitle: occ?.title ?? null,
      occasionDate: occ?.date ?? null,
    };
  };
  const myOwnerIdSet = new Set(myOwnerIds);
  const propertyIdSet = new Set(propertyIds);
  return {
    granted: rows.filter((r) => propertyIdSet.has(r.propertyId)).map(toDetail),
    held: rows
      .filter(
        (r) => r.holderOwnerId !== null && myOwnerIdSet.has(r.holderOwnerId),
      )
      .map(toDetail),
  };
}
