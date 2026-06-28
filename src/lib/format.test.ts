import { describe, it, expect } from 'vitest';
import { formatDate, todayIso } from './format';

describe('formatDate', () => {
  it('formats an ISO date as a friendly long date', () => {
    expect(formatDate('2026-06-28')).toBe('June 28, 2026');
  });

  it('handles ISO datetimes by using the date portion', () => {
    expect(formatDate('2026-01-05T12:00:00Z')).toBe('January 5, 2026');
  });

  it('returns an empty string for empty input', () => {
    expect(formatDate('')).toBe('');
  });

  it('returns the original value when it cannot be parsed', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date');
  });
});

describe('todayIso', () => {
  it('returns a YYYY-MM-DD string', () => {
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
