import { and, eq, inArray } from 'drizzle-orm';
import type {
  CastBallotInput,
  CastMotionVoteInput,
  VoteAction,
  VoteWriteResult,
} from '../../lib/types';
import type { AuthContext } from '../authz/guards';
import { getDb } from '../db/client';
import {
  ballots,
  candidates,
  electionEligibility,
  elections,
  meetings,
  memberVotes,
  motionEligibility,
  motions,
  proxies,
} from '../db/schema';
import {
  authorityKey,
  fetchLotAuthorityKeys,
  lotAuthorityExists,
} from '../roster/authority';
import { associationDateIso } from '../../lib/format';
import { proxyUseError } from './proxy-guards';
import { resolveCastingAuthority } from './casting-authority';
import { visibleTiers } from './visibility';
import { LIVE_VOTING_ENABLED_SQL } from './voting-state';

type VoteErrorStatus = 400 | 403 | 404 | 409;
type VoteActionResult =
  { ok: true; value: VoteAction } | { ok: false; error: string };

function normalizationFailure(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function voteRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function requiredVoteId(
  raw: Record<string, unknown>,
  key: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim() === '')
    return normalizationFailure(`${key} is required`);
  return { ok: true, value: value.trim() };
}

function voteProvenanceId(
  raw: Record<string, unknown>,
  key: 'castByPersonId' | 'proxyId',
): { ok: true; value: string | null } | { ok: false; error: string } {
  const value = raw[key];
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string' || value.trim() === '')
    return normalizationFailure(`${key} must be a non-empty id or null`);
  return { ok: true, value: value.trim() };
}

export function normalizeVoteAction(raw: unknown): VoteActionResult {
  const record = voteRecord(raw);
  const action = record.action;
  if (action !== 'castBallot' && action !== 'castMotionVote')
    return normalizationFailure('Unknown action');

  const propertyId = requiredVoteId(record, 'propertyId');
  if (!propertyId.ok) return propertyId;
  const castByPersonId = voteProvenanceId(record, 'castByPersonId');
  if (!castByPersonId.ok) return castByPersonId;
  const proxyId = voteProvenanceId(record, 'proxyId');
  if (!proxyId.ok) return proxyId;
  if ((castByPersonId.value === null) === (proxyId.value === null))
    return normalizationFailure(
      'Exactly one of castByPersonId or proxyId is required',
    );

  if (action === 'castBallot') {
    const electionId = requiredVoteId(record, 'electionId');
    if (!electionId.ok) return electionId;
    if (!Array.isArray(record.candidateIds) || record.candidateIds.length === 0)
      return normalizationFailure(
        'candidateIds must contain at least one candidate',
      );
    const candidateIds: string[] = [];
    for (const rawId of record.candidateIds) {
      if (typeof rawId !== 'string' || rawId.trim() === '')
        return normalizationFailure('candidateIds must contain non-empty ids');
      candidateIds.push(rawId.trim());
    }
    if (new Set(candidateIds).size !== candidateIds.length)
      return normalizationFailure('candidateIds must not contain duplicates');
    return {
      ok: true,
      value: {
        action,
        electionId: electionId.value,
        propertyId: propertyId.value,
        candidateIds,
        castByPersonId: castByPersonId.value,
        proxyId: proxyId.value,
      },
    };
  }

  const motionId = requiredVoteId(record, 'motionId');
  if (!motionId.ok) return motionId;
  const choice = record.choice;
  if (choice !== 'yes' && choice !== 'no' && choice !== 'abstain')
    return normalizationFailure('choice must be yes, no, or abstain');
  return {
    ok: true,
    value: {
      action,
      motionId: motionId.value,
      propertyId: propertyId.value,
      choice,
      castByPersonId: castByPersonId.value,
      proxyId: proxyId.value,
    },
  };
}

function failure(status: VoteErrorStatus, message: string): VoteWriteResult {
  return { ok: false, status, message };
}

function isUniqueViolation(error: unknown): boolean {
  for (
    let current: unknown = error;
    current instanceof Error;
    current = current.cause
  )
    if (/UNIQUE constraint failed/i.test(current.message)) return true;
  return false;
}

function visibilityPredicate(alias: string, role: AuthContext['role']): string {
  if (role === 'board') return '1 = 1';
  if (role === 'homeowner')
    return `${alias}.visibility IN ('public', 'homeowner')`;
  return '0 = 1';
}

async function ownCastingError(
  env: Env,
  ctx: AuthContext,
  propertyId: string,
  personId: string,
): Promise<VoteWriteResult | null> {
  const db = getDb(env);
  // #248 part 2: the named caster is a roster Person, and "may act for this
  // lot" is the shared Lot Authority rule rather than `owners.status`. A live
  // cast happens NOW, so today's Association Day is the exact question here.
  const authority = await fetchLotAuthorityKeys(
    db,
    [propertyId],
    associationDateIso(),
  );
  if (!authority.has(authorityKey(personId, propertyId))) {
    return failure(400, 'castByPersonId must hold authority for this lot');
  }

  // Same definition the /vote read model uses, so the page and the cast
  // path cannot disagree about which lots this caller controls.
  const { ownLots } = await resolveCastingAuthority(db, ctx.userId);
  return ownLots.has(propertyId)
    ? null
    : failure(403, 'Caller is not verified for this lot');
}

async function proxyCastingError(
  env: Env,
  ctx: AuthContext,
  propertyId: string,
  proxyId: string,
  occasion: { meetingId?: string | null; electionId?: string | null },
): Promise<VoteWriteResult | null> {
  const db = getDb(env);
  const scopeError = await proxyUseError(db, [{ propertyId, proxyId }], {
    ...occasion,
    associationDay: associationDateIso(),
  });
  if (scopeError) return failure(scopeError.status, scopeError.message);

  // The caller holds this proxy when its holder Person holds Lot Authority
  // over one of the caller's own verified lots — the same reach the legacy
  // check expressed as "the holder is an active owner of a lot this account is
  // linked to", now asked of the roster. `ownLots` is the snapshot-governed
  // set `/vote` and the cast path share (see casting-authority.ts).
  const holderRows = await db
    .select({ holderPersonId: proxies.holderPersonId })
    .from(proxies)
    .where(eq(proxies.id, proxyId))
    .limit(1);
  const holderPersonId = holderRows[0]?.holderPersonId ?? null;
  if (holderPersonId === null)
    return failure(403, 'Caller does not hold this proxy');
  const { ownLots } = await resolveCastingAuthority(db, ctx.userId);
  const callerLots = [...ownLots];
  const holderAuthority = await fetchLotAuthorityKeys(
    db,
    callerLots,
    associationDateIso(),
  );
  const holds = callerLots.some((lotId) =>
    holderAuthority.has(authorityKey(holderPersonId, lotId)),
  );
  return holds ? null : failure(403, 'Caller does not hold this proxy');
}

async function electionPreflightError(
  env: Env,
  ctx: AuthContext,
  input: CastBallotInput,
): Promise<VoteWriteResult | null> {
  // Casting needs Lot authority — the `member` capability — not rank. Under
  // legacy synthesis this admits exactly {homeowner, board}, same as the old
  // role check; under derived, a board member who owns no Lot is refused here
  // in agreement with requireVotingApi, instead of passing the preflight only
  // to be denied by the casting SQL underneath.
  if (!ctx.capabilities.has('member')) return failure(403, 'Forbidden');
  const db = getDb(env);
  const tiers = visibleTiers(ctx.role);
  const electionRows = await db
    .select({
      id: elections.id,
      meetingId: elections.meetingId,
      seats: elections.seats,
      source: elections.source,
      status: elections.status,
    })
    .from(elections)
    .where(
      and(
        eq(elections.id, input.electionId),
        inArray(elections.visibility, tiers),
      ),
    )
    .limit(1);
  if (electionRows.length !== 1) return failure(404, 'Election not found');
  const election = electionRows[0];

  if (
    input.candidateIds.length === 0 ||
    new Set(input.candidateIds).size !== input.candidateIds.length ||
    input.candidateIds.length > election.seats
  ) {
    return failure(400, 'Candidate selection is invalid for this election');
  }
  const candidateRows = await db
    .select({
      id: candidates.id,
      electionId: candidates.electionId,
      withdrawn: candidates.withdrawn,
    })
    .from(candidates)
    .where(inArray(candidates.id, input.candidateIds));
  if (
    candidateRows.length !== input.candidateIds.length ||
    candidateRows.some(
      (candidate) =>
        candidate.electionId !== election.id || candidate.withdrawn,
    )
  ) {
    return failure(
      400,
      'Candidates must belong to this election and be active',
    );
  }

  const provenanceError =
    input.castByPersonId !== null
      ? await ownCastingError(env, ctx, input.propertyId, input.castByPersonId)
      : await proxyCastingError(env, ctx, input.propertyId, input.proxyId!, {
          electionId: election.id,
          meetingId: election.meetingId,
        });
  if (provenanceError) return provenanceError;

  const eligibilityRows = await db
    .select({ propertyId: electionEligibility.propertyId })
    .from(electionEligibility)
    .where(
      and(
        eq(electionEligibility.electionId, election.id),
        eq(electionEligibility.propertyId, input.propertyId),
      ),
    )
    .limit(1);
  if (eligibilityRows.length !== 1)
    return failure(403, 'This lot is not eligible for the election');

  if (election.source !== 'conducted' || election.status !== 'open')
    return failure(409, 'Election is not open for conducted voting');

  const priorRows = await db
    .select({ id: ballots.id })
    .from(ballots)
    .where(
      and(
        eq(ballots.electionId, election.id),
        eq(ballots.propertyId, input.propertyId),
      ),
    )
    .limit(1);
  return priorRows.length === 0
    ? null
    : failure(409, 'This lot has already cast a ballot');
}

async function motionPreflightError(
  env: Env,
  ctx: AuthContext,
  input: CastMotionVoteInput,
): Promise<VoteWriteResult | null> {
  // Casting needs Lot authority — the `member` capability — not rank. Under
  // legacy synthesis this admits exactly {homeowner, board}, same as the old
  // role check; under derived, a board member who owns no Lot is refused here
  // in agreement with requireVotingApi, instead of passing the preflight only
  // to be denied by the casting SQL underneath.
  if (!ctx.capabilities.has('member')) return failure(403, 'Forbidden');
  const db = getDb(env);
  const tiers = visibleTiers(ctx.role);
  const motionRows = await db
    .select({
      id: motions.id,
      votingState: motions.votingState,
      meetingId: meetings.id,
      meetingBody: meetings.body,
      meetingStatus: meetings.status,
    })
    .from(motions)
    .innerJoin(meetings, eq(motions.meetingId, meetings.id))
    .where(
      and(eq(motions.id, input.motionId), inArray(meetings.visibility, tiers)),
    )
    .limit(1);
  if (motionRows.length !== 1) return failure(404, 'Motion not found');
  const motion = motionRows[0];

  const provenanceError =
    input.castByPersonId !== null
      ? await ownCastingError(env, ctx, input.propertyId, input.castByPersonId)
      : await proxyCastingError(env, ctx, input.propertyId, input.proxyId!, {
          meetingId: motion.meetingId,
        });
  if (provenanceError) return provenanceError;

  const eligibilityRows = await db
    .select({ propertyId: motionEligibility.propertyId })
    .from(motionEligibility)
    .where(
      and(
        eq(motionEligibility.motionId, motion.id),
        eq(motionEligibility.propertyId, input.propertyId),
      ),
    )
    .limit(1);
  if (eligibilityRows.length !== 1)
    return failure(403, 'This lot is not eligible for the motion');

  if (
    motion.votingState !== 'open' ||
    motion.meetingBody !== 'member' ||
    motion.meetingStatus !== 'draft'
  ) {
    return failure(409, 'Motion voting is not open');
  }

  const priorRows = await db
    .select({ id: memberVotes.id })
    .from(memberVotes)
    .where(
      and(
        eq(memberVotes.motionId, motion.id),
        eq(memberVotes.propertyId, input.propertyId),
      ),
    )
    .limit(1);
  return priorRows.length === 0
    ? null
    : failure(409, 'This lot has already voted on the motion');
}

function electionAuthorityPredicate(
  input: CastBallotInput,
  ctx: AuthContext,
  day: string,
): { sql: string; binds: unknown[] } {
  if (input.castByPersonId !== null) {
    const acting = lotAuthorityExists(
      { value: input.castByPersonId },
      { column: 'ee.property_id' },
      day,
    );
    return {
      sql: `${acting.sql}
      AND EXISTS (
        SELECT 1
        FROM user_property_links caller_link
        WHERE caller_link.property_id = ee.property_id
          AND caller_link.user_id = ?
      )`,
      binds: [...acting.binds, ctx.userId],
    };
  }
  // The grantor-currency check is the ADR 0022 phase-3d addition (#220 /
  // #204): a proxy whose grantor no longer holds the lot confers nothing. For
  // a live cast the occasion is NOW, so today's Association Day is exact "held
  // Lot Authority at the occasion" semantics here. Back-entered records use
  // the stored meeting or election day instead.
  //
  // #248 part 2 re-keyed both sides to Persons: the holder reaches the caller
  // through Lot Authority over a lot this account is verified for, which is
  // what "the holder is an active owner of one of your lots" meant before.
  const holder = lotAuthorityExists(
    { column: 'selected_proxy.holder_person_id' },
    { column: 'caller_link.property_id' },
    day,
  );
  const grantor = lotAuthorityExists(
    { column: 'selected_proxy.grantor_person_id' },
    { column: 'selected_proxy.property_id' },
    day,
  );
  return {
    sql: `EXISTS (
      SELECT 1
      FROM proxies selected_proxy
      INNER JOIN user_property_links caller_link
        ON caller_link.user_id = ?
      WHERE selected_proxy.id = ?
        AND selected_proxy.property_id = ee.property_id
        AND (
          selected_proxy.election_id = election.id
          OR (
            election.meeting_id IS NOT NULL
            AND selected_proxy.meeting_id = election.meeting_id
          )
        )
        AND ${holder.sql}
        AND ${grantor.sql}
    )`,
    binds: [ctx.userId, input.proxyId, ...holder.binds, ...grantor.binds],
  };
}

function motionAuthorityPredicate(
  input: CastMotionVoteInput,
  ctx: AuthContext,
  day: string,
): { sql: string; binds: unknown[] } {
  if (input.castByPersonId !== null) {
    const acting = lotAuthorityExists(
      { value: input.castByPersonId },
      { column: 'me.property_id' },
      day,
    );
    return {
      sql: `${acting.sql}
      AND EXISTS (
        SELECT 1
        FROM user_property_links caller_link
        WHERE caller_link.property_id = me.property_id
          AND caller_link.user_id = ?
      )`,
      binds: [...acting.binds, ctx.userId],
    };
  }
  // Same phase-3d grantor-currency re-check as the election predicate above;
  // an open motion's cast happens now, so today's day is exact.
  const holder = lotAuthorityExists(
    { column: 'selected_proxy.holder_person_id' },
    { column: 'caller_link.property_id' },
    day,
  );
  const grantor = lotAuthorityExists(
    { column: 'selected_proxy.grantor_person_id' },
    { column: 'selected_proxy.property_id' },
    day,
  );
  return {
    sql: `EXISTS (
      SELECT 1
      FROM proxies selected_proxy
      INNER JOIN user_property_links caller_link
        ON caller_link.user_id = ?
      WHERE selected_proxy.id = ?
        AND selected_proxy.property_id = me.property_id
        AND selected_proxy.meeting_id = meeting.id
        AND ${holder.sql}
        AND ${grantor.sql}
    )`,
    binds: [ctx.userId, input.proxyId, ...holder.binds, ...grantor.binds],
  };
}

export async function castElectionBallot(
  env: Env,
  ctx: AuthContext,
  input: CastBallotInput,
): Promise<VoteWriteResult> {
  const preflightError = await electionPreflightError(env, ctx, input);
  if (preflightError) return preflightError;

  const ballotId = crypto.randomUUID();
  const recordedAt = Math.floor(Date.now() / 1000);
  const authority = electionAuthorityPredicate(
    input,
    ctx,
    associationDateIso(),
  );
  const candidatePlaceholders = input.candidateIds.map(() => '?').join(', ');
  const turnout = env.DATABASE.prepare(
    `INSERT INTO ballots (
       id, election_id, property_id, weight,
       cast_by_person_id, proxy_id, recorded_at
     )
     SELECT ?, election.id, ee.property_id, ee.weight, ?, ?, ?
     FROM elections election
     INNER JOIN election_eligibility ee
       ON ee.election_id = election.id
      AND ee.property_id = ?
     WHERE election.id = ?
       AND election.source = 'conducted'
       AND election.status = 'open'
       AND ${visibilityPredicate('election', ctx.role)}
       AND ${LIVE_VOTING_ENABLED_SQL}
       AND ? <= election.seats
       AND (
         SELECT COUNT(DISTINCT candidate.id)
         FROM candidates candidate
         WHERE candidate.id IN (${candidatePlaceholders})
           AND candidate.election_id = election.id
           AND candidate.withdrawn = 0
       ) = ?
       AND ${authority.sql}
       AND NOT EXISTS (
         SELECT 1 FROM ballots prior_ballot
         WHERE prior_ballot.election_id = election.id
           AND prior_ballot.property_id = ee.property_id
       )`,
  ).bind(
    ballotId,
    input.castByPersonId,
    input.proxyId,
    recordedAt,
    input.propertyId,
    input.electionId,
    input.candidateIds.length,
    ...input.candidateIds,
    input.candidateIds.length,
    ...authority.binds,
  );
  const choiceStatements = input.candidateIds.map((candidateId) =>
    env.DATABASE.prepare(
      `INSERT INTO ballot_choices (id, election_id, candidate_id, weight)
       SELECT ?, ?, ?, ee.weight
       FROM election_eligibility ee
       WHERE ee.election_id = ?
         AND ee.property_id = ?
         AND EXISTS (SELECT 1 FROM ballots WHERE id = ?)`,
    ).bind(
      crypto.randomUUID(),
      input.electionId,
      candidateId,
      input.electionId,
      input.propertyId,
      ballotId,
    ),
  );

  try {
    const [turnoutResult, ...choiceResults] = await env.DATABASE.batch([
      turnout,
      ...choiceStatements,
    ]);
    if (
      turnoutResult.meta.changes !== 1 ||
      choiceResults.some((result) => result.meta.changes !== 1)
    ) {
      return failure(
        409,
        'Ballot was not recorded because voting changed or this lot already cast',
      );
    }
    return { ok: true };
  } catch (error) {
    if (isUniqueViolation(error))
      return failure(409, 'This lot has already cast a ballot');
    throw error;
  }
}

export async function castMotionVote(
  env: Env,
  ctx: AuthContext,
  input: CastMotionVoteInput,
): Promise<VoteWriteResult> {
  const preflightError = await motionPreflightError(env, ctx, input);
  if (preflightError) return preflightError;

  const authority = motionAuthorityPredicate(input, ctx, associationDateIso());
  const statement = env.DATABASE.prepare(
    `INSERT INTO member_votes (
       id, motion_id, property_id, cast_by_person_id, weight, choice, proxy_id
     )
     SELECT ?, motion.id, me.property_id, ?, me.weight, ?, ?
     FROM motions motion
     INNER JOIN meetings meeting ON meeting.id = motion.meeting_id
     INNER JOIN motion_eligibility me
       ON me.motion_id = motion.id
      AND me.property_id = ?
     WHERE motion.id = ?
       AND motion.voting_state = 'open'
       AND meeting.body = 'member'
       AND meeting.status = 'draft'
       AND ${visibilityPredicate('meeting', ctx.role)}
       AND ${LIVE_VOTING_ENABLED_SQL}
       AND ${authority.sql}
       AND NOT EXISTS (
         SELECT 1 FROM member_votes prior_vote
         WHERE prior_vote.motion_id = motion.id
           AND prior_vote.property_id = me.property_id
       )`,
  ).bind(
    crypto.randomUUID(),
    input.castByPersonId,
    input.choice,
    input.proxyId,
    input.propertyId,
    input.motionId,
    ...authority.binds,
  );

  try {
    const [result] = await env.DATABASE.batch([statement]);
    return result.meta.changes === 1
      ? { ok: true }
      : failure(
          409,
          'Vote was not recorded because voting changed or this lot already voted',
        );
  } catch (error) {
    if (isUniqueViolation(error))
      return failure(409, 'This lot has already voted on the motion');
    throw error;
  }
}
