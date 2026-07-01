import { describe, it, expect } from 'vitest';
import { tierAllows, visibleTiers } from '../../src/server/content/visibility';

describe('tierAllows', () => {
  it('lets each role see its tier and below, not above', () => {
    expect(tierAllows('visitor', 'public')).toBe(true);
    expect(tierAllows('visitor', 'homeowner')).toBe(false);
    expect(tierAllows('homeowner', 'homeowner')).toBe(true);
    expect(tierAllows('homeowner', 'board')).toBe(false);
    expect(tierAllows('board', 'board')).toBe(true);
    expect(tierAllows('board', 'public')).toBe(true);
  });
  it('unknown role sees only public (fail-closed)', () => {
    expect(tierAllows('wat' as never, 'public')).toBe(true);
    expect(tierAllows('wat' as never, 'homeowner')).toBe(false);
  });
  it('visibleTiers lists what a role may see', () => {
    expect(visibleTiers('visitor')).toEqual(['public']);
    expect(visibleTiers('homeowner')).toEqual(['public', 'homeowner']);
    expect(visibleTiers('board')).toEqual(['public', 'homeowner', 'board']);
  });
});
