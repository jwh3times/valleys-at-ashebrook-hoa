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
  elections,
  candidates,
  ballots,
  properties,
  owners,
  meetings,
} from '../../../server/db/schema';
import { normalizeElectionInput } from '../../../lib/types';
import { fetchAdminElections } from '../../../server/content/reads';

export const prerender = false;

const CERTIFIED_OR_VOID = (thing: string): string =>
  `Election is certified or void — ${thing} cannot be changed`;
// setTallies and setBallots both check this even though no election in this PR
// can ever be `source: 'conducted'` — normalizeElectionInput makes `source`
// create-immutable and POST (create) always writes 'recorded'. It is written
// now so PR 6 (live casting) cannot forget it: once `conducted` elections
// exist, their tallies are increment-only, and a board-typed tally here would
// silently overwrite real cast votes.
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
  const updates = candidateRows.map((c) =>
    db
      .update(candidates)
      .set({ votes: votesByCandidate.get(c.id) ?? null })
      .where(eq(candidates.id, c.id)),
  );
  if (updates.length > 0) await db.batch(updates as never);
  return new Response(null, { status: 204 });
}

interface BallotEntry {
  propertyId: string;
  weight?: number;
  viaProxy: boolean;
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
    const viaProxy = record?.viaProxy;
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
    if (viaProxy !== undefined && typeof viaProxy !== 'boolean') {
      return { ok: false, error: 'viaProxy must be a boolean when present' };
    }
    entries.push({
      propertyId,
      weight: parsedWeight,
      viaProxy: viaProxy === true,
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
    .select({ status: elections.status, source: elections.source })
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
    electionId: string;
    propertyId: string;
    weight: number;
    viaProxy: boolean;
    castByOwnerId: string | null;
    recordedAt: Date;
  }[] = [];
  const now = new Date();
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
      electionId,
      propertyId: e.propertyId,
      weight,
      viaProxy: e.viaProxy,
      castByOwnerId: e.castByOwnerId,
      recordedAt: now,
    });
  }

  // Full replace, atomically: a lot omitted from `entries` returned no
  // ballot this time and is removed, not left at its previous value.
  await db.batch([
    db.delete(ballots).where(eq(ballots.electionId, electionId)),
    ...(rows.length > 0 ? [db.insert(ballots).values(rows)] : []),
  ] as never);
  return new Response(null, { status: 204 });
}

async function closeElection(db: Db, body: unknown): Promise<Response> {
  const id = stringField(body, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  const existing = await db
    .select({ status: elections.status })
    .from(elections)
    .where(eq(elections.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Election not found', { status: 404 });
  if (existing[0].status !== 'draft')
    return new Response('Election is not a draft', { status: 409 });
  await db
    .update(elections)
    .set({ status: 'closed', updatedAt: new Date() })
    .where(eq(elections.id, id));
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
  await db
    .update(elections)
    .set({ status: 'void', updatedAt: new Date() })
    .where(eq(elections.id, id));
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
    case 'close':
      return closeElection(db, parsed.value);
    case 'void':
      return voidElection(db, parsed.value);
    case 'setTallies':
      return setTallies(db, parsed.value);
    case 'setBallots':
      return setBallots(db, parsed.value);
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
    source: 'recorded',
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
    .select({ id: elections.id, status: elections.status })
    .from(elections)
    .where(eq(elections.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Election not found', { status: 404 });
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
  await db.update(elections).set(set).where(eq(elections.id, id));
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
  await db.delete(elections).where(eq(elections.id, id));
  return new Response(null, { status: 204 });
};
