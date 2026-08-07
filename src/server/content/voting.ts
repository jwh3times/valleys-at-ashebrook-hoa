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
  owners,
  proxies,
  userPropertyLinks,
} from '../db/schema';
import { proxyUseError } from './proxy-guards';
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
  key: 'castByOwnerId' | 'proxyId',
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
  const castByOwnerId = voteProvenanceId(record, 'castByOwnerId');
  if (!castByOwnerId.ok) return castByOwnerId;
  const proxyId = voteProvenanceId(record, 'proxyId');
  if (!proxyId.ok) return proxyId;
  if ((castByOwnerId.value === null) === (proxyId.value === null))
    return normalizationFailure(
      'Exactly one of castByOwnerId or proxyId is required',
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
        castByOwnerId: castByOwnerId.value,
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
      castByOwnerId: castByOwnerId.value,
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
  ownerId: string,
): Promise<VoteWriteResult | null> {
  const db = getDb(env);
  const ownerRows = await db
    .select({ propertyId: owners.propertyId, status: owners.status })
    .from(owners)
    .where(eq(owners.id, ownerId))
    .limit(1);
  if (
    ownerRows.length !== 1 ||
    ownerRows[0].propertyId !== propertyId ||
    ownerRows[0].status !== 'active'
  ) {
    return failure(400, 'castByOwnerId must be an active owner of this lot');
  }

  const linkRows = await db
    .select({ id: userPropertyLinks.id })
    .from(userPropertyLinks)
    .where(
      and(
        eq(userPropertyLinks.userId, ctx.userId),
        eq(userPropertyLinks.propertyId, propertyId),
      ),
    )
    .limit(1);
  return linkRows.length === 1
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
  const scopeError = await proxyUseError(
    db,
    [{ propertyId, proxyId }],
    occasion,
  );
  if (scopeError) return failure(scopeError.status, scopeError.message);

  const holderRows = await db
    .select({ id: proxies.id })
    .from(proxies)
    .innerJoin(owners, eq(proxies.holderOwnerId, owners.id))
    .innerJoin(
      userPropertyLinks,
      eq(userPropertyLinks.propertyId, owners.propertyId),
    )
    .where(
      and(
        eq(proxies.id, proxyId),
        eq(owners.status, 'active'),
        eq(userPropertyLinks.userId, ctx.userId),
      ),
    )
    .limit(1);
  return holderRows.length === 1
    ? null
    : failure(403, 'Caller does not hold this proxy');
}

async function electionPreflightError(
  env: Env,
  ctx: AuthContext,
  input: CastBallotInput,
): Promise<VoteWriteResult | null> {
  if (ctx.role !== 'homeowner' && ctx.role !== 'board')
    return failure(403, 'Forbidden');
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
    input.castByOwnerId !== null
      ? await ownCastingError(env, ctx, input.propertyId, input.castByOwnerId)
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
  if (ctx.role !== 'homeowner' && ctx.role !== 'board')
    return failure(403, 'Forbidden');
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
    input.castByOwnerId !== null
      ? await ownCastingError(env, ctx, input.propertyId, input.castByOwnerId)
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
): { sql: string; binds: unknown[] } {
  if (input.castByOwnerId !== null) {
    return {
      sql: `EXISTS (
        SELECT 1
        FROM owners acting_owner
        INNER JOIN user_property_links caller_link
          ON caller_link.property_id = acting_owner.property_id
        WHERE acting_owner.id = ?
          AND acting_owner.property_id = ee.property_id
          AND acting_owner.status = 'active'
          AND caller_link.user_id = ?
      )`,
      binds: [input.castByOwnerId, ctx.userId],
    };
  }
  return {
    sql: `EXISTS (
      SELECT 1
      FROM proxies selected_proxy
      INNER JOIN owners holder_owner
        ON holder_owner.id = selected_proxy.holder_owner_id
      INNER JOIN user_property_links caller_link
        ON caller_link.property_id = holder_owner.property_id
      WHERE selected_proxy.id = ?
        AND selected_proxy.property_id = ee.property_id
        AND (
          selected_proxy.election_id = election.id
          OR (
            election.meeting_id IS NOT NULL
            AND selected_proxy.meeting_id = election.meeting_id
          )
        )
        AND holder_owner.status = 'active'
        AND caller_link.user_id = ?
    )`,
    binds: [input.proxyId, ctx.userId],
  };
}

function motionAuthorityPredicate(
  input: CastMotionVoteInput,
  ctx: AuthContext,
): { sql: string; binds: unknown[] } {
  if (input.castByOwnerId !== null) {
    return {
      sql: `EXISTS (
        SELECT 1
        FROM owners acting_owner
        INNER JOIN user_property_links caller_link
          ON caller_link.property_id = acting_owner.property_id
        WHERE acting_owner.id = ?
          AND acting_owner.property_id = me.property_id
          AND acting_owner.status = 'active'
          AND caller_link.user_id = ?
      )`,
      binds: [input.castByOwnerId, ctx.userId],
    };
  }
  return {
    sql: `EXISTS (
      SELECT 1
      FROM proxies selected_proxy
      INNER JOIN owners holder_owner
        ON holder_owner.id = selected_proxy.holder_owner_id
      INNER JOIN user_property_links caller_link
        ON caller_link.property_id = holder_owner.property_id
      WHERE selected_proxy.id = ?
        AND selected_proxy.property_id = me.property_id
        AND selected_proxy.meeting_id = meeting.id
        AND holder_owner.status = 'active'
        AND caller_link.user_id = ?
    )`,
    binds: [input.proxyId, ctx.userId],
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
  const authority = electionAuthorityPredicate(input, ctx);
  const candidatePlaceholders = input.candidateIds.map(() => '?').join(', ');
  const turnout = env.DATABASE.prepare(
    `INSERT INTO ballots (
       id, election_id, property_id, weight,
       cast_by_owner_id, proxy_id, recorded_at
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
    input.castByOwnerId,
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

  const authority = motionAuthorityPredicate(input, ctx);
  const statement = env.DATABASE.prepare(
    `INSERT INTO member_votes (
       id, motion_id, property_id, cast_by_owner_id, weight, choice, proxy_id
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
    input.castByOwnerId,
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
