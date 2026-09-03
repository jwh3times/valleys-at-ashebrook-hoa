import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchMembers = vi.fn();
const fetchProperties = vi.fn();
const fetchRosterPeople = vi.fn();
const memberAction = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/admin', () => ({
  fetchMembers: (...a: unknown[]) => fetchMembers(...a),
  fetchProperties: (...a: unknown[]) => fetchProperties(...a),
  fetchRosterPeople: (...a: unknown[]) => fetchRosterPeople(...a),
  memberAction: (...a: unknown[]) => memberAction(...a),
}));

const fetchVerificationRequests = vi.fn();
const acceptVerificationRequest = vi.fn();
const declineVerificationRequest = vi.fn();
const fetchCorrectionRequests = vi.fn();
const acceptCorrectionRequest = vi.fn();
const declineCorrectionRequest = vi.fn();
vi.mock('../../lib/roster-admin', () => ({
  fetchVerificationRequests: (...a: unknown[]) =>
    fetchVerificationRequests(...a),
  acceptVerificationRequest: (...a: unknown[]) =>
    acceptVerificationRequest(...a),
  declineVerificationRequest: (...a: unknown[]) =>
    declineVerificationRequest(...a),
  fetchCorrectionRequests: (...a: unknown[]) => fetchCorrectionRequests(...a),
  acceptCorrectionRequest: (...a: unknown[]) => acceptCorrectionRequest(...a),
  declineCorrectionRequest: (...a: unknown[]) => declineCorrectionRequest(...a),
}));

import MembersManager from './MembersManager';

const request = {
  id: 'vr1',
  accountId: 'a1',
  accountEmail: 'applicant@x.com',
  claimedAddress: '12 Oak Ln',
  claimedName: 'Pat Applicant',
  channel: 'email' as const,
  internalReason: 'applicant_requested_review',
  createdAt: Date.UTC(2026, 6, 4, 12),
};

const correction = {
  id: 'cr1',
  accountId: 'a2',
  personId: 'per2',
  personDisplayName: 'Lee Owner',
  kind: 'contact_method' as const,
  contactMethodId: 'cm1',
  targetChannel: 'email' as const,
  targetCurrentValue: 'old@x.com',
  channel: 'email' as const,
  proposedValue: 'new@x.com',
  note: 'typo in my email',
  status: 'open' as const,
  createdAt: Date.UTC(2026, 6, 5, 12),
  decidedAt: null,
  decidedByAccountId: null,
};

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
  fetchRosterPeople
    .mockReset()
    .mockResolvedValue([{ partyId: 'per1', displayName: 'Pat Applicant' }]);
  fetchVerificationRequests.mockReset().mockResolvedValue([request]);
  acceptVerificationRequest.mockReset().mockResolvedValue({
    linkId: 'l1',
    verificationId: 'v1',
  });
  declineVerificationRequest.mockReset().mockResolvedValue(undefined);
  fetchCorrectionRequests.mockReset().mockResolvedValue([correction]);
  acceptCorrectionRequest.mockReset().mockResolvedValue(undefined);
  declineCorrectionRequest.mockReset().mockResolvedValue(undefined);
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

  describe('verification requests queue', () => {
    it('shows an empty state when nothing is awaiting review', async () => {
      fetchVerificationRequests.mockResolvedValue([]);
      render(<MembersManager />);
      expect(
        await screen.findByText(/no verification requests/i),
      ).toBeInTheDocument();
    });

    it('lists an open request with the applicant claim', async () => {
      render(<MembersManager />);
      expect(await screen.findByText('applicant@x.com')).toBeInTheDocument();
      expect(
        screen.getByText(/pat applicant — 12 oak ln/i),
      ).toBeInTheDocument();
    });

    it('accepts a request with the person the board picked', async () => {
      render(<MembersManager />);
      await screen.findByText('applicant@x.com');
      fireEvent.change(screen.getByLabelText(/person for applicant@x.com/i), {
        target: { value: 'per1' },
      });
      fireEvent.click(
        screen.getByRole('button', { name: /accept verification request:/i }),
      );
      await waitFor(() =>
        expect(acceptVerificationRequest).toHaveBeenCalledWith({
          id: 'vr1',
          personId: 'per1',
        }),
      );
      expect(
        await screen.findByText(/verification request accepted/i),
      ).toBeInTheDocument();
    });

    it('refuses to accept until a person is picked', async () => {
      render(<MembersManager />);
      await screen.findByText('applicant@x.com');
      fireEvent.click(
        screen.getByRole('button', { name: /accept verification request:/i }),
      );
      expect(
        await screen.findByText(/pick the person this account belongs to/i),
      ).toBeInTheDocument();
      expect(acceptVerificationRequest).not.toHaveBeenCalled();
    });

    it("surfaces the route's refusal verbatim", async () => {
      acceptVerificationRequest.mockRejectedValue(
        new Error(
          'This Person is already linked to an account — unlink it first',
        ),
      );
      render(<MembersManager />);
      await screen.findByText('applicant@x.com');
      fireEvent.change(screen.getByLabelText(/person for applicant@x.com/i), {
        target: { value: 'per1' },
      });
      fireEvent.click(
        screen.getByRole('button', { name: /accept verification request:/i }),
      );
      expect(
        await screen.findByText(
          /this person is already linked to an account — unlink it first/i,
        ),
      ).toBeInTheDocument();
    });

    it('declines a request', async () => {
      render(<MembersManager />);
      await screen.findByText('applicant@x.com');
      fireEvent.click(
        screen.getByRole('button', { name: /decline verification request:/i }),
      );
      await waitFor(() =>
        expect(declineVerificationRequest).toHaveBeenCalledWith('vr1'),
      );
      expect(
        await screen.findByText(/verification request declined/i),
      ).toBeInTheDocument();
    });
  });

  describe('correction requests queue', () => {
    it('shows an empty state when no corrections are open', async () => {
      fetchCorrectionRequests.mockResolvedValue([]);
      render(<MembersManager />);
      expect(
        await screen.findByText(/no correction requests/i),
      ).toBeInTheDocument();
    });

    it('renders only open requests, with the proposed change and note', async () => {
      fetchCorrectionRequests.mockResolvedValue([
        correction,
        { ...correction, id: 'cr2', status: 'accepted' as const },
      ]);
      render(<MembersManager />);
      expect(await screen.findByText('Lee Owner')).toBeInTheDocument();
      expect(screen.getAllByText(/old@x\.com → new@x\.com/)).toHaveLength(1);
      expect(screen.getByText(/typo in my email/)).toBeInTheDocument();
    });

    it('accepts a correction', async () => {
      render(<MembersManager />);
      await screen.findByText('Lee Owner');
      fireEvent.click(
        screen.getByRole('button', { name: /accept correction from lee/i }),
      );
      await waitFor(() =>
        expect(acceptCorrectionRequest).toHaveBeenCalledWith('cr1'),
      );
      expect(
        await screen.findByText(/correction accepted/i),
      ).toBeInTheDocument();
    });

    it('declines a correction and surfaces a route refusal verbatim', async () => {
      declineCorrectionRequest.mockRejectedValue(
        new Error('Correction request was already decided'),
      );
      render(<MembersManager />);
      await screen.findByText('Lee Owner');
      fireEvent.click(
        screen.getByRole('button', { name: /decline correction from lee/i }),
      );
      expect(
        await screen.findByText(/correction request was already decided/i),
      ).toBeInTheDocument();
    });
  });

  describe('legacy manual approval queue', () => {
    it('is hidden when it holds no pending rows', async () => {
      fetchMembers.mockResolvedValue({
        recent: [],
        queue: [],
      });
      render(<MembersManager />);
      await screen.findByText('applicant@x.com');
      expect(screen.queryByText(/legacy queue/i)).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /approve/i }),
      ).not.toBeInTheDocument();
    });

    it('is labelled as legacy when it still holds rows', async () => {
      render(<MembersManager />);
      expect(await screen.findByText(/legacy queue/i)).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /approve/i }),
      ).toBeInTheDocument();
    });
  });
});
