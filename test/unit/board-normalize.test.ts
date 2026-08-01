import { describe, it, expect } from 'vitest';
import {
  normalizeBoardPersonInput,
  normalizeBoardTermInput,
  termRangeError,
} from '../../src/lib/types';

describe('normalizeBoardPersonInput', () => {
  it('trims a name and treats a blank user id as null', () => {
    const r = normalizeBoardPersonInput(
      { fullName: '  A. Reyes  ', userId: '   ' },
      'create',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.fullName).toBe('A. Reyes');
    expect(r.value.userId).toBeNull();
  });

  it('requires a name on create', () => {
    const r = normalizeBoardPersonInput({}, 'create');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/fullName is required/);
  });

  it('allows a patch that omits every field', () => {
    const r = normalizeBoardPersonInput({}, 'patch');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value).length).toBe(0);
  });

  it('rejects a name over the limit', () => {
    const r = normalizeBoardPersonInput(
      { fullName: 'x'.repeat(201) },
      'create',
    );
    expect(r.ok).toBe(false);
  });
});

describe('normalizeBoardTermInput', () => {
  it('accepts an open term with no office', () => {
    const r = normalizeBoardTermInput(
      { personId: 'p1', termStart: '2026-01-01', termEnd: null, title: null },
      'create',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.termEnd).toBeNull();
    expect(r.value.title).toBeNull();
  });

  it('rejects a malformed start date with a field-specific message', () => {
    const r = normalizeBoardTermInput(
      { personId: 'p1', termStart: '01/01/2026' },
      'create',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/termStart must be YYYY-MM-DD/);
  });

  it('rejects a non-calendar date', () => {
    const r = normalizeBoardTermInput(
      { personId: 'p1', termStart: '2026-02-31' },
      'create',
    );
    expect(r.ok).toBe(false);
  });

  it('rejects an end date before the start date', () => {
    const r = normalizeBoardTermInput(
      { personId: 'p1', termStart: '2026-01-01', termEnd: '2025-12-31' },
      'create',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/termEnd must not be before termStart/);
  });

  it('requires a start date on create', () => {
    const r = normalizeBoardTermInput({ personId: 'p1' }, 'create');
    expect(r.ok).toBe(false);
  });
});

describe('termRangeError', () => {
  it('accepts an open term', () => {
    expect(termRangeError('2026-01-01', null)).toBeNull();
  });
  it('accepts an end equal to the start', () => {
    expect(termRangeError('2026-01-01', '2026-01-01')).toBeNull();
  });
  it('rejects an end before the start', () => {
    expect(termRangeError('2026-01-01', '2025-12-31')).toMatch(
      /termEnd must not be before termStart/,
    );
  });
});
