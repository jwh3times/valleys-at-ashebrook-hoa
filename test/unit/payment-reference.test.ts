import { describe, it, expect } from 'vitest';
import { paymentReference } from '../../src/lib/payments';

describe('the Payment Reference a homeowner quotes (#562)', () => {
  it('is the payment id’s first eight characters, upper-cased, split four and four', () => {
    expect(paymentReference('de501dc2-7a1b-4c3d-9e8f-0a1b2c3d4e5f')).toBe(
      'DE50-1DC2',
    );
  });

  it('keeps a leading zero', () => {
    expect(paymentReference('0a1b2c3d-ffff-4fff-8fff-ffffffffffff')).toBe(
      '0A1B-2C3D',
    );
  });
});
