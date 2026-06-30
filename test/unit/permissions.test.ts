import { describe, it, expect } from 'vitest';
import { board, homeowner, visitor } from '../../src/server/auth/permissions';

describe('board role permissions', () => {
  it('board can set-role; homeowner and visitor cannot', () => {
    expect(board.authorize({ user: ['set-role'] }).success).toBe(true);
    expect(homeowner.authorize({ user: ['set-role'] }).success).toBe(false);
    expect(visitor.authorize({ user: ['set-role'] }).success).toBe(false);
  });
});
