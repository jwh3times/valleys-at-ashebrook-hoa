import { describe, it, expect } from 'vitest';
import {
  electionAffordances,
  canWithdrawCandidate,
} from '../../src/lib/affordances';
import type { ElectionSource, ElectionStatus } from '../../src/lib/types';

const at = (status: ElectionStatus, source: ElectionSource) =>
  electionAffordances({ status, source });

describe('electionAffordances', () => {
  it('does NOT offer add-candidate on a closed recorded election', () => {
    // The regression this module exists for. The old in-render `editable`
    // const was true here, so the board got a working-looking add form that
    // POST /api/admin/candidates refuses with 409 (candidates.ts:77-83).
    const can = at('closed', 'recorded');
    expect(can.canAddCandidate).toBe(false);
    // …while the surrounding record stays editable, which is why one flag
    // could never have covered both.
    expect(can.canEditElection).toBe(true);
    expect(can.canEditTallies).toBe(true);
  });

  it('offers add and remove only on a draft, for either source', () => {
    for (const source of ['recorded', 'conducted'] as ElectionSource[]) {
      expect(at('draft', source).canAddCandidate).toBe(true);
      expect(at('draft', source).canRemoveCandidate).toBe(true);
    }
    for (const status of ['open', 'closed', 'certified', 'void'] as const) {
      expect(at(status, 'recorded').canAddCandidate).toBe(false);
      expect(at(status, 'recorded').canRemoveCandidate).toBe(false);
    }
  });

  it('freezes a conducted election once it opens, but not a recorded one', () => {
    expect(at('draft', 'conducted').canEditElection).toBe(true);
    expect(at('open', 'conducted').canEditElection).toBe(false);
    expect(at('closed', 'conducted').canEditElection).toBe(false);
    expect(at('closed', 'recorded').canEditElection).toBe(true);
  });

  it('never offers typed tallies or a ballot register for a conducted election', () => {
    // Those are derived from real votes; typing them would overwrite the count.
    for (const status of ['draft', 'open', 'closed'] as const) {
      expect(at(status, 'conducted').canEditTallies).toBe(false);
      expect(at(status, 'conducted').canEditBallots).toBe(false);
    }
    expect(at('draft', 'recorded').canEditTallies).toBe(true);
  });

  it('offers nothing mutating once certified or void', () => {
    for (const status of ['certified', 'void'] as const) {
      const can = at(status, 'recorded');
      expect(can.canEditElection).toBe(false);
      expect(can.canAddCandidate).toBe(false);
      expect(can.canEditCandidate).toBe(false);
      expect(can.canEditTallies).toBe(false);
      expect(can.canEditBallots).toBe(false);
      expect(can.canDelete).toBe(false);
    }
  });

  it('places certify, uncertify, void and delete at their single valid status', () => {
    expect(at('closed', 'recorded').canCertify).toBe(true);
    expect(at('draft', 'recorded').canCertify).toBe(false);
    expect(at('certified', 'recorded').canUncertify).toBe(true);
    expect(at('closed', 'recorded').canUncertify).toBe(false);
    expect(at('closed', 'recorded').canVoid).toBe(true);
    expect(at('certified', 'recorded').canVoid).toBe(false);
    expect(at('draft', 'recorded').canDelete).toBe(true);
    expect(at('closed', 'recorded').canDelete).toBe(false);
  });
});

describe('canWithdrawCandidate', () => {
  const open = {
    status: 'open' as ElectionStatus,
    source: 'conducted' as ElectionSource,
  };

  it('allows withdrawing a standing candidate while a conducted election is open', () => {
    // The one candidate change the server permits after opening.
    expect(canWithdrawCandidate(open, { withdrawn: false })).toBe(true);
  });

  it('refuses to reinstate one already withdrawn while open — withdrawal is one-way', () => {
    // Ballots cast since would have been shown a different slate.
    expect(canWithdrawCandidate(open, { withdrawn: true })).toBe(false);
  });

  it('treats withdrawal as an ordinary edit when the election is not conducted-and-open', () => {
    const draft = {
      status: 'draft' as ElectionStatus,
      source: 'conducted' as ElectionSource,
    };
    expect(canWithdrawCandidate(draft, { withdrawn: true })).toBe(true);
    const certified = {
      status: 'certified' as ElectionStatus,
      source: 'recorded' as ElectionSource,
    };
    expect(canWithdrawCandidate(certified, { withdrawn: false })).toBe(false);
  });
});
