import type { APIRoute } from 'astro';
import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import type { Db } from '../../../server/db/client';
import {
  elections,
  candidates,
  properties,
  owners,
  meetings,
  boardTerms,
} from '../../../server/db/schema';
import {
  normalizeElectionInput,
  isoDateOrError,
  termRangeError,
  INPUT_LIMITS,
} from '../../../lib/types';
import { fetchAdminElections } from '../../../server/content/reads';
import { proxyUseError } from '../../../server/content/proxy-guards';
import { LIVE_VOTING_ENABLED_SQL } from '../../../server/content/voting-state';

export const prerender = false;

const CERTIFIED_OR_VOID = (thing: string): string =>
  `Election is certified or void — ${thing} cannot be changed`;
// Once a conducted election exists, the board must never type its tallies or
// ballot register through the recorded-election paths: doing so would replace
// real live-voting data with board-supplied values.
const NOT_RECORDED = (thing: string): string =>
  `${thing} can only be typed for a recorded election`;

/** 404 Response if `meetingId` is non-null and does not exist, else null. */
async function checkMeetingExists(
  db: Db,
  meetingId: string | null | undefined,
): Promise<Response | null> {
  if (!meetingId) return null;
  const rows = await db
    .select({ id: meetings.id })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);
  if (rows.length === 0)
    return new Response('Meeting not found', { status: 404 });
  return null;
}

interface TallyEntry {
  candidateId: string;
  votes: number;
}

/** Validate the raw `entries` payload for `setTallies`. */
function parseTallyEntries(
  body: unknown,
): { ok: true; value: TallyEntry[] } | { ok: false; error: string } {
  const raw = (body as Record<string, unknown> | null | undefined)?.entries;
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'entries must be an array' };
  }
  const entries: TallyEntry[] = [];
  for (const item of raw) {
    const record = item as Record<string, unknown> | null;
    const candidateId = record?.candidateId;
    const votes = record?.votes;
    if (typeof candidateId !== 'string' || candidateId.trim() === '') {
      return { ok: false, error: 'Each tally entry needs a candidateId' };
    }
    if (typeof votes !== 'number' || !Number.isInteger(votes) || votes < 0) {
      return { ok: false, error: 'votes must be a non-negative integer' };
    }
    entries.push({ candidateId, votes });
  }
  return { ok: true, value: entries };
}

async function setTallies(db: Db, body: unknown): Promise<Response> {
  const electionId = stringField(body, 'electionId');
  if (!electionId)
    return new Response('electionId is required', { status: 400 });
  const parsedEntries = parseTallyEntries(body);
  if (!parsedEntries.ok)
    return new Response(parsedEntries.error, { status: 400 });

  const existing = await db
    .select({ status: elections.status, source: elections.source })
    .from(elections)
    .where(eq(elections.id, electionId))
    .limit(1);
  if (existing.length === 0)
    return new Response('Election not found', { status: 404 });
  const election = existing[0];
  if (election.status === 'certified' || election.status === 'void')
    return new Response(CERTIFIED_OR_VOID('tallies'), { status: 409 });
  if (election.source !== 'recorded')
    return new Response(NOT_RECORDED('Tallies'), { status: 409 });

  // Pre-checked so a repeated candidateId is a readable 409 instead of a
  // silent last-write-wins (there is no unique index on candidateId alone to
  // catch this for us).
  const candidateIds = parsedEntries.value.map((e) => e.candidateId);
  if (new Set(candidateIds).size !== candidateIds.length)
    return new Response('Each candidate may record only one tally', {
      status: 409,
    });

  const candidateRows = await db
    .select({ id: candidates.id })
    .from(candidates)
    .where(eq(candidates.electionId, electionId));
  const validIds = new Set(candidateRows.map((c) => c.id));
  for (const id of candidateIds) {
    if (!validIds.has(id))
      return new Response('Unknown candidate in entries', { status: 400 });
  }

  // A candidate omitted from `entries` has its votes set back to NULL — that
  // is how "not recorded" is restored, and it is why the column is nullable
  // (NULL = not recorded, 0 = recorded as zero). This is a full replace of
  // the election's tally set, expressed as one UPDATE per candidate rather
  // than a delete+insert, since `votes` is a column on `candidates` itself
  // rather than a separate child table.
  const votesByCandidate = new Map(
    parsedEntries.value.map((e) => [e.candidateId, e.votes]),
  );
  // Reserve the parent inside the same D1 transaction as the replacement.
  // The temporary status is never externally visible or committed: every
  // child update requires it, and the last statement restores the original
  // lifecycle state. A terminal transition that wins before this batch makes
  // the reservation a no-op, so every child is also a no-op.
  const reservationStatus = '__replacing_tallies__';
  const updatedAt = Math.floor(Date.now() / 1000);
  const statements: D1PreparedStatement[] = [
    env.DATABASE.prepare(
      `UPDATE elections
       SET status = ?
       WHERE id = ? AND source = 'recorded' AND status = ?
         AND (SELECT COUNT(*) FROM candidates WHERE election_id = ?) = ?
       RETURNING id`,
    ).bind(
      reservationStatus,
      electionId,
      election.status,
      electionId,
      candidateRows.length,
    ),
  ];
  for (const candidate of candidateRows) {
    statements.push(
      env.DATABASE.prepare(
        `UPDATE candidates
         SET votes = ?
         WHERE id = ? AND election_id = ?
           AND EXISTS (
             SELECT 1 FROM elections
             WHERE id = ? AND source = 'recorded' AND status = ?
           )`,
      ).bind(
        votesByCandidate.get(candidate.id) ?? null,
        candidate.id,
        electionId,
        electionId,
        reservationStatus,
      ),
    );
  }
  statements.push(
    env.DATABASE.prepare(
      `UPDATE elections
       SET status = ?, updated_at = ?
       WHERE id = ? AND source = 'recorded' AND status = ?
       RETURNING id`,
    ).bind(election.status, updatedAt, electionId, reservationStatus),
  );
  const results = await env.DATABASE.batch(statements);
  const reservation = results[0];
  const release = results[results.length - 1];
  if (reservation.meta.changes !== 1 || release.meta.changes !== 1)
    return new Response(CERTIFIED_OR_VOID('tallies'), { status: 409 });
  return new Response(null, { status: 204 });
}

interface BallotEntry {
  propertyId: string;
  weight?: number;
  proxyId: string | null;
  castByOwnerId: string | null;
}

/** Validate the raw `entries` payload for `setBallots`. */
function parseBallotEntries(
  body: unknown,
): { ok: true; value: BallotEntry[] } | { ok: false; error: string } {
  const raw = (body as Record<string, unknown> | null | undefined)?.entries;
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'entries must be an array' };
  }
  const entries: BallotEntry[] = [];
  for (const item of raw) {
    const record = item as Record<string, unknown> | null;
    const propertyId = record?.propertyId;
    const weight = record?.weight;
    const castByOwnerId = record?.castByOwnerId;
    if (typeof propertyId !== 'string' || propertyId.trim() === '') {
      return { ok: false, error: 'Each ballot entry needs a propertyId' };
    }
    let parsedWeight: number | undefined;
    if (weight !== undefined) {
      if (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 1)
        return { ok: false, error: 'weight must be a positive integer' };
      parsedWeight = weight;
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
      weight: parsedWeight,
      proxyId: parsedProxyId,
      castByOwnerId: typeof castByOwnerId === 'string' ? castByOwnerId : null,
    });
  }
  return { ok: true, value: entries };
}

async function setBallots(db: Db, body: unknown): Promise<Response> {
  const electionId = stringField(body, 'electionId');
  if (!electionId)
    return new Response('electionId is required', { status: 400 });
  const parsedEntries = parseBallotEntries(body);
  if (!parsedEntries.ok)
    return new Response(parsedEntries.error, { status: 400 });

  const existing = await db
    .select({
      status: elections.status,
      source: elections.source,
      meetingId: elections.meetingId,
    })
    .from(elections)
    .where(eq(elections.id, electionId))
    .limit(1);
  if (existing.length === 0)
    return new Response('Election not found', { status: 404 });
  const election = existing[0];
  if (election.status === 'certified' || election.status === 'void')
    return new Response(CERTIFIED_OR_VOID('ballots'), { status: 409 });
  if (election.source !== 'recorded')
    return new Response(NOT_RECORDED('Ballots'), { status: 409 });

  const proxyFailure = await proxyUseError(
    db,
    parsedEntries.value
      .filter((e) => e.proxyId !== null)
      .map((e) => ({ propertyId: e.propertyId, proxyId: e.proxyId! })),
    { electionId, meetingId: election.meetingId },
  );
  if (proxyFailure)
    return new Response(proxyFailure.message, {
      status: proxyFailure.status,
    });

  // Pre-checked so a repeated propertyId is a readable 409 instead of hitting
  // ballots_election_property_unq mid-batch as a raw D1 error.
  const propertyIds = parsedEntries.value.map((e) => e.propertyId);
  if (new Set(propertyIds).size !== propertyIds.length)
    return new Response('Each lot may return only one ballot', {
      status: 409,
    });

  const propertyRows =
    propertyIds.length > 0
      ? await db
          .select({ id: properties.id, voteWeight: properties.voteWeight })
          .from(properties)
          .where(inArray(properties.id, propertyIds))
      : [];
  const weightById = new Map(propertyRows.map((p) => [p.id, p.voteWeight]));

  // Pre-checked the same way propertyId is: castByOwnerId is a nullable FK
  // to owners (ON DELETE SET NULL), so an unknown id would otherwise throw a
  // raw D1 FOREIGN KEY constraint error out of the insert below.
  const ownerIds = [
    ...new Set(
      parsedEntries.value
        .map((e) => e.castByOwnerId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const ownerRows =
    ownerIds.length > 0
      ? await db
          .select({ id: owners.id })
          .from(owners)
          .where(inArray(owners.id, ownerIds))
      : [];
  const validOwnerIds = new Set(ownerRows.map((o) => o.id));

  const rows: {
    id: string;
    propertyId: string;
    weight: number;
    proxyId: string | null;
    castByOwnerId: string | null;
  }[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const e of parsedEntries.value) {
    const dbWeight = weightById.get(e.propertyId);
    if (dbWeight === undefined)
      return new Response('Unknown property in entries', { status: 400 });
    if (e.castByOwnerId !== null && !validOwnerIds.has(e.castByOwnerId))
      return new Response('Unknown castByOwnerId in entries', {
        status: 400,
      });
    // setMemberVotes stamps weight from the database and never trusts the
    // client, because it builds a COMPUTED tally — a client-supplied weight
    // there would let a caller silently rewrite the electorate. This action
    // is different: in `recorded` mode (guaranteed above — the source guard
    // already rejected anything else) the board types the vote counts
    // themselves, so a board-supplied weight is exactly as trusted as the
    // tallies beside it. It is also the only way to record a lot's weight as
    // it actually was years ago, since no historical weight is stored
    // anywhere else.
    const weight = e.weight ?? dbWeight;
    rows.push({
      id: crypto.randomUUID(),
      propertyId: e.propertyId,
      weight,
      proxyId: e.proxyId,
      castByOwnerId: e.castByOwnerId,
    });
  }

  // Full replace, atomically: a lot omitted from `entries` returned no
  // ballot this time and is removed, not left at its previous value. As with
  // tally replacement, the uncommitted temporary status is the reservation
  // every child statement must observe. If certify/void wins first, the
  // reservation, delete, inserts, and release all change zero rows.
  const reservationStatus = '__replacing_ballots__';
  const statements: D1PreparedStatement[] = [
    env.DATABASE.prepare(
      `UPDATE elections
       SET status = ?
       WHERE id = ? AND source = 'recorded' AND status = ?
       RETURNING id`,
    ).bind(reservationStatus, electionId, election.status),
    env.DATABASE.prepare(
      `DELETE FROM ballots
       WHERE election_id = ?
         AND EXISTS (
           SELECT 1 FROM elections
           WHERE id = ? AND source = 'recorded' AND status = ?
         )`,
    ).bind(electionId, electionId, reservationStatus),
  ];
  for (const row of rows) {
    statements.push(
      env.DATABASE.prepare(
        `INSERT INTO ballots (
           id, election_id, property_id, cast_by_owner_id, proxy_id,
           weight, recorded_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM elections
           WHERE id = ? AND source = 'recorded' AND status = ?
         )`,
      ).bind(
        row.id,
        electionId,
        row.propertyId,
        row.castByOwnerId,
        row.proxyId,
        row.weight,
        now,
        electionId,
        reservationStatus,
      ),
    );
  }
  statements.push(
    env.DATABASE.prepare(
      `UPDATE elections
       SET status = ?, updated_at = ?
       WHERE id = ? AND source = 'recorded' AND status = ?
       RETURNING id`,
    ).bind(election.status, now, electionId, reservationStatus),
  );
  const results = await env.DATABASE.batch(statements);
  const reservation = results[0];
  const release = results[results.length - 1];
  if (reservation.meta.changes !== 1 || release.meta.changes !== 1)
    return new Response(CERTIFIED_OR_VOID('ballots'), { status: 409 });
  return new Response(null, { status: 204 });
}

async function openElection(
  database: D1Database,
  body: unknown,
): Promise<Response> {
  const id = stringField(body, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  const updatedAt = Math.floor(Date.now() / 1000);
  const [transition] = await database.batch([
    database
      .prepare(
        `UPDATE elections
         SET status = 'open', updated_at = ?
         WHERE id = ?
           AND source = 'conducted'
           AND status = 'draft'
           AND visibility <> 'board'
           AND EXISTS (
             SELECT 1 FROM candidates
             WHERE candidates.election_id = elections.id
               AND candidates.withdrawn = 0
           )
           AND EXISTS (
             SELECT 1 FROM properties WHERE properties.status = 'active'
           )
           AND ${LIVE_VOTING_ENABLED_SQL}
         RETURNING id`,
      )
      .bind(updatedAt, id),
    database
      .prepare(
        `INSERT INTO election_eligibility (election_id, property_id, weight)
         SELECT ?, properties.id, properties.vote_weight
         FROM properties
         WHERE properties.status = 'active'
           AND changes() = 1`,
      )
      .bind(id),
  ]);
  if (transition.meta.changes !== 1)
    return new Response('Election cannot be opened', { status: 409 });
  return new Response(null, { status: 204 });
}

async function closeElection(
  db: Db,
  database: D1Database,
  body: unknown,
): Promise<Response> {
  const id = stringField(body, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  const existing = await db
    .select({ source: elections.source })
    .from(elections)
    .where(eq(elections.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Election not found', { status: 404 });
  const updatedAt = Math.floor(Date.now() / 1000);
  if (existing[0].source === 'recorded') {
    const transition = await database
      .prepare(
        `UPDATE elections
         SET status = 'closed', updated_at = ?
         WHERE id = ? AND source = 'recorded' AND status = 'draft'
         RETURNING id`,
      )
      .bind(updatedAt, id)
      .run();
    if (transition.meta.changes !== 1)
      return new Response('Election is not a draft', { status: 409 });
    return new Response(null, { status: 204 });
  }

  const [transition] = await database.batch([
    database
      .prepare(
        `UPDATE elections
         SET status = 'closed', updated_at = ?
         WHERE id = ? AND source = 'conducted' AND status = 'open'
         RETURNING id`,
      )
      .bind(updatedAt, id),
    database
      .prepare(
        `UPDATE candidates
         SET votes = COALESCE(
           (SELECT SUM(ballot_choices.weight)
            FROM ballot_choices
            WHERE ballot_choices.candidate_id = candidates.id),
           0
         )
         WHERE election_id = ?
           AND changes() = 1
           AND EXISTS (
             SELECT 1 FROM elections
             WHERE elections.id = candidates.election_id
               AND elections.status = 'closed'
           )`,
      )
      .bind(id),
  ]);
  if (transition.meta.changes !== 1)
    return new Response('Conducted election is not open', { status: 409 });
  return new Response(null, { status: 204 });
}

async function voidElection(db: Db, body: unknown): Promise<Response> {
  const id = stringField(body, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  const existing = await db
    .select({ status: elections.status })
    .from(elections)
    .where(eq(elections.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Election not found', { status: 404 });
  // Voiding a certified election directly would strand the board_terms rows
  // certification created — uncertify first (Task 5), which cleans those up,
  // then void.
  if (existing[0].status === 'certified')
    return new Response('Uncertify before voiding this election', {
      status: 409,
    });
  if (existing[0].status === 'void')
    return new Response('Election is already void', { status: 409 });
  const transition = await env.DATABASE.prepare(
    `UPDATE elections
     SET status = 'void', updated_at = ?
     WHERE id = ? AND status IN ('draft', 'open', 'closed')
     RETURNING id`,
  )
    .bind(Math.floor(Date.now() / 1000), id)
    .run();
  if (transition.meta.changes !== 1)
    return new Response('Election is no longer voidable', { status: 409 });
  return new Response(null, { status: 204 });
}

interface WinnerCandidate {
  id: string;
  electionId: string;
  withdrawn: boolean;
  boardPersonId: string | null;
  fullName: string;
}

interface Winner {
  candidateId: string;
  termStart: string;
  termEnd: string | null;
  title: string | null;
  boardPersonId: string | null;
  fullName: string;
}

async function certifyElection(
  db: Db,
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
): Promise<Response> {
  const id = stringField(body, 'id');
  if (!id) return new Response('id is required', { status: 400 });

  // 1. 404
  const existing = await db
    .select({ status: elections.status, seats: elections.seats })
    .from(elections)
    .where(eq(elections.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Election not found', { status: 404 });
  const election = existing[0];

  // 2. 409 unless closed — covers both a draft (never closed) and an
  // already-certified election with the same message, since both simply
  // are not in the one state certify may act on. A void election gets its
  // own message: "close it first" is actionable advice for draft/certified,
  // but a void election cannot be reopened at all.
  if (election.status === 'void')
    return new Response('Cannot certify a void election', { status: 409 });
  if (election.status !== 'closed')
    return new Response('Close the election before certifying it', {
      status: 409,
    });

  // 3. winners must be a non-empty array
  const rawWinners = (body as Record<string, unknown> | null | undefined)
    ?.winners;
  if (!Array.isArray(rawWinners) || rawWinners.length === 0)
    return new Response('winners must be a non-empty array', { status: 400 });

  // 4. more winners than seats — fewer is legal, a seat may go unfilled
  if (rawWinners.length > election.seats)
    return new Response('More winners than seats', { status: 400 });

  // Structural extraction: every entry needs at least a candidateId to look
  // anything up. Date/title validation (precondition 6) happens in a later
  // pass so a candidateId problem (precondition 5) is always reported first.
  interface RawWinner {
    candidateId: string;
    termStart: unknown;
    termEnd: unknown;
    title: unknown;
  }
  const rawEntries: RawWinner[] = [];
  for (const item of rawWinners) {
    const record = item as Record<string, unknown> | null;
    const candidateId = record?.candidateId;
    if (typeof candidateId !== 'string' || candidateId.trim() === '')
      return new Response('Each winner needs a candidateId', { status: 400 });
    rawEntries.push({
      candidateId,
      termStart: record?.termStart,
      termEnd: record?.termEnd,
      title: record?.title,
    });
  }

  // 5a. repeated candidateId
  const candidateIds = rawEntries.map((w) => w.candidateId);
  if (new Set(candidateIds).size !== candidateIds.length)
    return new Response('The same candidate cannot win twice', {
      status: 400,
    });

  // 5b. candidateId must belong to this election and must not be withdrawn
  const candidateRows: WinnerCandidate[] = await db
    .select({
      id: candidates.id,
      electionId: candidates.electionId,
      withdrawn: candidates.withdrawn,
      boardPersonId: candidates.boardPersonId,
      fullName: candidates.fullName,
    })
    .from(candidates)
    .where(inArray(candidates.id, candidateIds));
  const candidateById = new Map(candidateRows.map((c) => [c.id, c]));
  for (const w of rawEntries) {
    const c = candidateById.get(w.candidateId);
    if (!c || c.electionId !== id)
      return new Response('Unknown candidate in winners', { status: 400 });
    if (c.withdrawn)
      return new Response('Cannot certify a withdrawn candidate', {
        status: 400,
      });
  }

  // 6. termStart/termEnd must be valid ISO dates, termEnd must not precede
  // termStart (same rule board-terms.ts enforces on every write), and title
  // is capped the same way normalizeBoardTermInput caps it.
  const winners: Winner[] = [];
  for (const w of rawEntries) {
    const c = candidateById.get(w.candidateId)!;
    const termStartRaw =
      typeof w.termStart === 'string' ? w.termStart.trim() : '';
    if (!termStartRaw)
      return new Response('termStart is required', { status: 400 });
    const startResult = isoDateOrError(termStartRaw, 'termStart');
    if (!startResult.ok)
      return new Response(startResult.error, { status: 400 });

    let termEnd: string | null = null;
    if (w.termEnd !== undefined && w.termEnd !== null) {
      if (typeof w.termEnd !== 'string')
        return new Response('termEnd must be a string', { status: 400 });
      const trimmedEnd = w.termEnd.trim();
      if (trimmedEnd) {
        const endResult = isoDateOrError(trimmedEnd, 'termEnd');
        if (!endResult.ok)
          return new Response(endResult.error, { status: 400 });
        termEnd = endResult.value;
      }
    }
    const rangeError = termRangeError(startResult.value, termEnd);
    if (rangeError) return new Response(rangeError, { status: 400 });

    let title: string | null = null;
    if (w.title !== undefined && w.title !== null) {
      if (typeof w.title !== 'string')
        return new Response('title must be a string', { status: 400 });
      const trimmedTitle = w.title.trim();
      if (trimmedTitle.length > INPUT_LIMITS.officeTitle)
        return new Response(
          `title must be ${INPUT_LIMITS.officeTitle} characters or fewer`,
          { status: 400 },
        );
      title = trimmedTitle || null;
    }

    winners.push({
      candidateId: w.candidateId,
      termStart: startResult.value,
      termEnd,
      title,
      boardPersonId: c.boardPersonId,
      fullName: c.fullName,
    });
  }

  // 7. two winners resolving to the same non-null board_person_id — a
  // repeated candidateId (5a) does not catch this, since two distinct
  // candidate rows may carry the same boardPersonId.
  const linkedPersonIds = winners
    .map((w) => w.boardPersonId)
    .filter((pid): pid is string => pid !== null);
  if (new Set(linkedPersonIds).size !== linkedPersonIds.length)
    return new Response('Two winners resolve to the same board person', {
      status: 400,
    });

  // 8. a winner already holding an open term (term_end IS NULL) — only
  // winners whose candidate already carries a boardPersonId can possibly
  // hold one; a candidate with none is a new person by definition.
  if (linkedPersonIds.length > 0) {
    const openTerms = await db
      .select({ personId: boardTerms.personId })
      .from(boardTerms)
      .where(
        and(
          inArray(boardTerms.personId, linkedPersonIds),
          isNull(boardTerms.termEnd),
        ),
      );
    if (openTerms.length > 0) {
      const openPersonId = openTerms[0].personId;
      const winner = winners.find((w) => w.boardPersonId === openPersonId)!;
      return new Response(
        `${winner.fullName} already holds an open term — end it before certifying`,
        { status: 409 },
      );
    }
  }

  // Effects, all in one batch. The first statement reserves this closed
  // election with a temporary status and re-checks the existing-person
  // open-term invariant at the mutation boundary. The temporary value is
  // never externally visible or committed: every effect requires it, and
  // the final statement replaces it with `certified`. A competing batch for
  // another election that opens a term first makes this reservation a no-op,
  // which in turn makes every dependent effect a no-op.
  //
  // Every new id is pre-generated in JS — a D1 batch cannot thread a
  // RETURNING value from one statement into the next, so the board_terms rows
  // below must reference person ids that already exist as JS values before
  // the batch is built.
  const ctx = await resolveAuthContext(locals, request, env);
  const now = Math.floor(Date.now() / 1000);
  const reservationStatus = '__certifying__';
  const linkedPersonPlaceholders = linkedPersonIds.map(() => '?').join(', ');
  const openTermGuard =
    linkedPersonIds.length > 0
      ? `AND NOT EXISTS (
           SELECT 1 FROM board_terms
           WHERE person_id IN (${linkedPersonPlaceholders})
             AND term_end IS NULL
         )`
      : '';
  const statements: D1PreparedStatement[] = [
    env.DATABASE.prepare(
      `UPDATE elections
       SET status = ?, updated_at = ?
       WHERE id = ? AND status = 'closed'
         ${openTermGuard}
       RETURNING id`,
    ).bind(reservationStatus, now, id, ...linkedPersonIds),
  ];
  for (const w of winners) {
    if (w.boardPersonId === null) {
      const personId = crypto.randomUUID();
      statements.push(
        env.DATABASE.prepare(
          `INSERT INTO board_people (id, full_name, created_at, updated_at)
           SELECT ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM elections WHERE id = ? AND status = ?
           )`,
        ).bind(personId, w.fullName, now, now, id, reservationStatus),
      );
      // Backfilled so a re-run cannot mint a second identity for the same
      // human — ADR 0012's whole point is one identity across terms.
      statements.push(
        env.DATABASE.prepare(
          `UPDATE candidates
           SET board_person_id = ?
           WHERE id = ? AND election_id = ?
             AND EXISTS (
               SELECT 1 FROM elections WHERE id = ? AND status = ?
             )`,
        ).bind(personId, w.candidateId, id, id, reservationStatus),
      );
      w.boardPersonId = personId;
    }
  }
  for (const w of winners) {
    statements.push(
      env.DATABASE.prepare(
        `INSERT INTO board_terms (
           id, person_id, title, term_start, term_end, election_id,
           created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM elections WHERE id = ? AND status = ?
         )
           AND NOT EXISTS (
             SELECT 1 FROM board_terms
             WHERE person_id = ? AND term_end IS NULL
           )`,
      ).bind(
        crypto.randomUUID(),
        w.boardPersonId!,
        w.title,
        w.termStart,
        w.termEnd,
        id,
        now,
        now,
        id,
        reservationStatus,
        w.boardPersonId!,
      ),
    );
  }
  const winnerPlaceholders = winners.map(() => '?').join(', ');
  statements.push(
    env.DATABASE.prepare(
      `UPDATE candidates
       SET won = 1
       WHERE election_id = ? AND id IN (${winnerPlaceholders})
         AND EXISTS (
           SELECT 1 FROM elections WHERE id = ? AND status = ?
         )`,
    ).bind(id, ...winners.map((w) => w.candidateId), id, reservationStatus),
  );
  statements.push(
    env.DATABASE.prepare(
      `UPDATE elections
       SET status = 'certified', certified_at = ?, certified_by = ?,
           updated_at = ?
       WHERE id = ? AND status = ?
       RETURNING id`,
    ).bind(now, ctx?.userId ?? 'unknown', now, id, reservationStatus),
  );
  const results = await env.DATABASE.batch(statements);
  const reservation = results[0];
  const transition = results[results.length - 1];
  if (reservation.meta.changes !== 1 || transition.meta.changes !== 1) {
    if (linkedPersonIds.length > 0) {
      const openTerms = await db
        .select({ personId: boardTerms.personId })
        .from(boardTerms)
        .where(
          and(
            inArray(boardTerms.personId, linkedPersonIds),
            isNull(boardTerms.termEnd),
          ),
        );
      if (openTerms.length > 0) {
        const winner = winners.find(
          (w) => w.boardPersonId === openTerms[0].personId,
        )!;
        return new Response(
          `${winner.fullName} already holds an open term — end it before certifying`,
          { status: 409 },
        );
      }
    }
    return new Response('Election is no longer closed', { status: 409 });
  }
  return new Response(null, { status: 204 });
}

async function uncertifyElection(db: Db, body: unknown): Promise<Response> {
  const id = stringField(body, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  const existing = await db
    .select({ status: elections.status })
    .from(elections)
    .where(eq(elections.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Election not found', { status: 404 });
  if (existing[0].status !== 'certified')
    return new Response('Only a certified election can be uncertified', {
      status: 409,
    });
  // board_people rows created by certify are left alone — they may by now be
  // referenced elsewhere, and the roster panel already refuses deletion of a
  // person anything references.
  await db.batch([
    db.delete(boardTerms).where(eq(boardTerms.electionId, id)),
    db
      .update(candidates)
      .set({ won: false })
      .where(eq(candidates.electionId, id)),
    db
      .update(elections)
      .set({
        status: 'closed',
        certifiedAt: null,
        certifiedBy: null,
        updatedAt: new Date(),
      })
      .where(eq(elections.id, id)),
  ] as never);
  return new Response(null, { status: 204 });
}

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  return Response.json(await fetchAdminElections(env));
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const db = getDb(env);
  const action = stringField(parsed.value, 'action');

  switch (action) {
    case 'open':
      return openElection(env.DATABASE, parsed.value);
    case 'close':
      return closeElection(db, env.DATABASE, parsed.value);
    case 'void':
      return voidElection(db, parsed.value);
    case 'setTallies':
      return setTallies(db, parsed.value);
    case 'setBallots':
      return setBallots(db, parsed.value);
    case 'certify':
      return certifyElection(db, parsed.value, locals, request);
    case 'uncertify':
      return uncertifyElection(db, parsed.value);
    case '':
      break;
    default:
      return new Response('Unknown action', { status: 400 });
  }

  const result = normalizeElectionInput(parsed.value, 'create');
  if (!result.ok) return new Response(result.error, { status: 400 });
  const meetingCheck = await checkMeetingExists(db, result.value.meetingId);
  if (meetingCheck) return meetingCheck;
  const ctx = await resolveAuthContext(locals, request, env);
  const now = new Date();
  const id = crypto.randomUUID();
  await db.insert(elections).values({
    id,
    meetingId: result.value.meetingId ?? null,
    // create mode guarantees title, seats, and electionDate are present
    title: result.value.title!,
    seats: result.value.seats!,
    electionDate: result.value.electionDate!,
    source: result.value.source ?? 'recorded',
    status: 'draft',
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
  // The normalizer rejects any payload carrying status, source, or
  // certification provenance — those are transition-only, maintained by
  // close/void/certify/uncertify together with their preconditions.
  const result = normalizeElectionInput(parsed.value, 'patch');
  if (!result.ok) return new Response(result.error, { status: 400 });
  const input = result.value;
  if (Object.keys(input).length === 0)
    return new Response('No fields to update', { status: 400 });
  const db = getDb(env);
  const existing = await db
    .select({
      id: elections.id,
      status: elections.status,
      source: elections.source,
    })
    .from(elections)
    .where(eq(elections.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Election not found', { status: 404 });
  if (existing[0].source === 'conducted' && existing[0].status !== 'draft')
    return new Response(
      'A conducted election cannot be changed after it opens',
      { status: 409 },
    );
  if (existing[0].status === 'certified' || existing[0].status === 'void')
    return new Response(CERTIFIED_OR_VOID('it'), { status: 409 });
  const meetingCheck = await checkMeetingExists(db, input.meetingId);
  if (meetingCheck) return meetingCheck;
  // An election is not moved between meetings' bookkeeping via any other
  // mechanism — only these fields, matching owners.ts's PATCH allow-list.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.title !== undefined) set.title = input.title;
  if (input.seats !== undefined) set.seats = input.seats;
  if (input.electionDate !== undefined) set.electionDate = input.electionDate;
  if (input.meetingId !== undefined) set.meetingId = input.meetingId;
  if (input.visibility !== undefined) set.visibility = input.visibility;
  const updateGuard =
    existing[0].source === 'conducted'
      ? and(
          eq(elections.id, id),
          eq(elections.source, 'conducted'),
          eq(elections.status, 'draft'),
        )
      : and(
          eq(elections.id, id),
          eq(elections.source, 'recorded'),
          notInArray(elections.status, ['certified', 'void']),
        );
  const updated = await db
    .update(elections)
    .set(set)
    .where(updateGuard)
    .returning({ id: elections.id });
  if (updated.length !== 1)
    return new Response('Election configuration is frozen', { status: 409 });
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
  // A closed election is a record; a certified one doubly so. Only a draft —
  // one that never produced a tally or ballot anyone relies on — is
  // removable. Deleting cascades its candidates and ballots via FK.
  const existing = await db
    .select({ status: elections.status })
    .from(elections)
    .where(eq(elections.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Election not found', { status: 404 });
  if (existing[0].status !== 'draft')
    return new Response(
      `Only a draft election can be deleted — one that is already ${existing[0].status} is part of the record.`,
      { status: 409 },
    );
  const deleted = await db
    .delete(elections)
    .where(and(eq(elections.id, id), eq(elections.status, 'draft')))
    .returning({ id: elections.id });
  if (deleted.length !== 1)
    return new Response('Only a draft election can be deleted', {
      status: 409,
    });
  return new Response(null, { status: 204 });
};
