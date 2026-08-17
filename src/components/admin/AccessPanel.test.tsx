import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AccessPanel from './AccessPanel';
import * as rosterAdmin from '../../lib/roster-admin';
import type {
  AccessGrantRow,
  BoardServiceTermRow,
  PersonLinkRow,
} from '../../lib/roster-admin';

vi.mock('../../lib/roster-admin');

const mocked = vi.mocked(rosterAdmin);

function grant(overrides: Partial<AccessGrantRow> = {}): AccessGrantRow {
  return {
    id: 'g1',
    accountId: 'acct-1',
    accountEmail: 'alice@example.com',
    grantType: 'board',
    qualifyingBoardTermId: 't1',
    startedAt: Date.UTC(2026, 0, 5, 15, 0),
    endedAt: null,
    grantReason: 'certification',
    endReason: null,
    live: true,
    ...overrides,
  };
}

function link(overrides: Partial<PersonLinkRow> = {}): PersonLinkRow {
  return {
    id: 'l1',
    accountId: 'acct-1',
    accountEmail: 'alice@example.com',
    accountName: 'Alice Owner',
    personId: 'party-1',
    personDisplayName: 'Alice Owner',
    startedAt: Date.UTC(2026, 0, 5, 15, 0),
    endedAt: null,
    endedByAccountId: null,
    endReason: null,
    current: true,
    verification: {
      id: 'v1',
      method: 'otp_email',
      reason: 'automatic_contact_proof',
      verifiedAt: Date.UTC(2026, 0, 5, 15, 0),
      approverAccountId: null,
    },
    ...overrides,
  };
}

function term(
  overrides: Partial<BoardServiceTermRow> = {},
): BoardServiceTermRow {
  return {
    id: 't1',
    personId: 'party-1',
    personName: 'Alice Owner',
    qualifyingLotId: 'lot-1',
    qualifyingLotAddress: '100 Main St',
    electionId: null,
    startDay: '2026-01-01',
    scheduledEndDay: '2027-01-01',
    actualEndDay: null,
    cancelledDay: null,
    voided: false,
    current: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.fetchAccessGrants.mockResolvedValue([]);
  mocked.fetchPersonLinks.mockResolvedValue([]);
  mocked.fetchBoardService.mockResolvedValue({
    terms: [term()],
    offices: [],
    advisories: {
      currentMemberCount: 1,
      belowMinimum: true,
      aboveMaximum: false,
      vacantOffices: [],
      expiringTermIds: [],
      lapsedTermIds: [],
    },
  });
  mocked.fetchRoster.mockResolvedValue({
    lots: [],
    people: [
      {
        partyId: 'party-1',
        displayName: 'Alice Owner',
        nameRedacted: false,
        consolidatedIntoPartyId: null,
      },
    ],
    organizations: [],
    ownerships: [],
    representations: [],
    contactMethods: [],
    advisories: { ownerlessLotIds: [] },
  });
});

describe('AccessPanel', () => {
  it('shows an empty state for both registers', async () => {
    render(<AccessPanel />);
    expect(
      await screen.findByText(/no access grants recorded/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/no person links recorded/i)).toBeInTheDocument();
  });

  it('lists grants, distinguishing live from ended', async () => {
    mocked.fetchAccessGrants.mockResolvedValue([
      grant({ id: 'g1', accountEmail: 'alice@example.com', live: true }),
      grant({
        id: 'g2',
        accountId: 'acct-2',
        accountEmail: 'bob@example.com',
        grantType: 'system_admin',
        qualifyingBoardTermId: null,
        live: false,
        endedAt: Date.UTC(2026, 5, 1, 12, 0),
        endReason: 'revoked',
      }),
    ]);
    render(<AccessPanel />);

    expect(
      await screen.findByText(/alice@example\.com — Board access · Live/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/bob@example\.com — System administration · Ended/),
    ).toBeInTheDocument();
    // Only the live grant offers a revoke.
    expect(
      screen.getByRole('button', { name: /revoke board grant for alice/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: /revoke system_admin grant for bob/i,
      }),
    ).not.toBeInTheDocument();
  });

  it('revokes a live grant and reloads', async () => {
    const user = userEvent.setup();
    mocked.fetchAccessGrants.mockResolvedValue([grant()]);
    mocked.revokeAccess.mockResolvedValue(undefined);
    render(<AccessPanel />);

    await user.click(
      await screen.findByRole('button', {
        name: /revoke board grant for alice/i,
      }),
    );

    await waitFor(() => expect(mocked.revokeAccess).toHaveBeenCalledWith('g1'));
    expect(await screen.findByText('Access revoked.')).toBeInTheDocument();
    expect(mocked.fetchAccessGrants).toHaveBeenCalledTimes(2);
  });

  it('surfaces the last-System-Administrator refusal verbatim', async () => {
    const user = userEvent.setup();
    const refusal =
      'Revoking this grant would leave no System Administrator — grant another first.';
    mocked.fetchAccessGrants.mockResolvedValue([
      grant({ grantType: 'system_admin', qualifyingBoardTermId: null }),
    ]);
    mocked.revokeAccess.mockRejectedValue(new Error(refusal));
    render(<AccessPanel />);

    await user.click(
      await screen.findByRole('button', {
        name: /revoke system_admin grant for alice/i,
      }),
    );

    expect(await screen.findByText(`Error: ${refusal}`)).toBeInTheDocument();
  });

  it('grants board access against the chosen qualifying term', async () => {
    const user = userEvent.setup();
    mocked.grantAccess.mockResolvedValue({ id: 'g9' });
    render(<AccessPanel />);
    await screen.findByText(/no access grants recorded/i);

    await user.type(screen.getByLabelText(/account id to grant/i), 'acct-9');
    await waitFor(() =>
      expect(
        screen.getByRole('option', { name: /100 Main St/ }),
      ).toBeInTheDocument(),
    );
    await user.selectOptions(
      screen.getByLabelText(/qualifying board term/i),
      't1',
    );
    await user.click(screen.getByRole('button', { name: 'Grant access' }));

    await waitFor(() =>
      expect(mocked.grantAccess).toHaveBeenCalledWith({
        accountId: 'acct-9',
        grantType: 'board',
        qualifyingBoardTermId: 't1',
      }),
    );
  });

  it('refuses a board grant with no qualifying term chosen', async () => {
    const user = userEvent.setup();
    render(<AccessPanel />);
    await screen.findByText(/no access grants recorded/i);

    await user.type(screen.getByLabelText(/account id to grant/i), 'acct-9');
    await user.click(screen.getByRole('button', { name: 'Grant access' }));

    expect(
      await screen.findByText(/choose the board term that qualifies/i),
    ).toBeInTheDocument();
    expect(mocked.grantAccess).not.toHaveBeenCalled();
  });

  it('requires evidence before recording a manual verification', async () => {
    const user = userEvent.setup();
    mocked.manualVerifyPersonLink.mockResolvedValue({
      id: 'l9',
      verificationId: 'v9',
    });
    render(<AccessPanel />);
    await screen.findByText(/no person links recorded/i);

    await user.type(screen.getByLabelText(/account id to link/i), 'acct-9');
    await waitFor(() =>
      expect(
        screen.getByRole('option', { name: 'Alice Owner' }),
      ).toBeInTheDocument(),
    );
    await user.selectOptions(screen.getByLabelText(/^person$/i), 'party-1');
    await user.click(
      screen.getByRole('button', { name: /record person link/i }),
    );

    expect(
      await screen.findByText(/evidence is required to record/i),
    ).toBeInTheDocument();
    expect(mocked.manualVerifyPersonLink).not.toHaveBeenCalled();

    // A locator-carrying kind still needs its reference before the call.
    await user.selectOptions(screen.getByLabelText(/evidence/i), 'document');
    await user.click(
      screen.getByRole('button', { name: /record person link/i }),
    );
    expect(
      await screen.findByText(/enter the reference for the evidence/i),
    ).toBeInTheDocument();
    expect(mocked.manualVerifyPersonLink).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/document id/i), 'doc-1');
    await user.click(
      screen.getByRole('button', { name: /record person link/i }),
    );
    await waitFor(() =>
      expect(mocked.manualVerifyPersonLink).toHaveBeenCalledWith({
        accountId: 'acct-9',
        personId: 'party-1',
        reason: 'manual_board_decision',
        evidence: { kind: 'document', documentId: 'doc-1' },
      }),
    );
  });

  it('unlinks a current person link with the chosen end reason', async () => {
    const user = userEvent.setup();
    mocked.fetchPersonLinks.mockResolvedValue([link()]);
    mocked.unlinkPersonLink.mockResolvedValue(undefined);
    render(<AccessPanel />);

    await user.click(
      await screen.findByRole('button', { name: /unlink alice@example\.com/i }),
    );
    // No reason chosen yet: the helper is never called.
    expect(
      await screen.findByText(/choose why this link is ending/i),
    ).toBeInTheDocument();
    expect(mocked.unlinkPersonLink).not.toHaveBeenCalled();

    await user.selectOptions(
      screen.getByLabelText(/end reason for alice@example\.com/i),
      'recorded_in_error',
    );
    await user.click(
      screen.getByRole('button', { name: /unlink alice@example\.com/i }),
    );
    await waitFor(() =>
      expect(mocked.unlinkPersonLink).toHaveBeenCalledWith({
        linkId: 'l1',
        endReason: 'recorded_in_error',
      }),
    );
  });
});
