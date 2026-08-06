import { describe, it, expect } from 'vitest';
import {
  normalizeElectionInput,
  normalizeCandidateInput,
} from '../../src/lib/types';

const validElection = {
  title: 'Board Election 2026',
  seats: 2,
  electionDate: '2026-03-01',
};

const validCandidate = {
  fullName: 'Jane Doe',
};

describe('normalizeElectionInput', () => {
  it('accepts a minimal election on create', () => {
    const r = normalizeElectionInput(validElection, 'create');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.title).toBe('Board Election 2026');
    expect(r.value.seats).toBe(2);
    expect(r.value.electionDate).toBe('2026-03-01');
  });

  it('requires title, seats, and electionDate on create', () => {
    for (const key of ['title', 'seats', 'electionDate']) {
      const partial: Record<string, unknown> = { ...validElection };
      delete partial[key];
      expect(normalizeElectionInput(partial, 'create').ok).toBe(false);
    }
  });

  it('allows a patch that omits every field', () => {
    const r = normalizeElectionInput({}, 'patch');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value).length).toBe(0);
  });

  it('rejects a status key outright', () => {
    const r = normalizeElectionInput(
      { ...validElection, status: 'certified' },
      'create',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/status is not editable/i);
  });

  it('rejects a falsy-but-present status, so a truthiness check would fail', () => {
    const onCreate = normalizeElectionInput(
      { ...validElection, status: null },
      'create',
    );
    expect(onCreate.ok).toBe(false);
    if (!onCreate.ok) expect(onCreate.error).toMatch(/status is not editable/i);

    const onPatch = normalizeElectionInput(
      { title: 'Renamed', status: undefined },
      'patch',
    );
    expect(onPatch.ok).toBe(false);
    if (!onPatch.ok) expect(onPatch.error).toMatch(/status is not editable/i);
  });

  it('accepts a conducted source only when creating an election', () => {
    const onCreate = normalizeElectionInput(
      { ...validElection, source: 'conducted' },
      'create',
    );
    expect(onCreate).toMatchObject({
      ok: true,
      value: { source: 'conducted' },
    });

    const onPatch = normalizeElectionInput(
      { title: 'Renamed', source: 'recorded' },
      'patch',
    );
    expect(onPatch.ok).toBe(false);
    if (!onPatch.ok) expect(onPatch.error).toMatch(/source is not editable/i);
  });

  it('rejects a falsy-but-present source, so a truthiness check would fail', () => {
    // An object literal with `source: undefined` still has the key, so
    // `'source' in r` is true. A regression to `if (r.source)` would let
    // null/undefined through — and since every guard in this feature tests
    // `source`, that would BE the bypass.
    const onCreate = normalizeElectionInput(
      { ...validElection, source: null },
      'create',
    );
    expect(onCreate.ok).toBe(false);
    if (!onCreate.ok) expect(onCreate.error).toMatch(/source/i);

    const onPatch = normalizeElectionInput(
      { title: 'Renamed', source: undefined },
      'patch',
    );
    expect(onPatch.ok).toBe(false);
    if (!onPatch.ok) expect(onPatch.error).toMatch(/source is not editable/i);
  });

  it('rejects certifiedAt and certifiedBy keys', () => {
    for (const field of ['certifiedAt', 'certifiedBy'] as const) {
      const onCreate = normalizeElectionInput(
        { ...validElection, [field]: null },
        'create',
      );
      expect(onCreate.ok).toBe(false);
      if (!onCreate.ok) {
        expect(onCreate.error).toMatch(
          /certification provenance is not editable/i,
        );
      }

      const onPatch = normalizeElectionInput(
        { title: 'Renamed', [field]: undefined },
        'patch',
      );
      expect(onPatch.ok).toBe(false);
      if (!onPatch.ok) {
        expect(onPatch.error).toMatch(
          /certification provenance is not editable/i,
        );
      }
    }
  });

  it('rejects seats below 1', () => {
    for (const seats of [0, -1, -5]) {
      const r = normalizeElectionInput({ ...validElection, seats }, 'create');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/seats must be at least 1/);
    }
  });

  it('rejects a non-integer seats', () => {
    const r = normalizeElectionInput(
      { ...validElection, seats: 1.5 },
      'create',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/seats/);
  });

  it('rejects a malformed electionDate', () => {
    const r = normalizeElectionInput(
      { ...validElection, electionDate: '03/01/2026' },
      'create',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/electionDate must be YYYY-MM-DD/);
  });

  it('rejects a non-calendar electionDate', () => {
    const r = normalizeElectionInput(
      { ...validElection, electionDate: '2026-02-31' },
      'create',
    );
    expect(r.ok).toBe(false);
  });

  it('caps an over-length title', () => {
    const r = normalizeElectionInput(
      { ...validElection, title: 'x'.repeat(201) },
      'create',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/title must be 200 characters or fewer/);
  });
});

describe('normalizeCandidateInput', () => {
  it('rejects a votes key on candidate input', () => {
    const r = normalizeCandidateInput(
      { ...validCandidate, votes: 5 },
      'create',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/votes is not editable/i);
  });

  it('rejects a falsy-but-present votes key on candidate input', () => {
    const onCreate = normalizeCandidateInput(
      { ...validCandidate, votes: null },
      'create',
    );
    expect(onCreate.ok).toBe(false);
    if (!onCreate.ok) expect(onCreate.error).toMatch(/votes is not editable/i);

    const onPatch = normalizeCandidateInput(
      { fullName: 'Renamed', votes: undefined },
      'patch',
    );
    expect(onPatch.ok).toBe(false);
    if (!onPatch.ok) expect(onPatch.error).toMatch(/votes is not editable/i);
  });

  it('rejects a won key on candidate input', () => {
    const r = normalizeCandidateInput(
      { ...validCandidate, won: true },
      'create',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/won is not editable/i);
  });

  it('rejects a falsy-but-present won key on candidate input', () => {
    const onCreate = normalizeCandidateInput(
      { ...validCandidate, won: null },
      'create',
    );
    expect(onCreate.ok).toBe(false);
    if (!onCreate.ok) expect(onCreate.error).toMatch(/won is not editable/i);

    const onPatch = normalizeCandidateInput(
      { fullName: 'Renamed', won: undefined },
      'patch',
    );
    expect(onPatch.ok).toBe(false);
    if (!onPatch.ok) expect(onPatch.error).toMatch(/won is not editable/i);
  });

  it('rejects a sequence key on candidate input', () => {
    const r = normalizeCandidateInput(
      { ...validCandidate, sequence: 1 },
      'create',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/sequence is not editable/i);
  });

  it('rejects a falsy-but-present sequence key', () => {
    const onCreate = normalizeCandidateInput(
      { ...validCandidate, sequence: null },
      'create',
    );
    expect(onCreate.ok).toBe(false);
    if (!onCreate.ok)
      expect(onCreate.error).toMatch(/sequence is not editable/i);

    const onPatch = normalizeCandidateInput(
      { fullName: 'Renamed', sequence: undefined },
      'patch',
    );
    expect(onPatch.ok).toBe(false);
    if (!onPatch.ok) expect(onPatch.error).toMatch(/sequence is not editable/i);
  });

  it('caps an over-length candidate statement', () => {
    const r = normalizeCandidateInput(
      { ...validCandidate, statementMd: 'x'.repeat(4001) },
      'create',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/statementMd must be 4000 characters or fewer/);
  });
});
