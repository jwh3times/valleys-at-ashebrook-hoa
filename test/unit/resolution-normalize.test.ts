import { describe, it, expect } from 'vitest';
import { normalizeResolutionInput } from '../../src/lib/types';

const valid = {
  number: 'R-2026-03',
  title: 'Trash bin placement',
  bodyMd: 'Bins may not be visible from the street except on collection day.',
};

describe('normalizeResolutionInput', () => {
  it('accepts a minimal draft', () => {
    const r = normalizeResolutionInput(valid, 'create');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.number).toBe('R-2026-03');
    expect(r.value.title).toBe('Trash bin placement');
  });

  it('requires number, title, and bodyMd on create', () => {
    for (const key of ['number', 'title', 'bodyMd']) {
      const partial: Record<string, unknown> = { ...valid };
      delete partial[key];
      expect(normalizeResolutionInput(partial, 'create').ok).toBe(false);
    }
  });

  it('allows a patch that omits every field', () => {
    const r = normalizeResolutionInput({}, 'patch');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value).length).toBe(0);
  });

  it('rejects a status key outright — status is transition-only', () => {
    const r = normalizeResolutionInput(
      { ...valid, status: 'in_force' },
      'create',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/status is not editable/i);
  });

  it('rejects a falsy-but-present status, so a truthiness check would fail', () => {
    // The guard must fire on key PRESENCE. A regression to `if (raw.status)`
    // would let null and undefined through.
    const onCreate = normalizeResolutionInput(
      { ...valid, status: null },
      'create',
    );
    expect(onCreate.ok).toBe(false);
    if (!onCreate.ok) expect(onCreate.error).toMatch(/status is not editable/i);

    const onPatch = normalizeResolutionInput(
      { title: 'Renamed', status: undefined },
      'patch',
    );
    expect(onPatch.ok).toBe(false);
    if (!onPatch.ok) expect(onPatch.error).toMatch(/status is not editable/i);
  });

  it('rejects a supersedesId key — supersession is an action, not a field', () => {
    const r = normalizeResolutionInput(
      { ...valid, supersedesId: 'r-old' },
      'create',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/supersedesId is not editable/i);
  });

  it('rejects an adoptedByMotionId key — adoption is an action', () => {
    const r = normalizeResolutionInput(
      { ...valid, adoptedByMotionId: 'mo1' },
      'create',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/adoptedByMotionId is not editable/i);
  });

  it('rejects a falsy-but-present supersedesId or adoptedByMotionId', () => {
    // Same presence-not-truthiness rule as status: a regression to
    // `if (raw.supersedesId)` would let null and undefined through, and the
    // chain invariants are only safe while these stay unwritable by PATCH.
    // Each case asserts the field-specific message, so it cannot pass for
    // some unrelated reason.
    for (const field of ['supersedesId', 'adoptedByMotionId'] as const) {
      const onCreate = normalizeResolutionInput(
        { ...valid, [field]: null },
        'create',
      );
      expect(onCreate.ok).toBe(false);
      if (!onCreate.ok) {
        expect(onCreate.error).toMatch(
          new RegExp(`${field} is not editable`, 'i'),
        );
      }

      const onPatch = normalizeResolutionInput(
        { title: 'Renamed', [field]: undefined },
        'patch',
      );
      expect(onPatch.ok).toBe(false);
      if (!onPatch.ok) {
        expect(onPatch.error).toMatch(
          new RegExp(`${field} is not editable`, 'i'),
        );
      }
    }
  });

  it('treats a blank effective date as null', () => {
    const r = normalizeResolutionInput(
      { ...valid, effectiveDate: '   ' },
      'create',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.effectiveDate).toBeNull();
  });

  it('rejects a malformed effective date with a field-specific message', () => {
    const r = normalizeResolutionInput(
      { ...valid, effectiveDate: '09/15/2026' },
      'create',
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/effectiveDate must be YYYY-MM-DD/);
  });

  it('rejects a non-calendar effective date', () => {
    expect(
      normalizeResolutionInput(
        { ...valid, effectiveDate: '2026-02-31' },
        'create',
      ).ok,
    ).toBe(false);
  });

  it('rejects an over-length number and body', () => {
    expect(
      normalizeResolutionInput({ ...valid, number: 'x'.repeat(41) }, 'create')
        .ok,
    ).toBe(false);
    expect(
      normalizeResolutionInput(
        { ...valid, bodyMd: 'x'.repeat(20001) },
        'create',
      ).ok,
    ).toBe(false);
  });

  it('accepts and normalizes visibility', () => {
    const r = normalizeResolutionInput(
      { ...valid, visibility: 'homeowner' },
      'create',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.visibility).toBe('homeowner');
  });
});
