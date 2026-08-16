// Transfer-time effects: the mutation-boundary engine for what an Ownership or
// Representation change does to the voting, proxy, and meeting record
// (#204's resolution, built in 3d #218's successor #220).
//
// The governing sentence, from #204: a transfer changes **who may act for a
// Lot, never whether the Lot counts**. Nothing here writes an eligibility
// snapshot, a weight, a turnout row, or a quorum denominator. Exactly one
// stored action is reversed — an open member-motion vote, which #204 licenses
// through the Lot Authority glossary's already-settled carve-out for actions
// that "remain revocable or correctable under their own rules". Everything
// else the transfer disturbs is surfaced as a Review Flag for one human look
// and left standing.
//
// BALLOT SECRECY. Nothing in this module reads, joins, names, or counts
// `ballot_choices` or candidate selection. Flags for a conducted election
// reference the identity-linked turnout `ballots` row and the election
// occasion, and stop there. Impact discovery is exactly the feature that would
// find joining choices to owners convenient; it does not.
//
// SHAPE. This mirrors `board-consequences.ts`: a builder taking the command's
// clock, window, lots, root guard, and correlation, doing its enumeration as
// PRE-BATCH reads and returning statements whose preconditions are re-checked
// in their own WHERE. A lost race leaves ZERO rows anywhere. One known sliver:
// an action committed between the pre-batch enumeration and the batch itself
// is neither reset nor flagged by THIS command — it was valid when made
// (uncached derivation re-checked its authority), it simply lands unflagged.
// #204 accepts both commit orders as legal histories; the miss here is a flag,
// never an authority decision, and the board's correction remedies cover it.
//
// BATCH POSITION. Two statement lists come back, because review flags
// FK-reference the audit event that opened them:
//
//   [primary, ...lossConsequences.statements, ...effects.statements,
//    ...correlation.statements, ...effects.flagStatements, ...asserts]
//
// `statements` are domain writes (the vote reset's revision advance and
// delete; a void's flag supersession UPDATEs) and run BEFORE the ledger, so
// each caused event's guard can prove its domain write landed.
// `flagStatements` are the flag INSERTs and run AFTER it, so their
// `source_event_id` and opening-event guards reference rows that exist.
//
// ONE FLAG PER RECORD. #204: "A flag is for a discrete past event a human
// should look at once." When two passes would reach the same record, the
// forward-looking (still-actionable) category wins and the retrospective one
// is not opened: the forward pass is enumerated FIRST and its record ids are
// what the retrospective passes skip.

import { AuditCorrelation, andGuards, type SqlGuard } from './audit';

export type FlagCategory =
  | 'intervening_action_backdated'
  | 'authority_lost_pending_occasion'
  | 'vote_reset_on_transfer'
  | 'ballot_final_after_transfer';

type ImpactKind =
  'motion' | 'member_attendance' | 'member_vote' | 'ballot' | 'proxy' | 'event';

// Interpolated into SQL, so both maps are the typed allow-list — a cast at a
// call site must not become an injection (the `audit.ts` subject-column rule).
const IMPACT_COLUMN: Record<ImpactKind, string> = {
  motion: 'impacted_motion_id',
  member_attendance: 'impacted_member_attendance_id',
  member_vote: 'impacted_member_vote_id',
  ballot: 'impacted_ballot_id',
  proxy: 'impacted_proxy_id',
  event: 'impacted_event_id',
};

const IMPACT_TABLE: Record<ImpactKind, string> = {
  motion: 'motions',
  member_attendance: 'member_attendance',
  member_vote: 'member_votes',
  ballot: 'ballots',
  proxy: 'proxies',
  event: 'audit_events',
};

/** Elections whose occasion has concluded; anything else is still upcoming. */
const TERMINAL_ELECTION_STATUSES = "('closed', 'certified', 'void')";

// ---------------------------------------------------------------------------
// Association-day instants
// ---------------------------------------------------------------------------

const ASSOCIATION_TIME_ZONE = 'America/New_York';

function etOffsetMs(instantMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ASSOCIATION_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(instantMs));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asIfUtc = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    // Some ICU builds render midnight as hour 24 under hour12: false.
    part('hour') % 24,
    part('minute'),
    part('second'),
  );
  return asIfUtc - instantMs;
}

/**
 * The UTC instant at which `day` (YYYY-MM-DD) begins in the association's
 * timezone. SQL cannot do that arithmetic, so the recorded-instant window
 * bounds for `ballots` and `proxies` are computed here and bound as numbers.
 * Two passes settle the DST-transition days.
 */
export function associationStartOfDayMs(day: string): number {
  const naive = Date.UTC(
    Number(day.slice(0, 4)),
    Number(day.slice(5, 7)) - 1,
    Number(day.slice(8, 10)),
  );
  const firstPass = naive - etOffsetMs(naive);
  return naive - etOffsetMs(firstPass);
}

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

export interface TransferEffectsInput {
  database: D1Database;
  nowMs: number;
  /** Today, in the association's timezone. The forward pass's "upcoming". */
  associationDay: string;
  /** The real-world day authority ended — the start of the discovery window,
   * possibly backdated well before `associationDay`. */
  effectiveDay: string;
  /** Lots whose authority the command may have removed. */
  lots: string[];
  /** The command's success marker: nothing lands unless the primary did. */
  rootGuard: SqlGuard;
  correlation: AuditCorrelation;
  /** `automatic_cause` label for the caused review events. */
  cause: string;
  /**
   * Ownership `end` ONLY. A void is not a transfer and a Representation
   * change is not one either, so neither resets a vote (#220's trigger
   * matrix).
   */
  resetOpenMotionVotes?: boolean;
  /** From `lossConsequences`: the Board Terms this command affected. Their
   * Persons' linked accounts are what the account-keyed ledger pass searches. */
  affectedTermIds?: string[];
  /** Void only: open flags whose source event cites this roster row resolve
   * as `superseded` (never deleted, never reversed — #204). */
  supersedes?: { column: 'ownership_id' | 'representation_id'; id: string };
}

export interface TransferEffects {
  /** Domain statements. Run after the primary and `lossConsequences`, BEFORE
   * `correlation.statements`. */
  statements: D1PreparedStatement[];
  /** Review-flag INSERTs. Run AFTER `correlation.statements`. */
  flagStatements: D1PreparedStatement[];
  /** Motions whose member vote for a transferred Lot the reset deleted (the
   * pre-batch enumeration, before the in-batch re-check). */
  resetMotionIds: string[];
  /** Open flags this command's supersession pass targeted. */
  supersededFlagIds: string[];
  /** Flags this command will open if every guard holds. */
  openedFlagCount: number;
}

interface ResetGroup {
  motionId: string;
  votingRevision: number;
  votes: { id: string; choice: string; weight: number }[];
}

const EMPTY: TransferEffects = {
  statements: [],
  flagStatements: [],
  resetMotionIds: [],
  supersededFlagIds: [],
  openedFlagCount: 0,
};

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export async function transferEffects(
  input: TransferEffectsInput,
): Promise<TransferEffects> {
  const sourceEventId = input.correlation.rootEventId;
  // The root must already be registered: the flag's `source_event_id` IS the
  // command's initiating event. Every caller registers it first.
  if (sourceEventId === null) return EMPTY;

  const lots = [...new Set(input.lots)];
  const statements: D1PreparedStatement[] = [];
  const flagStatements: D1PreparedStatement[] = [];
  let openedFlagCount = 0;

  /** Registers one `review_flag_opened` event and its gated, idempotent flag
   * INSERT. The insert is conditional on the root guard, its own opening
   * event, the impacted row still existing (the FK is RESTRICT), and no flag
   * already carrying this (source event, category, record) triple. */
  const openFlag = (
    category: FlagCategory,
    kind: ImpactKind,
    recordId: string,
    extra?: {
      guard?: SqlGuard;
      scalars?: {
        fieldKey: string;
        valueType: 'text' | 'integer';
        old: string | number | null;
      }[];
    },
  ): void => {
    const flagId = crypto.randomUUID();
    const column = IMPACT_COLUMN[kind];
    const table = IMPACT_TABLE[kind];
    const stillThere: SqlGuard = {
      sql: `EXISTS (SELECT 1 FROM ${table} WHERE id = ?)`,
      binds: [recordId],
    };
    const eventGuard = extra?.guard
      ? andGuards(extra.guard, stillThere)
      : stillThere;
    const eventId = input.correlation.event({
      kind: 'review_flag_opened',
      guard: eventGuard,
      actor: { kind: 'automatic', cause: input.cause },
      detail: { family: 'review', reviewFlagId: flagId },
      scalars: extra?.scalars?.map((s) => ({
        fieldKey: s.fieldKey,
        valueType: s.valueType,
        old: s.old,
        new: null,
      })),
    });
    const insertGuard = andGuards(input.rootGuard, {
      sql: 'EXISTS (SELECT 1 FROM audit_events WHERE id = ?)',
      binds: [eventId],
    });
    flagStatements.push(
      input.database
        .prepare(
          `INSERT INTO review_flags (id, category, source_event_id, status, opened_at, ${column})
           SELECT ?, ?, ?, 'open', ?, ?
           WHERE ${insertGuard.sql}
             AND ${stillThere.sql}
             AND NOT EXISTS (
               SELECT 1 FROM review_flags
               WHERE source_event_id = ? AND category = ? AND ${column} = ?
             )`,
        )
        .bind(
          flagId,
          category,
          sourceEventId,
          input.nowMs,
          recordId,
          ...insertGuard.binds,
          ...stillThere.binds,
          sourceEventId,
          category,
          recordId,
        ),
    );
    openedFlagCount += 1;
  };

  // -- 1. Vote reset -------------------------------------------------------
  //
  // An open member motion is still a live question, so the Lot's departing
  // member no longer decides it. The row is DELETED and the motion's
  // `voting_revision` advanced, which is the compare-and-swap invalidation
  // `setMemberVotes` and the live cast path already require. A closed motion
  // is never touched: a recorded outcome must not change under its minutes.
  // The reset is indifferent to officialMode/liveVotingEnabled — an open
  // motion is open even while casting is paused.
  const resetMotionIds: string[] = [];
  const resetVoteIds = new Set<string>();
  if (input.resetOpenMotionVotes === true && lots.length > 0) {
    const rows = await input.database
      .prepare(
        `SELECT mv.id AS vote_id, mv.choice, mv.weight, m.id AS motion_id, m.voting_revision
         FROM member_votes mv
         JOIN motions m ON m.id = mv.motion_id
         JOIN meetings mt ON mt.id = m.meeting_id
         WHERE mv.property_id IN (${placeholders(lots)})
           AND m.voting_state = 'open'
           AND mt.body = 'member'
         ORDER BY m.id`,
      )
      .bind(...lots)
      .all<{
        vote_id: string;
        choice: string;
        weight: number;
        motion_id: string;
        voting_revision: number;
      }>();

    const groups = new Map<string, ResetGroup>();
    for (const row of rows.results) {
      const group = groups.get(row.motion_id) ?? {
        motionId: row.motion_id,
        votingRevision: row.voting_revision,
        votes: [],
      };
      group.votes.push({
        id: row.vote_id,
        choice: row.choice,
        weight: row.weight,
      });
      groups.set(row.motion_id, group);
    }

    // `motions` is a legacy table: SECONDS.
    const motionStamp = Math.floor(input.nowMs / 1000);
    for (const group of groups.values()) {
      const voteIds = group.votes.map((v) => v.id);
      for (const id of voteIds) resetVoteIds.add(id);
      resetMotionIds.push(group.motionId);

      const advanceGuard = andGuards(input.rootGuard, {
        sql: `EXISTS (SELECT 1 FROM member_votes WHERE id IN (${placeholders(voteIds)}))`,
        binds: voteIds,
      });
      // Advance BEFORE delete: the delete is what proves the advance landed,
      // and the revision must never move on a motion that lost no vote.
      statements.push(
        input.database
          .prepare(
            `UPDATE motions SET voting_revision = voting_revision + 1, updated_at = ?
             WHERE id = ? AND voting_state = 'open' AND voting_revision = ?
               AND ${advanceGuard.sql}`,
          )
          .bind(
            motionStamp,
            group.motionId,
            group.votingRevision,
            ...advanceGuard.binds,
          ),
      );
      // `voting_state = 'open'` is load-bearing, not belt-and-braces: the
      // stamp is SECONDS, so a concurrent closeVoting committing in the same
      // wall-clock second also stamps `updated_at` and advances the revision.
      // Without the state term, that close would satisfy this marker while
      // our advance no-oped — and the delete would strip votes from a CLOSED
      // motion. Our own advance never changes the state, so requiring 'open'
      // distinguishes the two writers.
      const advanced: SqlGuard = {
        sql: "EXISTS (SELECT 1 FROM motions WHERE id = ? AND updated_at = ? AND voting_revision = ? AND voting_state = 'open')",
        binds: [group.motionId, motionStamp, group.votingRevision + 1],
      };
      statements.push(
        input.database
          .prepare(
            `DELETE FROM member_votes
             WHERE id IN (${placeholders(voteIds)}) AND ${advanced.sql}`,
          )
          .bind(...voteIds, ...advanced.binds),
      );

      // The flag names the MOTION: the member_votes row it would otherwise
      // reference no longer exists. The deleted fact survives in the ledger
      // as scalar deltas — member-motion votes are attributable and
      // board-correctable by design, so no secrecy rule is touched here.
      const gone: SqlGuard = {
        sql: `NOT EXISTS (SELECT 1 FROM member_votes WHERE id IN (${placeholders(voteIds)}))`,
        binds: voteIds,
      };
      openFlag('vote_reset_on_transfer', 'motion', group.motionId, {
        guard: andGuards(advanced, gone),
        scalars: group.votes.flatMap((v) => [
          { fieldKey: 'choice', valueType: 'text' as const, old: v.choice },
          { fieldKey: 'weight', valueType: 'integer' as const, old: v.weight },
        ]),
      });
    }
  }

  if (lots.length > 0) {
    const lotList = placeholders(lots);
    const windowStartMs = associationStartOfDayMs(input.effectiveDay);
    // `ballots` and `proxies` are legacy tables: SECONDS.
    const windowStartSeconds = Math.floor(windowStartMs / 1000);
    const nowSeconds = Math.floor(input.nowMs / 1000);

    // -- 3. Forward pass (enumerated first: it owns any record both passes
    //       reach, because a still-upcoming occasion is the actionable half) --
    const pendingProxies = await input.database
      .prepare(
        `SELECT p.id FROM proxies p
         LEFT JOIN meetings mt ON mt.id = p.meeting_id
         LEFT JOIN elections e ON e.id = p.election_id
         WHERE p.property_id IN (${lotList})
           AND (
             (p.meeting_id IS NOT NULL AND mt.date >= ?)
             OR (p.election_id IS NOT NULL AND e.status NOT IN ${TERMINAL_ELECTION_STATUSES})
           )`,
      )
      .bind(...lots, input.associationDay)
      .all<{ id: string }>();
    const pendingProxyIds = new Set(pendingProxies.results.map((r) => r.id));
    for (const id of pendingProxyIds)
      openFlag('authority_lost_pending_occasion', 'proxy', id);

    // A conducted Ballot on an election that has not concluded is the one
    // thing a transfer cannot fix: the Lot has voted, the buyer cannot, and
    // ballot finality forbids a correction path. The flag reaches the turnout
    // row and the occasion, never a choice. CONDUCTED only — a recorded
    // election's board-entered ballot rows are freely replaceable through
    // setBallots, so "final" would be the wrong claim; if one falls in the
    // window it is flagged as backdated activity below instead.
    const pendingBallots = await input.database
      .prepare(
        `SELECT b.id FROM ballots b
         JOIN elections e ON e.id = b.election_id
         WHERE b.property_id IN (${lotList})
           AND e.source = 'conducted'
           AND e.status NOT IN ${TERMINAL_ELECTION_STATUSES}`,
      )
      .bind(...lots)
      .all<{ id: string }>();
    const pendingBallotIds = new Set(pendingBallots.results.map((r) => r.id));
    for (const id of pendingBallotIds)
      openFlag('ballot_final_after_transfer', 'ballot', id);

    // -- 2. Retrospective discovery over [Effective Day, Recorded At] --------
    //
    // A backdated transfer hides whatever the departing party did in the gap.
    // Per-table window rules differ deliberately: attendance and member votes
    // are routinely back-entered, so their OCCASION DAY is the honest
    // question; ballots and proxies carry a real recorded instant.
    const attendance = await input.database
      .prepare(
        `SELECT ma.id FROM member_attendance ma
         JOIN meetings mt ON mt.id = ma.meeting_id
         WHERE ma.property_id IN (${lotList}) AND mt.date >= ? AND mt.date <= ?`,
      )
      .bind(...lots, input.effectiveDay, input.associationDay)
      .all<{ id: string }>();
    for (const row of attendance.results)
      openFlag('intervening_action_backdated', 'member_attendance', row.id);

    const surviving = await input.database
      .prepare(
        `SELECT mv.id FROM member_votes mv
         JOIN motions m ON m.id = mv.motion_id
         JOIN meetings mt ON mt.id = m.meeting_id
         WHERE mv.property_id IN (${lotList}) AND mt.date >= ? AND mt.date <= ?`,
      )
      .bind(...lots, input.effectiveDay, input.associationDay)
      .all<{ id: string }>();
    for (const row of surviving.results) {
      // Rows this command is deleting are not surviving actions; the reset
      // opened their motion-scoped flag already.
      if (resetVoteIds.has(row.id)) continue;
      openFlag('intervening_action_backdated', 'member_vote', row.id);
    }

    const ballots = await input.database
      .prepare(
        `SELECT b.id FROM ballots b
         JOIN elections e ON e.id = b.election_id
         WHERE b.property_id IN (${lotList})
           AND b.recorded_at >= ? AND b.recorded_at <= ?`,
      )
      .bind(...lots, windowStartSeconds, nowSeconds)
      .all<{ id: string }>();
    for (const row of ballots.results) {
      if (pendingBallotIds.has(row.id)) continue;
      openFlag('intervening_action_backdated', 'ballot', row.id);
    }

    const granted = await input.database
      .prepare(
        `SELECT p.id FROM proxies p
         WHERE p.property_id IN (${lotList})
           AND p.created_at >= ? AND p.created_at <= ?`,
      )
      .bind(...lots, windowStartSeconds, nowSeconds)
      .all<{ id: string }>();
    for (const row of granted.results) {
      if (pendingProxyIds.has(row.id)) continue;
      openFlag('intervening_action_backdated', 'proxy', row.id);
    }

    // Account-keyed ledger acts. Only reachable when the command also cost
    // somebody a Board Term: a departing board member's window activity —
    // manual verifications approved, Roster Changes and Representations
    // accepted — is the second half of #204's ONE shared enumeration.
    // Resolution runs Person -> current Person Link -> account, and skips
    // SILENTLY when no link exists (most roster Persons have no account).
    const termIds = input.affectedTermIds ?? [];
    if (termIds.length > 0) {
      const accounts = await input.database
        .prepare(
          `SELECT DISTINCT pl.account_id
           FROM board_service_terms t
           JOIN person_links pl ON pl.person_id = t.person_id AND pl.ended_at IS NULL
           WHERE t.id IN (${placeholders(termIds)})`,
        )
        .bind(...termIds)
        .all<{ account_id: string }>();
      const accountIds = accounts.results.map((r) => r.account_id);
      if (accountIds.length > 0) {
        // Families pinned to #204's shared enumeration — Roster Changes and
        // Representations accepted (`roster_change`) and Manual Person
        // Verifications approved (`identity`). Without the filter, every
        // access event and review resolution the account ever touched in the
        // window would be flagged too, which is broader than the list the
        // spec fixes.
        const acts = await input.database
          .prepare(
            `SELECT id FROM audit_events
             WHERE actor_account_id IN (${placeholders(accountIds)})
               AND family IN ('roster_change', 'identity')
               AND recorded_at >= ? AND recorded_at <= ?`,
          )
          .bind(...accountIds, windowStartMs, input.nowMs)
          .all<{ id: string }>();
        for (const row of acts.results)
          openFlag('intervening_action_backdated', 'event', row.id);
      }
    }
  }

  // -- 4. Supersede-on-void ------------------------------------------------
  //
  // #204: a voided transfer recomputes derived access and reverses NOTHING
  // stored — the ended Term stays ended, the ended grant stays ended, the
  // reset vote stays deleted. Its flags resolve as `superseded` rather than
  // being deleted, so the erroneous roster edit stays visible.
  const supersededFlagIds: string[] = [];
  if (input.supersedes) {
    const column =
      input.supersedes.column === 'ownership_id'
        ? 'ownership_id'
        : 'representation_id';
    const open = await input.database
      .prepare(
        `SELECT f.id FROM review_flags f
         WHERE f.status = 'open'
           AND EXISTS (
             SELECT 1 FROM roster_change_subjects s
             WHERE s.event_id = f.source_event_id AND s.${column} = ?
           )`,
      )
      .bind(input.supersedes.id)
      .all<{ id: string }>();
    for (const row of open.results) {
      supersededFlagIds.push(row.id);
      // An UPDATE of an existing row, so it is a DOMAIN statement: it runs
      // before the ledger, which lets the caused event prove the flip landed.
      statements.push(
        input.database
          .prepare(
            `UPDATE review_flags
             SET status = 'resolved', resolution_code = 'superseded', resolved_at = ?
             WHERE id = ? AND status = 'open' AND (${input.rootGuard.sql})`,
          )
          .bind(input.nowMs, row.id, ...input.rootGuard.binds),
      );
      input.correlation.event({
        kind: 'review_flag_superseded',
        guard: {
          sql: `EXISTS (SELECT 1 FROM review_flags WHERE id = ? AND resolved_at = ? AND resolution_code = 'superseded')`,
          binds: [row.id, input.nowMs],
        },
        actor: { kind: 'automatic', cause: input.cause },
        detail: {
          family: 'review',
          reviewFlagId: row.id,
          resolutionCode: 'superseded',
        },
      });
    }
  }

  return {
    statements,
    flagStatements,
    resetMotionIds,
    supersededFlagIds,
    openedFlagCount,
  };
}
