import { describe, it, expect } from 'vitest';
import {
  generateCode,
  hashCode,
  verifyCode,
  MAX_ATTEMPTS,
} from '../../src/server/verification/codes';

const SECRET = 'unit-test-secret';

describe('codes', () => {
  it('generates a 6-digit numeric code', () => {
    expect(generateCode()).toMatch(/^\d{6}$/);
  });
  it('verifies a matching code and rejects a wrong one', async () => {
    const hash = await hashCode('123456', SECRET);
    expect(await verifyCode('123456', hash, SECRET)).toBe(true);
    expect(await verifyCode('000000', hash, SECRET)).toBe(false);
  });
  it('is keyed: the same code hashes differently under a different secret', async () => {
    expect(await hashCode('123456', 'a')).not.toBe(
      await hashCode('123456', 'b'),
    );
    expect(await verifyCode('123456', await hashCode('123456', 'a'), 'b')).toBe(
      false,
    );
  });
  it('produces a 64-char hex digest (HMAC-SHA-256)', async () => {
    expect(await hashCode('123456', SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('exposes an attempt cap', () => {
    expect(MAX_ATTEMPTS).toBe(5);
  });
});
