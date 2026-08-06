import type { APIRoute } from 'astro';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
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
  motionEligibility,
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
import { LIVE_VOTING_ENABLED_SQL } from '../../../server/content/voting-state';

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
  | { found: false }
  | {
      found: true;
      body: string;
      meetingId: string;
      votingState: 'none' | 'open' | 'closed';
      votingRevision: number;
    }
> {
  const existing = await db
    .select({
      meetingId: motions.meetingId,
      votingState: motions.votingState,
      votingRevision: motions.votingRevision,
    })
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
    votingState: existing[0].votingState,
    votingRevision: existing[0].votingRevision,
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

async function setMemberVotes(
  db: Db,
  database: D1Database,
  body: unknown,
): Promise<Response> {
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
  if (lookup.votingState === 'open')
    return new Response(
      'Member votes cannot be corrected while voting is open',
      {
        status: 409,
      },
    );

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

  // Once first-open eligibility exists, every correction uses that immutable
  // electorate and its frozen weights. Before first open, preserve the
  // recorded-meeting behavior of resolving the current property roster.
  const propertyIds = parsedEntries.value.map((e) => e.propertyId);
  const eligibilityRows = await db
    .select({
      propertyId: motionEligibility.propertyId,
      weight: motionEligibility.weight,
    })
    .from(motionEligibility)
    .where(eq(motionEligibility.motionId, motionId));
  const weightById =
    eligibilityRows.length > 0
      ? new Map(eligibilityRows.map((row) => [row.propertyId, row.weight]))
      : new Map(
          (propertyIds.length > 0
            ? await db
                .select({
                  id: properties.id,
                  voteWeight: properties.voteWeight,
                })
                .from(properties)
                .where(inArray(properties.id, propertyIds))
            : []
          ).map((row) => [row.id, row.voteWeight]),
        );
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
  // Full replace, atomically, as a compare-and-swap on both lifecycle state
  // and monotonic revision. State alone is vulnerable to closed -> open ->
  // closed ABA: the value looks unchanged even though a live session occurred.
  // Delete first using the captured pair, then advance the revision, then gate
  // one set-based insert on that CAS statement's changes() result. D1 executes
  // the batch as one transaction, so a stale or competing replacement writes
  // nothing and returns 409.
  const updatedAt = Math.floor(Date.now() / 1000);
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `DELETE FROM member_votes
         WHERE motion_id = ?
           AND EXISTS (
             SELECT 1 FROM motions
             JOIN meetings ON meetings.id = motions.meeting_id
             WHERE motions.id = ?
               AND motions.voting_state = ?
               AND motions.voting_revision = ?
               AND meetings.body = 'member'
           )`,
      )
      .bind(motionId, motionId, lookup.votingState, lookup.votingRevision),
    database
      .prepare(
        `UPDATE motions
         SET updated_at = ?, voting_revision = voting_revision + 1
         WHERE id = ?
           AND voting_state = ?
           AND voting_revision = ?
           AND EXISTS (
             SELECT 1 FROM meetings
             WHERE meetings.id = motions.meeting_id
               AND meetings.body = 'member'
           )
         RETURNING id`,
      )
      .bind(updatedAt, motionId, lookup.votingState, lookup.votingRevision),
  ];
  if (rows.length > 0) {
    const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
    statements.push(
      database
        .prepare(
          `WITH replacement
             (id, motion_id, property_id, cast_by_owner_id, weight, choice, proxy_id)
           AS (VALUES ${placeholders})
           INSERT INTO member_votes
             (id, motion_id, property_id, cast_by_owner_id, weight, choice, proxy_id)
           SELECT id, motion_id, property_id, cast_by_owner_id, weight, choice, proxy_id
           FROM replacement
           WHERE changes() = 1`,
        )
        .bind(
          ...rows.flatMap((row) => [
            row.id,
            row.motionId,
            row.propertyId,
            row.castByOwnerId,
            row.weight,
            row.choice,
            row.proxyId,
          ]),
        ),
    );
  }
  const [, guard, inserted] = await database.batch(statements);
  if (guard.meta.changes !== 1)
    return new Response(
      'Member votes changed or the motion lifecycle advanced before correction',
      {
        status: 409,
      },
    );
  if (rows.length > 0 && inserted?.meta.changes !== rows.length)
    return new Response('Member vote correction was not fully recorded', {
      status: 500,
    });
  return new Response(null, { status: 204 });
}

async function openVoting(
  database: D1Database,
  body: unknown,
): Promise<Response> {
  const id = stringField(body, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  const updatedAt = Math.floor(Date.now() / 1000);
  const [transition, snapshot] = await database.batch([
    database
      .prepare(
        `UPDATE motions
         SET voting_state = 'open',
             voting_revision = voting_revision + 1,
             updated_at = ?
         WHERE id = ?
           AND ${LIVE_VOTING_ENABLED_SQL}
           AND EXISTS (
             SELECT 1 FROM meetings
             WHERE meetings.id = motions.meeting_id
               AND meetings.body = 'member'
               AND meetings.status = 'draft'
           )
           AND (
             (
               voting_state = 'none'
               AND NOT EXISTS (
                 SELECT 1 FROM member_votes
                 WHERE member_votes.motion_id = motions.id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM motion_eligibility
                 WHERE motion_eligibility.motion_id = motions.id
               )
               AND EXISTS (
                 SELECT 1 FROM properties
                 WHERE properties.status = 'active'
               )
             )
             OR (
               voting_state = 'closed'
               AND EXISTS (
                 SELECT 1 FROM motion_eligibility
                 WHERE motion_eligibility.motion_id = motions.id
               )
             )
           )
         RETURNING id`,
      )
      .bind(updatedAt, id),
    database
      .prepare(
        `INSERT INTO motion_eligibility (motion_id, property_id, weight)
         SELECT ?, properties.id, properties.vote_weight
         FROM properties
         WHERE properties.status = 'active'
           AND changes() = 1
           AND NOT EXISTS (
             SELECT 1 FROM motion_eligibility
             WHERE motion_eligibility.motion_id = ?
           )`,
      )
      .bind(id, id),
  ]);
  if (transition.meta.changes !== 1)
    return new Response('Motion voting cannot be opened', { status: 409 });
  // A successful first open inserts at least one property because the guarded
  // transition requires one; a reopen deliberately writes zero snapshot rows.
  if (snapshot.meta.changes === 0) {
    const frozen = await database
      .prepare(
        `SELECT 1 FROM motion_eligibility
         WHERE motion_id = ? LIMIT 1`,
      )
      .bind(id)
      .first();
    if (!frozen)
      return new Response('Motion eligibility snapshot was not created', {
        status: 500,
      });
  }
  return new Response(null, { status: 204 });
}

async function closeVoting(
  database: D1Database,
  body: unknown,
): Promise<Response> {
  const id = stringField(body, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  const [transition] = await database.batch([
    database
      .prepare(
        `UPDATE motions
         SET voting_state = 'closed',
             voting_revision = voting_revision + 1,
             updated_at = ?
         WHERE id = ?
           AND voting_state = 'open'
           AND EXISTS (
             SELECT 1 FROM meetings
             WHERE meetings.id = motions.meeting_id
               AND meetings.body = 'member'
               AND meetings.status = 'draft'
           )
         RETURNING id`,
      )
      .bind(Math.floor(Date.now() / 1000), id),
  ]);
  if (transition.meta.changes !== 1)
    return new Response('Motion voting cannot be closed', { status: 409 });
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
      return setMemberVotes(db, env.DATABASE, parsed.value);
    case 'openVoting':
      return openVoting(env.DATABASE, parsed.value);
    case 'closeVoting':
      return closeVoting(env.DATABASE, parsed.value);
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
    .select({ id: motions.id, votingState: motions.votingState })
    .from(motions)
    .where(eq(motions.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Motion not found', { status: 404 });
  if (existing[0].votingState === 'open')
    return new Response('A motion cannot be edited while voting is open', {
      status: 409,
    });
  if (existing[0].votingState === 'closed' && input.text !== undefined)
    return new Response('Motion text is frozen after voting first opens', {
      status: 409,
    });
  // A motion is not moved between meetings via PATCH — only these fields.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.text !== undefined) set.text = input.text;
  if (input.moverPersonId !== undefined)
    set.moverPersonId = input.moverPersonId;
  if (input.secondPersonId !== undefined)
    set.secondPersonId = input.secondPersonId;
  if (input.outcome !== undefined) set.outcome = input.outcome;
  const updated = await db
    .update(motions)
    .set(set)
    .where(
      and(
        eq(motions.id, id),
        input.text !== undefined
          ? eq(motions.votingState, 'none')
          : ne(motions.votingState, 'open'),
      ),
    )
    .returning({ id: motions.id });
  if (updated.length !== 1)
    return new Response('The motion lifecycle changed before the edit', {
      status: 409,
    });
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
    .select({ votingState: motions.votingState })
    .from(motions)
    .where(eq(motions.id, id))
    .limit(1);
  if (
    existing[0]?.votingState !== undefined &&
    existing[0].votingState !== 'none'
  )
    return new Response('A motion with live-voting history cannot be deleted', {
      status: 409,
    });
  const frozen = await db
    .select({ motionId: motionEligibility.motionId })
    .from(motionEligibility)
    .where(eq(motionEligibility.motionId, id))
    .limit(1);
  if (frozen.length > 0)
    return new Response('A motion with live-voting history cannot be deleted', {
      status: 409,
    });
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
  // Repeat the retention predicate in the mutation itself so first open and
  // delete serialize safely: whichever commits second observes the winner.
  const deleted = await env.DATABASE.prepare(
    `DELETE FROM motions
     WHERE id = ?
       AND voting_state = 'none'
       AND NOT EXISTS (
         SELECT 1 FROM motion_eligibility
         WHERE motion_eligibility.motion_id = motions.id
       )
     RETURNING id`,
  )
    .bind(id)
    .run();
  // `meta.changes` can include cascaded vote rows; RETURNING identifies the
  // one parent motion this guarded statement was allowed to delete.
  if (existing.length > 0 && deleted.results.length !== 1)
    return new Response('A motion with live-voting history cannot be deleted', {
      status: 409,
    });
  return new Response(null, { status: 204 });
};
