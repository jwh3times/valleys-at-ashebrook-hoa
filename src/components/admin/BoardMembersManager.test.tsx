import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchBoardMembers = vi.fn();
const promoteToBoard = vi.fn().mockResolvedValue(undefined);
const demoteFromBoard = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/admin', () => ({
  fetchBoardMembers: (...a: unknown[]) => fetchBoardMembers(...a),
  promoteToBoard: (...a: unknown[]) => promoteToBoard(...a),
  demoteFromBoard: (...a: unknown[]) => demoteFromBoard(...a),
}));

import BoardMembersManager from './BoardMembersManager';

describe('BoardMembersManager', () => {
  beforeEach(() => {
    fetchBoardMembers.mockReset().mockResolvedValue([
      {
        id: 'u1',
        name: 'Alice',
        email: 'alice@example.com',
        createdAt: '2026-01-01',
      },
    ]);
    promoteToBoard.mockClear();
    demoteFromBoard.mockClear();
  });

  it('lists board members and promotes by email', async () => {
    render(<BoardMembersManager />);
    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/person@example.com/i), {
      target: { value: 'bob@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /promote to board/i }));
    await waitFor(() =>
      expect(promoteToBoard).toHaveBeenCalledWith('bob@example.com'),
    );
  });

  it('demotes a board member', async () => {
    render(<BoardMembersManager />);
    fireEvent.click(await screen.findByRole('button', { name: /demote/i }));
    await waitFor(() => expect(demoteFromBoard).toHaveBeenCalledWith('u1'));
  });
});
