import { describe, it, expect } from 'vitest';
import {
  normalizeMeetingInput,
  normalizeMotionInput,
  tallyVotes,
} from '../../src/lib/types';

describe('normalizeMeetingInput', () => {
  const valid = {
    body: 'board',
    kind: 'regular',
    date: '2026-09-14',
    title: 'Sept',
  };

  it('accepts a minimal board meeting', () => {
    const r = normalizeMeetingInput(valid, 'create');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.body).toBe('board');
    expect(r.value.title).toBe('Sept');
  });

  it('accepts a member meeting so PR 3 needs no change', () => {
    const r = normalizeMeetingInput({ ...valid, body: 'member' }, 'create');
    expect(r.ok).toBe(true);
  });

  it('rejects an unknown body', () => {
    const r = normalizeMeetingInput({ ...valid, body: 'committee' }, 'create');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/body/);
  });

  it('rejects an unknown kind', () => {
    const r = normalizeMeetingInput({ ...valid, kind: 'emergency' }, 'create');
    expect(r.ok).toBe(false);
  });

  it('requires body, kind, date, and title on create', () => {
    for (const key of ['body', 'kind', 'date', 'title']) {
      const partial: Record<string, unknown> = { ...valid };
      delete partial[key];
      expect(normalizeMeetingInput(partial, 'create').ok).toBe(false);
    }
  });

  it('rejects a status field outright — status is transition-only', () => {
    const r = normalizeMeetingInput({ id: 'm1', status: 'approved' }, 'patch');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/status is not editable/i);
  });

  it('treats a blank summary as null', () => {
    const r = normalizeMeetingInput({ ...valid, summaryMd: '   ' }, 'create');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.summaryMd).toBeNull();
  });

  it('rejects a negative quorum', () => {
    const r = normalizeMeetingInput({ ...valid, quorumRequired: -1 }, 'create');
    expect(r.ok).toBe(false);
  });

  it('allows a patch that omits every field', () => {
    const r = normalizeMeetingInput({}, 'patch');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value).length).toBe(0);
  });
});

describe('normalizeMotionInput', () => {
  const valid = {
    meetingId: 'm1',
    text: 'Adopt the budget',
    outcome: 'passed',
  };

  it('accepts a motion with no second', () => {
    const r = normalizeMotionInput(
      { ...valid, secondPersonId: null },
      'create',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.secondPersonId).toBeNull();
  });

  it('rejects an unknown outcome', () => {
    const r = normalizeMotionInput({ ...valid, outcome: 'maybe' }, 'create');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/outcome/);
  });

  it('rejects a sequence field — the server assigns it', () => {
    const r = normalizeMotionInput({ ...valid, sequence: 3 }, 'create');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/sequence is not editable/i);
  });

  it('rejects motion text over the limit', () => {
    const r = normalizeMotionInput(
      { ...valid, text: 'x'.repeat(2001) },
      'create',
    );
    expect(r.ok).toBe(false);
  });
});

describe('tallyVotes', () => {
  it('reports not recorded for an empty roll call', () => {
    const t = tallyVotes([]);
    expect(t.recorded).toBe(false);
    expect(t.yes).toBe(0);
  });

  it('counts each choice separately', () => {
    const t = tallyVotes([
      { choice: 'yes' },
      { choice: 'yes' },
      { choice: 'no' },
      { choice: 'abstain' },
      { choice: 'recused' },
      { choice: 'absent' },
    ]);
    expect(t).toEqual({
      yes: 2,
      no: 1,
      abstain: 1,
      recused: 1,
      absent: 1,
      recorded: true,
    });
  });

  it('distinguishes a unanimous abstention from no roll call at all', () => {
    const abstained = tallyVotes([
      { choice: 'abstain' },
      { choice: 'abstain' },
    ]);
    expect(abstained.recorded).toBe(true);
    expect(tallyVotes([]).recorded).toBe(false);
  });
});
