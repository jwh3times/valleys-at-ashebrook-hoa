import { describe, it, expect } from 'vitest';
import {
  associationDateIso,
  dayAfter,
  formatDate,
  todayIso,
  maskContact,
  maskEmail,
} from './format';

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

describe('associationDateIso', () => {
  it('uses the Eastern calendar day before Eastern midnight', () => {
    expect(associationDateIso(new Date('2026-08-05T02:00:00.000Z'))).toBe(
      '2026-08-04',
    );
  });
});

describe('maskEmail', () => {
  it('keeps the first local-part character and the full domain', () => {
    expect(maskEmail('jerryholland00@gmail.com')).toBe('j***@gmail.com');
  });

  it('does not leak the local-part length', () => {
    // A one-character and a long local part both mask to the same shape.
    expect(maskEmail('a@example.com')).toBe('a***@example.com');
    expect(maskEmail('alexander@example.com')).toBe('a***@example.com');
  });

  it('fully masks a value with no usable local part or domain', () => {
    expect(maskEmail('notanemail')).toBe('***');
    expect(maskEmail('@example.com')).toBe('***');
    expect(maskEmail('user@')).toBe('***');
    expect(maskEmail('')).toBe('***');
  });
});

describe('maskContact', () => {
  it('shows only the last four characters of an email address', () => {
    expect(maskContact('email', 'ned@example.test')).toBe('***test');
  });

  it('shows only the last four digits of a phone number', () => {
    expect(maskContact('sms', '(555) 555-0142')).toBe('***0142');
  });

  it('masks a value too short to hide anything entirely', () => {
    expect(maskContact('email', 'a@bc')).toBe('***');
    expect(maskContact('sms', '0142')).toBe('***');
  });
});

describe('dayAfter', () => {
  it('rolls over a month and a year end', () => {
    expect(dayAfter('2026-10-31')).toBe('2026-11-01');
    expect(dayAfter('2026-12-31')).toBe('2027-01-01');
  });
});
