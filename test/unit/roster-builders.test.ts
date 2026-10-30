import { describe, it, expect } from 'vitest';
import { normalizedContactValue } from '../../src/server/roster/builders';
import { CONTACT_INPUT_LIMITS } from '../../src/lib/types';

// Each value below is well-formed, so only the length cap can refuse it.
const email = (length: number) =>
  `${'a'.repeat(length - '@example.test'.length)}@example.test`;
const phone = (length: number) =>
  `555${' '.repeat(length - '555555-0142'.length)}555-0142`;

describe('normalizedContactValue', () => {
  it('accepts a value exactly at its channel’s limit', () => {
    expect(
      normalizedContactValue('email', email(CONTACT_INPUT_LIMITS.email)),
    ).toEqual({ ok: true, value: email(CONTACT_INPUT_LIMITS.email) });
    expect(
      normalizedContactValue('sms', phone(CONTACT_INPUT_LIMITS.sms)),
    ).toEqual({ ok: true, value: '+15555550142' });
  });

  it('refuses a value one character over its channel’s limit', () => {
    expect(
      normalizedContactValue('email', email(CONTACT_INPUT_LIMITS.email + 1)),
    ).toEqual({
      ok: false,
      error: `value must be ${CONTACT_INPUT_LIMITS.email} characters or fewer`,
    });
    expect(
      normalizedContactValue('sms', phone(CONTACT_INPUT_LIMITS.sms + 1)),
    ).toEqual({
      ok: false,
      error: `value must be ${CONTACT_INPUT_LIMITS.sms} characters or fewer`,
    });
  });

  it('still refuses a short value of the wrong shape', () => {
    expect(normalizedContactValue('email', 'not-an-email')).toEqual({
      ok: false,
      error: 'Invalid email address',
    });
    expect(normalizedContactValue('sms', '555-01')).toEqual({
      ok: false,
      error: 'Invalid phone number',
    });
  });
});
