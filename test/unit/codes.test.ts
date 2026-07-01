import { describe, it, expect } from 'vitest';
import {
  generateCode,
  hashCode,
  verifyCode,
  MAX_ATTEMPTS,
} from '../../src/server/verification/codes';

describe('codes', () => {
  it('generates a 6-digit numeric code', () => {
    expect(generateCode()).toMatch(/^\d{6}$/);
  });
  it('verifies a matching code and rejects a wrong one', async () => {
    const code = '123456';
    const hash = await hashCode(code);
    expect(await verifyCode('123456', hash)).toBe(true);
    expect(await verifyCode('000000', hash)).toBe(false);
  });
  it('exposes an attempt cap', () => {
    expect(MAX_ATTEMPTS).toBe(5);
  });
});
