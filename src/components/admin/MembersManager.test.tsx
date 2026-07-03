import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchMembers = vi.fn();
const fetchProperties = vi.fn();
const memberAction = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/admin', () => ({
  fetchMembers: (...a: unknown[]) => fetchMembers(...a),
  fetchProperties: (...a: unknown[]) => fetchProperties(...a),
  memberAction: (...a: unknown[]) => memberAction(...a),
}));

import MembersManager from './MembersManager';

beforeEach(() => {
  fetchMembers.mockReset().mockResolvedValue({
    recent: [
      {
        id: 'u1',
        name: 'Existing HO',
        email: 'ho@x.com',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
    ],
    queue: [
      {
        id: 'q1',
        userId: 'u2',
        email: 'pending@x.com',
        claimedAddress: '9 Elm St',
        reason: 'address not found',
        status: 'pending',
        createdAt: '2026-06-20T00:00:00.000Z',
      },
    ],
  });
  fetchProperties.mockReset().mockResolvedValue([
    {
      id: 'p9',
      address: '9 Elm St',
      unit: null,
      status: 'active',
      notes: null,
      owners: [],
    },
  ]);
  memberAction.mockClear();
});

describe('MembersManager', () => {
  it('renders the pending queue with the requester email, and recent homeowners', async () => {
    render(<MembersManager />);
    expect(await screen.findByText('pending@x.com')).toBeInTheDocument();
    expect(screen.getByText('9 Elm St')).toBeInTheDocument();
    expect(screen.getByText('ho@x.com')).toBeInTheDocument();
  });

  it('approves a pending request with the selected propertyId', async () => {
    render(<MembersManager />);
    await screen.findByText('pending@x.com');
    fireEvent.change(screen.getByLabelText(/home for pending@x.com/i), {
      target: { value: 'p9' },
    });
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(memberAction).toHaveBeenCalledTimes(1));
    expect(memberAction.mock.calls[0][0]).toEqual({
      action: 'approve',
      queueId: 'q1',
      propertyId: 'p9',
    });
  });

  it('revokes a homeowner', async () => {
    render(<MembersManager />);
    await screen.findByText('ho@x.com');
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }));
    await waitFor(() => expect(memberAction).toHaveBeenCalledTimes(1));
    expect(memberAction.mock.calls[0][0]).toEqual({
      action: 'revoke',
      userId: 'u1',
    });
  });
});
