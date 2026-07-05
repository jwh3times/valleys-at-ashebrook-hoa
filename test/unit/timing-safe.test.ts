import { describe, it, expect } from 'vitest';
import { timingSafeEqual } from '../../src/server/authz/timing-safe';

describe('timingSafeEqual', () => {
  it('is true for identical strings', () => {
    expect(timingSafeEqual('s3cr3t-token', 's3cr3t-token')).toBe(true);
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('is false for same-length strings that differ', () => {
    expect(timingSafeEqual('abcdef', 'abcdeg')).toBe(false);
  });

  it('is false when the lengths differ', () => {
    expect(timingSafeEqual('short', 'short-and-then-some')).toBe(false);
    expect(timingSafeEqual('nonempty', '')).toBe(false);
  });
});
