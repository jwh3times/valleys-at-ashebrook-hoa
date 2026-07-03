import { describe, it, expect } from 'vitest';
import {
  normalizeDuesSettings,
  DEFAULT_DUES_SETTINGS,
} from '../../src/lib/types';

describe('normalizeDuesSettings', () => {
  it('fills defaults for a non-object', () => {
    expect(normalizeDuesSettings(null)).toEqual(DEFAULT_DUES_SETTINGS);
  });
  it('coerces fields to strings and drops unknown keys', () => {
    const out = normalizeDuesSettings({
      amount: 250,
      dueDate: 'Jan 31',
      notes: null,
      paymentOptions: [],
      evil: '<script>',
    });
    expect(out).toEqual({
      amount: DEFAULT_DUES_SETTINGS.amount, // 250 is not a string -> fallback
      dueDate: 'Jan 31',
      notes: DEFAULT_DUES_SETTINGS.notes,
      paymentOptions: [],
    });
    expect('evil' in out).toBe(false);
  });
  it('keeps http(s) payment urls and drops others', () => {
    const out = normalizeDuesSettings({
      amount: '$250',
      dueDate: '',
      notes: '',
      paymentOptions: [
        { label: 'PayPal', details: 'pay', url: 'https://paypal.me/x' },
        { label: 'Bad', details: 'x', url: 'javascript:alert(1)' },
        { label: 'NoUrl', details: 'mail a check' },
      ],
    });
    expect(out.paymentOptions[0].url).toBe('https://paypal.me/x');
    expect(out.paymentOptions[1].url).toBeUndefined();
    expect(out.paymentOptions[2].url).toBeUndefined();
  });
  it('replaces a non-array paymentOptions with []', () => {
    expect(
      normalizeDuesSettings({ paymentOptions: 'nope' }).paymentOptions,
    ).toEqual([]);
  });
});
