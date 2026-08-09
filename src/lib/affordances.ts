import type { CandidateSummary, ElectionDetail } from './types';

/**
 * What the board may do to an election, derived from the read model.
 *
 * These rules previously lived as a single `editable` const declared inside a
 * `.map()` in ElectionsManager, gating six unrelated controls. That is how the
 * add-candidate form came to be offered on a closed recorded election, which
 * `POST /api/admin/candidates` refuses with a 409 — the sibling Remove button
 * fifteen lines away had the rule right.
 *
 * Each flag mirrors one server guard, named here so the two can be compared:
 *
 * | flag | server |
 * | --- | --- |
 * | `canEditElection` | `elections.ts` PATCH |
 * | `canAddCandidate` / `canRemoveCandidate` | `candidates.ts` POST / DELETE |
 * | `canEditCandidate` | `candidates.ts` PATCH |
 * | `canEditTallies` / `canEditBallots` | `elections.ts` setTallies / setBallots |
 * | `canCertify` / `canUncertify` / `canVoid` / `canDelete` | the matching actions |
 *
 * This is an affordance projection, not an authorization decision: the server
 * re-checks every one of these. Its job is to stop offering controls that are
 * guaranteed to fail.
 */
export interface ElectionAffordances {
  canEditElection: boolean;
  canAddCandidate: boolean;
  canEditCandidate: boolean;
  canRemoveCandidate: boolean;
  canEditTallies: boolean;
  canEditBallots: boolean;
  canCertify: boolean;
  canUncertify: boolean;
  canVoid: boolean;
  canDelete: boolean;
}

export function electionAffordances(
  election: Pick<ElectionDetail, 'status' | 'source'>,
): ElectionAffordances {
  const { status, source } = election;
  const terminal = status === 'certified' || status === 'void';
  const isDraft = status === 'draft';
  const recorded = source === 'recorded';
  // A conducted election's configuration is frozen the moment it first opens;
  // a recorded one stays editable until it is certified or voided.
  const configurable = recorded ? !terminal : isDraft;

  return {
    canEditElection: configurable,
    // Draft-only, both sources. NOT `configurable`: once an election is
    // closed its candidate list is part of the record.
    canAddCandidate: isDraft,
    canRemoveCandidate: isDraft,
    canEditCandidate: configurable,
    // Typed tallies and ballot registers exist only for recorded elections —
    // a conducted election derives both from real votes.
    canEditTallies: recorded && !terminal,
    canEditBallots: recorded && !terminal,
    canCertify: status === 'closed',
    canUncertify: status === 'certified',
    canVoid: status === 'closed',
    canDelete: isDraft,
  };
}

/**
 * Withdrawal is the one candidate change a conducted election allows after
 * opening, and it is one-way: a candidate already withdrawn cannot be
 * reinstated while voting is open, because the ballots cast since would have
 * been shown a different slate.
 */
export function canWithdrawCandidate(
  election: Pick<ElectionDetail, 'status' | 'source'>,
  candidate: Pick<CandidateSummary, 'withdrawn'>,
): boolean {
  if (election.source === 'conducted' && election.status === 'open')
    return !candidate.withdrawn;
  return electionAffordances(election).canEditCandidate;
}
