import { describe, it, expect } from 'vitest';
import { normalizeAddress } from '../../src/server/roster/lookup';

describe('normalizeAddress', () => {
  it('canonicalizes case, spacing, and punctuation', () => {
    expect(normalizeAddress('  9904   Wishing Willow Dr. ')).toBe('9904 wishing willow dr');
    expect(normalizeAddress('9904 WISHING WILLOW DR')).toBe('9904 wishing willow dr');
  });
});
