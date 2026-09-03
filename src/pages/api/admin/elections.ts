import type { APIRoute } from 'astro';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
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
  meetings,
} from '../../../server/db/schema';
import { people } from '../../../server/db/roster-schema';
import { normalizeElectionInput, isoDateOrError } from '../../../lib/types';
import { fetchAdminElections } from '../../../server/content/reads';
import {
  proxyUseError,
  proxyUsesValidAtMutation,
  parseProvenance,
  personExistenceError,
} from '../../../server/content/proxy-guards';
import { LIVE_VOTING_ENABLED_SQL } from '../../../server/content/voting-state';
import {
  RESERVATION_SENTINELS,
  reservationGuard,
  runReservedBatch,
} from '../../../server/content/election-reservation';
import {
  AuditCorrelation,
  operationKey,
  assertInBatch,
  insertedRowGuard,
  isBatchAssertionError,
  type SqlGuard,
} from '../../../server/roster/audit';
import {
  qualifiesGuard,
  noOverlapGuard,
} from '../../../server/roster/board-consequences';
import { OFFICES } from '../../../server/roster/reads';
import { normalizeName } from '../../../server/roster/normalize';
import { associationDateIso } from '../../../lib/format';

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
  // Reserve the parent inside the same D1 transaction as the replacement —
  // see `election-reservation.ts` for the protocol. The candidate-count term
  // is specific to this action: the release restores the original status, so
  // the reservation must also pin the candidate set the replacement was
  // computed against.
  const sentinel = RESERVATION_SENTINELS.tallies;
  const guard = reservationGuard(electionId, sentinel);
  const updatedAt = Math.floor(Date.now() / 1000);
  const reserve = env.DATABASE.prepare(
    `UPDATE elections
       SET status = ?
       WHERE id = ? AND source = 'recorded' AND status = ?
         AND (SELECT COUNT(*) FROM candidates WHERE election_id = ?) = ?
       RETURNING id`,
  ).bind(
    sentinel,
    electionId,
    election.status,
    electionId,
    candidateRows.length,
  );
  const children = candidateRows.map((candidate) =>
    env.DATABASE.prepare(
      `UPDATE candidates
         SET votes = ?
         WHERE id = ? AND election_id = ? AND ${guard.sql}`,
    ).bind(
      votesByCandidate.get(candidate.id) ?? null,
      candidate.id,
      electionId,
      ...guard.binds,
    ),
  );
  const release = env.DATABASE.prepare(
    `UPDATE elections
       SET status = ?, updated_at = ?
       WHERE id = ? AND status = ?
       RETURNING id`,
  ).bind(election.status, updatedAt, electionId, sentinel);
  const committed = await runReservedBatch(
    env.DATABASE,
    reserve,
    children,
    release,
  );
  if (!committed)
    return new Response(CERTIFIED_OR_VOID('tallies'), { status: 409 });
  return new Response(null, { status: 204 });
}

interface BallotEntry {
  propertyId: string;
  weight?: number;
  proxyId: string | null;
  castByPersonId: string | null;
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
    if (typeof propertyId !== 'string' || propertyId.trim() === '') {
      return { ok: false, error: 'Each ballot entry needs a propertyId' };
    }
    let parsedWeight: number | undefined;
    if (weight !== undefined) {
      if (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 1)
        return { ok: false, error: 'weight must be a positive integer' };
      parsedWeight = weight;
    }
    const provenance = parseProvenance(record, 'castByPersonId');
    if (!provenance.ok) return { ok: false, error: provenance.error };
    entries.push({
      propertyId,
      weight: parsedWeight,
      proxyId: provenance.value.proxyId,
      castByPersonId: provenance.value.personId,
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
      electionDate: elections.electionDate,
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

  const proxyUses = parsedEntries.value
    .filter((e) => e.proxyId !== null)
    .map((e) => ({ propertyId: e.propertyId, proxyId: e.proxyId! }));
  const proxyOccasion = {
    electionId,
    meetingId: election.meetingId,
    associationDay: election.electionDate,
  };
  const proxyFailure = await proxyUseError(db, proxyUses, proxyOccasion);
  if (proxyFailure)
    return new Response(proxyFailure.message, {
      status: proxyFailure.status,
    });

  // castByPersonId is a nullable FK to people, so an unknown id would otherwise
  // throw a raw D1 FOREIGN KEY error out of the insert below. Checked here for
  // the whole entry set rather than per entry, matching the two sibling routes.
  const personFailure = await personExistenceError(
    db,
    parsedEntries.value.map((e) => e.castByPersonId),
    'castByPersonId',
  );
  if (personFailure)
    return new Response(personFailure.message, {
      status: personFailure.status,
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

  const rows: {
    id: string;
    propertyId: string;
    weight: number;
    proxyId: string | null;
    castByPersonId: string | null;
  }[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const e of parsedEntries.value) {
    const dbWeight = weightById.get(e.propertyId);
    if (dbWeight === undefined)
      return new Response('Unknown property in entries', { status: 400 });
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
      castByPersonId: e.castByPersonId,
    });
  }

  // Full replace, atomically: a lot omitted from `entries` returned no
  // ballot this time and is removed, not left at its previous value. Same
  // reservation protocol as setTallies — see `election-reservation.ts`.
  const sentinel = RESERVATION_SENTINELS.ballots;
  const guard = reservationGuard(electionId, sentinel);
  const proxyGuard = proxyUsesValidAtMutation(proxyUses, proxyOccasion);
  const reserve = env.DATABASE.prepare(
    `UPDATE elections
       SET status = ?
       WHERE id = ?
         AND source = 'recorded'
         AND status = ?
         AND election_date = ?
         AND meeting_id IS ?
         AND ${proxyGuard.sql}
       RETURNING id`,
  ).bind(
    sentinel,
    electionId,
    election.status,
    election.electionDate,
    election.meetingId,
    ...proxyGuard.binds,
  );
  const children: D1PreparedStatement[] = [
    env.DATABASE.prepare(
      `DELETE FROM ballots WHERE election_id = ? AND ${guard.sql}`,
    ).bind(electionId, ...guard.binds),
  ];
  for (const row of rows) {
    children.push(
      env.DATABASE.prepare(
        `INSERT INTO ballots (
           id, election_id, property_id, cast_by_person_id, proxy_id,
           weight, recorded_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE ${guard.sql}`,
      ).bind(
        row.id,
        electionId,
        row.propertyId,
        row.castByPersonId,
        row.proxyId,
        row.weight,
        now,
        ...guard.binds,
      ),
    );
  }
  const release = env.DATABASE.prepare(
    `UPDATE elections
       SET status = ?, updated_at = ?
       WHERE id = ? AND status = ?
       RETURNING id`,
  ).bind(election.status, now, electionId, sentinel);
  const committed = await runReservedBatch(
    env.DATABASE,
    reserve,
    children,
    release,
  );
  if (!committed)
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
  fullName: string;
}

interface Winner {
  candidateId: string;
  /** An existing Person, or null — the batch then creates one (which, having
   * no Ownership or Representation yet, cannot pass the qualification gate;
   * the escape is recording the basis first, #203). */
  personId: string | null;
  /** Pre-generated for the created-Person path; a D1 batch cannot thread ids
   * between statements. */
  createdPersonId: string;
  termId: string;
  qualifyingLotId: string;
  startDay: string;
  scheduledEndDay: string;
  office: string | null;
  officeAssignmentId?: string;
  fullName: string;
}

/**
 * ADR 0022 phase 3b (#218), per #203: certification creates PARTY-ROSTER
 * facts — a `board_service_terms` row per winner (election provenance
 * stamped), an optional Office Assignment — and never a legacy
 * board_people/board_terms row; the legacy identity layer is retired, not
 * ported. `qualifyingLotId` is required and validated as a Lot the winner
 * currently owns or represents and which no other current Board Member
 * holds; a winner qualifying nowhere is a hard 409 naming them, and the
 * escape is recording the Ownership or Representation that actually
 * qualifies them, not a bypass flag. Certification still creates NO Access
 * Grant — Board Access is never implicit.
 */
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
  // anything up. Field validation (precondition 6) happens in a later pass so
  // a candidateId problem (precondition 5) is always reported first.
  interface RawWinner {
    candidateId: string;
    personId: unknown;
    qualifyingLotId: unknown;
    startDay: unknown;
    scheduledEndDay: unknown;
    office: unknown;
  }
  const rawEntries: RawWinner[] = [];
  for (const item of rawWinners) {
    const record = item as Record<string, unknown> | null;
    const candidateId = record?.candidateId;
    if (typeof candidateId !== 'string' || candidateId.trim() === '')
      return new Response('Each winner needs a candidateId', { status: 400 });
    rawEntries.push({
      candidateId,
      personId: record?.personId,
      qualifyingLotId: record?.qualifyingLotId,
      startDay: record?.startDay,
      scheduledEndDay: record?.scheduledEndDay,
      office: record?.office,
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

  // 6. per-winner fields: a real qualifying Lot, valid ordered days, an
  // office from the bylaws' three when supplied, and a personId that names a
  // real Person when supplied.
  const winners: Winner[] = [];
  for (const w of rawEntries) {
    const c = candidateById.get(w.candidateId)!;

    const lotRaw =
      typeof w.qualifyingLotId === 'string' ? w.qualifyingLotId.trim() : '';
    if (!lotRaw)
      return new Response('Each winner needs a qualifyingLotId', {
        status: 400,
      });
    const lotRows = await db
      .select({ id: properties.id, retiredAt: properties.retiredAt })
      .from(properties)
      .where(eq(properties.id, lotRaw))
      .limit(1);
    if (lotRows.length === 0)
      return new Response('Lot not found', { status: 404 });
    if (lotRows[0].retiredAt !== null)
      return new Response('Lot is retired', { status: 409 });

    const startRaw = typeof w.startDay === 'string' ? w.startDay.trim() : '';
    if (!startRaw) return new Response('startDay is required', { status: 400 });
    const startResult = isoDateOrError(startRaw, 'startDay');
    if (!startResult.ok)
      return new Response(startResult.error, { status: 400 });
    const schedRaw =
      typeof w.scheduledEndDay === 'string' ? w.scheduledEndDay.trim() : '';
    if (!schedRaw)
      return new Response('scheduledEndDay is required', { status: 400 });
    const schedResult = isoDateOrError(schedRaw, 'scheduledEndDay');
    if (!schedResult.ok)
      return new Response(schedResult.error, { status: 400 });
    if (schedResult.value <= startResult.value)
      return new Response('scheduledEndDay must be after startDay', {
        status: 400,
      });

    let office: string | null = null;
    if (w.office !== undefined && w.office !== null) {
      if (typeof w.office !== 'string')
        return new Response('office must be a string', { status: 400 });
      const trimmed = w.office.trim();
      if (trimmed) {
        if (!(OFFICES as readonly string[]).includes(trimmed))
          return new Response(
            "office must be one of 'president', 'vice_president', 'secretary_treasurer'",
            { status: 400 },
          );
        office = trimmed;
      }
    }

    let personId: string | null = null;
    if (w.personId !== undefined && w.personId !== null) {
      if (typeof w.personId !== 'string')
        return new Response('personId must be a string', { status: 400 });
      const trimmed = w.personId.trim();
      if (trimmed) {
        const personRows = await db
          .select({ partyId: people.partyId })
          .from(people)
          .where(eq(people.partyId, trimmed))
          .limit(1);
        if (personRows.length === 0)
          return new Response('Person not found', { status: 404 });
        personId = trimmed;
      }
    }

    winners.push({
      candidateId: w.candidateId,
      personId,
      createdPersonId: crypto.randomUUID(),
      termId: crypto.randomUUID(),
      qualifyingLotId: lotRaw,
      startDay: startResult.value,
      scheduledEndDay: schedResult.value,
      office,
      fullName: c.fullName,
    });
  }

  // 7. two winners resolving to the same Person
  const namedPersonIds = winners
    .map((w) => w.personId)
    .filter((pid): pid is string => pid !== null);
  if (new Set(namedPersonIds).size !== namedPersonIds.length)
    return new Response('Two winners resolve to the same person', {
      status: 400,
    });

  // 8. readable halves of the mutation-boundary gates: the winner qualifies
  // through the Lot, and neither the person nor the Lot has an overlapping
  // term. A winner with NO personId gets a fresh Person in the batch — which
  // owns nothing and therefore cannot pass qualification; the readable
  // refusal lands here rather than as an opaque batch failure.
  const associationDay = associationDateIso();
  const notQualified = (name: string) =>
    new Response(
      `${name} does not currently own or represent that lot — record the ownership or representation first`,
      { status: 409 },
    );
  for (const w of winners) {
    if (w.personId === null) return notQualified(w.fullName);
    const probes: [SqlGuard, Response][] = [
      [
        qualifiesGuard(w.personId, w.qualifyingLotId, associationDay),
        notQualified(w.fullName),
      ],
      [
        noOverlapGuard('person_id', w.personId, w.startDay, w.scheduledEndDay),
        new Response(`${w.fullName} already holds an overlapping term`, {
          status: 409,
        }),
      ],
      [
        noOverlapGuard(
          'qualifying_lot_id',
          w.qualifyingLotId,
          w.startDay,
          w.scheduledEndDay,
        ),
        new Response(
          `That lot already qualifies another board member for an overlapping term (${w.fullName})`,
          { status: 409 },
        ),
      ],
    ];
    for (const [probe, refusal] of probes) {
      const row = await env.DATABASE.prepare(
        `SELECT CASE WHEN ${probe.sql} THEN 1 ELSE 0 END AS ok`,
      )
        .bind(...probe.binds)
        .first<{ ok: number }>();
      if (row?.ok !== 1) return refusal;
    }
  }

  // Effects, all in one reserved batch. Every gate above is re-asserted in
  // SQL, and each winner's term insert is backed by an `assertInBatch` so a
  // certification can never commit with a winner's term (or an explicitly
  // requested office) missing — the whole batch rolls back instead.
  const ctx = await resolveAuthContext(locals, request, env);
  const now = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  const sentinel = RESERVATION_SENTINELS.certify;
  const guard = reservationGuard(id, sentinel);
  const reservedGuard = { sql: guard.sql, binds: guard.binds };
  const reserve = env.DATABASE.prepare(
    `UPDATE elections
       SET status = ?, updated_at = ?
       WHERE id = ? AND status = 'closed'
       RETURNING id`,
  ).bind(sentinel, now, id);

  const children: D1PreparedStatement[] = [];
  const asserts: D1PreparedStatement[] = [];
  for (const w of winners) {
    const personId = w.personId ?? w.createdPersonId;
    if (w.personId === null) {
      // Unreachable through the API today (step 8 refuses first), kept for
      // #203's resolve-or-create shape: a created Person owns nothing, so
      // the qualification gate below would refuse the term anyway.
      children.push(
        env.DATABASE.prepare(
          `INSERT INTO parties (id, kind, created_at, updated_at)
           SELECT ?, 'person', ?, ? WHERE ${guard.sql}`,
        ).bind(personId, nowMs, nowMs, ...guard.binds),
        env.DATABASE.prepare(
          `INSERT INTO people (party_id, party_kind, full_name, name_normalized, updated_at)
           SELECT ?, 'person', ?, ?, ? WHERE ${guard.sql}`,
        ).bind(
          personId,
          w.fullName,
          normalizeName(w.fullName) ?? w.fullName.toLowerCase(),
          nowMs,
          ...guard.binds,
        ),
      );
    }
    const qualifies = qualifiesGuard(
      personId,
      w.qualifyingLotId,
      associationDay,
    );
    const personClear = noOverlapGuard(
      'person_id',
      personId,
      w.startDay,
      w.scheduledEndDay,
    );
    const lotClear = noOverlapGuard(
      'qualifying_lot_id',
      w.qualifyingLotId,
      w.startDay,
      w.scheduledEndDay,
    );
    children.push(
      env.DATABASE.prepare(
        `INSERT INTO board_service_terms (id, person_id, qualifying_lot_id, election_id, start_day, scheduled_end_day, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ${guard.sql}
           AND (${qualifies.sql}) AND (${personClear.sql}) AND (${lotClear.sql})`,
      ).bind(
        w.termId,
        personId,
        w.qualifyingLotId,
        id,
        w.startDay,
        w.scheduledEndDay,
        nowMs,
        nowMs,
        ...guard.binds,
        ...qualifies.binds,
        ...personClear.binds,
        ...lotClear.binds,
      ),
    );
    asserts.push(
      assertInBatch(
        env.DATABASE,
        insertedRowGuard('board_service_terms', w.termId),
      ),
    );
    if (w.office) {
      const officeId = crypto.randomUUID();
      children.push(
        env.DATABASE.prepare(
          `INSERT INTO board_office_assignments (id, board_term_id, person_id, office, start_day, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM board_service_terms WHERE id = ?)
             AND NOT EXISTS (SELECT 1 FROM board_office_assignments WHERE office = ? AND end_day IS NULL AND voided_at IS NULL)
             AND NOT EXISTS (SELECT 1 FROM board_office_assignments WHERE person_id = ? AND end_day IS NULL AND voided_at IS NULL)`,
        ).bind(
          officeId,
          w.termId,
          personId,
          w.office,
          w.startDay,
          nowMs,
          nowMs,
          w.termId,
          w.office,
          personId,
        ),
      );
      // An explicitly requested office that cannot be assigned fails the
      // whole certification rather than silently going unassigned.
      asserts.push(
        assertInBatch(
          env.DATABASE,
          insertedRowGuard('board_office_assignments', officeId),
        ),
      );
      w.officeAssignmentId = officeId;
    }
  }
  const winnerPlaceholders = winners.map(() => '?').join(', ');
  children.push(
    env.DATABASE.prepare(
      `UPDATE candidates
       SET won = 1
       WHERE election_id = ? AND id IN (${winnerPlaceholders})
         AND ${guard.sql}`,
    ).bind(id, ...winners.map((w) => w.candidateId), ...guard.binds),
  );

  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('elections', 'certify'),
    actorAccountId: ctx?.userId ?? 'unknown',
    nowMs,
  });
  correlation.event({
    kind: 'election_certified',
    guard: reservedGuard,
    detail: {
      family: 'board_service_change',
      effective: { day: associationDay },
      reason: 'elected',
      evidence: { kind: 'election', electionId: id },
      subjects: winners.map((w) => ({
        column: 'board_term_id' as const,
        id: w.termId,
        role: 'created' as const,
      })),
    },
  });
  for (const w of winners) {
    if (!w.officeAssignmentId) continue;
    correlation.event({
      kind: 'office_assigned',
      guard: insertedRowGuard('board_office_assignments', w.officeAssignmentId),
      detail: {
        family: 'board_service_change',
        effective: { day: w.startDay },
        reason: 'office_assigned',
        evidence: { kind: 'election', electionId: id },
        subjects: [
          {
            column: 'office_assignment_id',
            id: w.officeAssignmentId,
            role: 'created',
          },
          { column: 'board_term_id', id: w.termId, role: 'related' },
        ],
      },
    });
  }

  const release = env.DATABASE.prepare(
    `UPDATE elections
       SET status = 'certified', certified_at = ?, certified_by = ?,
           updated_at = ?
       WHERE id = ? AND status = ?
       RETURNING id`,
  ).bind(now, ctx?.userId ?? 'unknown', now, id, sentinel);

  let committed: boolean;
  try {
    committed = await runReservedBatch(
      env.DATABASE,
      reserve,
      [...children, ...correlation.statements, ...asserts],
      release,
    );
  } catch (e) {
    if (isBatchAssertionError(e)) {
      // A winner's term (or requested office) failed its mutation-boundary
      // gate after the readable pre-checks passed — name the loser.
      for (const w of winners) {
        if (w.personId === null) return notQualified(w.fullName);
        const q = qualifiesGuard(w.personId, w.qualifyingLotId, associationDay);
        const row = await env.DATABASE.prepare(
          `SELECT CASE WHEN ${q.sql} THEN 1 ELSE 0 END AS ok`,
        )
          .bind(...q.binds)
          .first<{ ok: number }>();
        if (row?.ok !== 1) return notQualified(w.fullName);
        if (w.office) {
          const taken = await env.DATABASE.prepare(
            `SELECT 1 FROM board_office_assignments WHERE office = ? AND end_day IS NULL AND voided_at IS NULL LIMIT 1`,
          )
            .bind(w.office)
            .first();
          if (taken)
            return new Response('That office already has a current holder', {
              status: 409,
            });
        }
      }
      return new Response('A winner no longer qualifies for their lot', {
        status: 409,
      });
    }
    throw e;
  }
  if (!committed)
    return new Response('Election is no longer closed', { status: 409 });
  return new Response(null, { status: 204 });
}

/**
 * Uncertify VOIDS the terms certification created rather than deleting them
 * (#203, #218's acceptance criterion): a certification that happened and was
 * reversed is a fact the ledger must be able to state, so the round-trip
 * leaves voided rows visible. Office assignments on those terms are voided
 * with them, and any Board grants they qualified end now with
 * `recorded_in_error`. An election certified under the retired legacy model
 * has no `board_service_terms` rows; its uncertify finds nothing to void and
 * simply reverses the status.
 */
async function uncertifyElection(
  db: Db,
  body: unknown,
  locals: App.Locals | undefined,
  request: Request,
): Promise<Response> {
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

  const termRows = await env.DATABASE.prepare(
    `SELECT id FROM board_service_terms WHERE election_id = ? AND voided_at IS NULL`,
  )
    .bind(id)
    .all<{ id: string }>();
  const termIds = termRows.results.map((t) => t.id);
  const termPlaceholders = termIds.map(() => '?').join(', ');
  const officeRows = termIds.length
    ? await env.DATABASE.prepare(
        `SELECT id, board_term_id FROM board_office_assignments
         WHERE board_term_id IN (${termPlaceholders}) AND voided_at IS NULL`,
      )
        .bind(...termIds)
        .all<{ id: string; board_term_id: string }>()
    : { results: [] as { id: string; board_term_id: string }[] };
  const grantRows = termIds.length
    ? await env.DATABASE.prepare(
        `SELECT id, account_id, qualifying_board_term_id FROM access_grants
         WHERE qualifying_board_term_id IN (${termPlaceholders}) AND ended_at IS NULL`,
      )
        .bind(...termIds)
        .all<{
          id: string;
          account_id: string;
          qualifying_board_term_id: string;
        }>()
    : {
        results: [] as {
          id: string;
          account_id: string;
          qualifying_board_term_id: string;
        }[],
      };

  const ctx = await resolveAuthContext(locals, request, env);
  const now = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  const sentinel = RESERVATION_SENTINELS.uncertify;
  const guard = reservationGuard(id, sentinel);
  const reserve = env.DATABASE.prepare(
    `UPDATE elections SET status = ?, updated_at = ?
     WHERE id = ? AND status = 'certified'
     RETURNING id`,
  ).bind(sentinel, now, id);

  const children: D1PreparedStatement[] = [];
  if (termIds.length) {
    children.push(
      env.DATABASE.prepare(
        `UPDATE board_service_terms
         SET voided_at = ?, actual_end_day = NULL, cancelled_day = NULL, cancelled_at = NULL, updated_at = ?
         WHERE election_id = ? AND voided_at IS NULL AND ${guard.sql}`,
      ).bind(nowMs, nowMs, id, ...guard.binds),
    );
    for (const office of officeRows.results) {
      children.push(
        env.DATABASE.prepare(
          `UPDATE board_office_assignments SET voided_at = ?, end_day = NULL, updated_at = ?
           WHERE id = ? AND voided_at IS NULL AND ${guard.sql}`,
        ).bind(nowMs, nowMs, office.id, ...guard.binds),
      );
    }
    for (const grant of grantRows.results) {
      children.push(
        env.DATABASE.prepare(
          `UPDATE access_grants SET ended_at = ?, ended_by_account_id = ?, end_reason = 'recorded_in_error'
           WHERE id = ? AND ended_at IS NULL AND ${guard.sql}`,
        ).bind(nowMs, ctx?.userId ?? 'unknown', grant.id, ...guard.binds),
      );
    }
  }
  children.push(
    env.DATABASE.prepare(
      `UPDATE candidates SET won = 0 WHERE election_id = ? AND ${guard.sql}`,
    ).bind(id, ...guard.binds),
  );

  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('elections', 'uncertify'),
    actorAccountId: ctx?.userId ?? 'unknown',
    nowMs,
  });
  correlation.event({
    kind: 'election_uncertified',
    guard: { sql: guard.sql, binds: guard.binds },
    detail: {
      family: 'board_service_change',
      effective: 'not_applicable',
      reason: 'recorded_in_error',
      evidence: { kind: 'election', electionId: id },
      subjects: termIds.map((termId) => ({
        column: 'board_term_id' as const,
        id: termId,
        role: 'voided' as const,
      })),
    },
  });
  for (const office of officeRows.results) {
    correlation.event({
      kind: 'office_assignment_voided',
      actor: { kind: 'automatic', cause: 'election_uncertified' },
      guard: {
        sql: `EXISTS (SELECT 1 FROM board_office_assignments WHERE id = ? AND voided_at = ?)`,
        binds: [office.id, nowMs],
      },
      detail: {
        family: 'board_service_change',
        effective: 'not_applicable',
        reason: 'recorded_in_error',
        evidence: { kind: 'election', electionId: id },
        subjects: [
          { column: 'office_assignment_id', id: office.id, role: 'voided' },
          {
            column: 'board_term_id',
            id: office.board_term_id,
            role: 'related',
          },
        ],
      },
    });
  }
  for (const grant of grantRows.results) {
    correlation.event({
      kind: 'grant_ended',
      actor: { kind: 'automatic', cause: 'election_uncertified' },
      guard: {
        sql: `EXISTS (SELECT 1 FROM access_grants WHERE id = ? AND ended_at = ?)`,
        binds: [grant.id, nowMs],
      },
      detail: {
        family: 'access',
        grantId: grant.id,
        targetAccountId: grant.account_id,
        grantType: 'board',
        requestedAction: 'revoke',
        outcome: 'allowed',
        reason: 'recorded_in_error',
      },
    });
  }

  const release = env.DATABASE.prepare(
    `UPDATE elections
     SET status = 'closed', certified_at = NULL, certified_by = NULL, updated_at = ?
     WHERE id = ? AND status = ?
     RETURNING id`,
  ).bind(now, id, sentinel);

  const committed = await runReservedBatch(
    env.DATABASE,
    reserve,
    [...children, ...correlation.statements],
    release,
  );
  if (!committed)
    return new Response('Election is no longer certified', { status: 409 });
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
      return uncertifyElection(db, parsed.value, locals, request);
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
