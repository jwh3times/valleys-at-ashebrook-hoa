import { describe, it, expect } from 'vitest';
import { board, homeowner, visitor } from '../../src/server/auth/permissions';

describe('board role permissions', () => {
  it('board no longer holds admin-plugin capabilities', () => {
    expect(board.authorize({ user: ['set-role'] }).success).toBe(false);
    expect(board.authorize({ user: ['ban'] }).success).toBe(false);
    expect(board.authorize({ user: ['impersonate'] }).success).toBe(false);
  });
  it('non-board roles hold none either', () => {
    expect(homeowner.authorize({ user: ['set-role'] }).success).toBe(false);
    expect(visitor.authorize({ user: ['set-role'] }).success).toBe(false);
  });
});
