import { describe, it, expect } from 'vitest';
import { tallyVotes, normalizeVoteWeight } from '../../src/lib/types';

describe('tallyVotes with weights', () => {
  it('treats a missing weight as 1, so board votes are unchanged', () => {
    const t = tallyVotes([
      { choice: 'yes' },
      { choice: 'yes' },
      { choice: 'no' },
    ]);
    expect(t.yes).toBe(2);
    expect(t.no).toBe(1);
    expect(t.recorded).toBe(true);
  });

  it('sums weights rather than counting rows', () => {
    const t = tallyVotes([
      { choice: 'yes', weight: 3 },
      { choice: 'yes', weight: 2 },
      { choice: 'no', weight: 1 },
    ]);
    expect(t.yes).toBe(5);
    expect(t.no).toBe(1);
  });

  it('is identical to counting when every weight is 1', () => {
    const weighted = tallyVotes([
      { choice: 'yes', weight: 1 },
      { choice: 'no', weight: 1 },
    ]);
    const unweighted = tallyVotes([{ choice: 'yes' }, { choice: 'no' }]);
    expect(weighted).toEqual(unweighted);
  });

  it('still reports not recorded for an empty list regardless of weight', () => {
    expect(tallyVotes([]).recorded).toBe(false);
  });

  it('does not let a zero weight fake an unrecorded vote', () => {
    // A property with weight 0 still voted. `recorded` tracks whether a roll
    // call exists, not whether it moved the total.
    const t = tallyVotes([{ choice: 'yes', weight: 0 }]);
    expect(t.recorded).toBe(true);
    expect(t.yes).toBe(0);
  });
});

describe('normalizeVoteWeight', () => {
  it('accepts a positive integer', () => {
    const r = normalizeVoteWeight({ voteWeight: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBe(3);
  });

  it('skips an absent field', () => {
    const r = normalizeVoteWeight({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBeUndefined();
  });

  it('rejects zero — a property with no vote should be inactive, not weight 0', () => {
    const r = normalizeVoteWeight({ voteWeight: 0 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/voteWeight/);
  });

  it('rejects a negative, a float, a numeric string, and NaN', () => {
    for (const v of [-1, 1.5, '3', NaN]) {
      expect(normalizeVoteWeight({ voteWeight: v }).ok).toBe(false);
    }
  });

  it('rejects null — weight is NOT NULL with a default, never cleared', () => {
    expect(normalizeVoteWeight({ voteWeight: null }).ok).toBe(false);
  });
});
