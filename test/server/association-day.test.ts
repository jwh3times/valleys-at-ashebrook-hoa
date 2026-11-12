import { afterEach, describe, expect, it, vi } from 'vitest';
import { associationDay } from './fixtures';

// #575: an Association Day is a calendar day in America/New_York, so it is 25
// hours long when the clocks go back and 23 when they go forward. Stepping the
// clock in 24-hour blocks gave two neighbouring offsets the same day (and, in
// spring, skipped one), which seeded a "day before" fixture on the day itself.

const at = (iso: string) =>
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(iso) });

afterEach(() => {
  vi.useRealTimers();
});

describe('associationDay', () => {
  it('is today in the association, not in UTC', () => {
    at('2026-11-12T04:41:00Z'); // 23:41 on 2026-11-11 in New York
    expect(associationDay()).toBe('2026-11-11');
    expect(associationDay(0)).toBe('2026-11-11');
  });

  it('keeps neighbouring days apart across the autumn clock change', () => {
    at('2026-11-12T04:41:00Z');
    expect(associationDay(-9)).toBe('2026-11-02');
    expect(associationDay(-10)).toBe('2026-11-01');
    expect(associationDay(-11)).toBe('2026-10-31');
  });

  it('skips no day across the spring clock change', () => {
    at('2027-03-15T04:30:00Z'); // 00:30 on 2027-03-15 in New York
    expect(associationDay(0)).toBe('2027-03-15');
    expect(associationDay(-1)).toBe('2027-03-14');
    expect(associationDay(-2)).toBe('2027-03-13');
  });

  it('counts forward as well as back, across a month and a year', () => {
    at('2026-12-31T16:00:00Z');
    expect(associationDay(1)).toBe('2027-01-01');
    expect(associationDay(-31)).toBe('2026-11-30');
  });
});
