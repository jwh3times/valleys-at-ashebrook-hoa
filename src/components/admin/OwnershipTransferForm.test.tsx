import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RosterAdminPanel from './RosterAdminPanel';
import * as rosterApi from '../../lib/roster-admin';
import * as transferApi from '../../lib/ownership-transfer';
import type { AdminRoster } from '../../lib/roster-admin';
import type { OwnershipTransferPreview } from '../../lib/ownership-transfer';
import { associationDateIso } from '../../lib/format';

vi.mock('../../lib/roster-admin');
vi.mock('../../lib/ownership-transfer');
const data: AdminRoster = {
  lots: [
    {
      id: 'lot',
      address: '100 Example Lane',
      unit: null,
      voteWeight: 1,
      retiredAt: null,
      retiredDay: null,
      ownerless: false,
      platLotNumber: null,
    },
  ],
  people: ['Seller', 'Buyer', 'Co-owner'].map((name) => ({
    partyId: name,
    displayName: `${name} Example`,
    nameRedacted: false,
    consolidatedIntoPartyId: null,
  })),
  organizations: [],
  ownerships: ['Seller', 'Co-owner'].map((name) => ({
    id: `ownership-${name}`,
    ownerPartyId: name,
    lotId: 'lot',
    startDay: '2025-01-01',
    endDay: null,
    voided: false,
    current: true,
  })),
  representations: [],
  contactMethods: [],
  advisories: { ownerlessLotIds: [] },
};
const review: OwnershipTransferPreview = {
  token: 'preview-1',
  lotId: 'lot',
  address: '100 Example Lane',
  effectiveDay: associationDateIso(),
  departing: [{ id: 'Seller', displayName: 'Seller Example' }],
  incoming: [{ id: 'Buyer', displayName: 'Buyer Example' }],
  retained: [{ id: 'Co-owner', displayName: 'Co-owner Example' }],
  authorityLost: [{ id: 'Seller', displayName: 'Seller Example' }],
  authorityGained: [{ id: 'Buyer', displayName: 'Buyer Example' }],
  access: [
    {
      personId: 'Seller',
      displayName: 'Seller Example',
      lotAuthority: 'lost',
      memberAccess: 'retained',
    },
  ],
  boardTerms: [],
  resetMotionIds: ['motion'],
  reviewFlagCount: 1,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(rosterApi.fetchRoster).mockResolvedValue(data);
  vi.mocked(transferApi.previewOwnershipTransfer).mockResolvedValue(review);
  vi.mocked(transferApi.commitOwnershipTransfer).mockResolvedValue({
    ownershipIds: ['new'],
  });
});
async function start() {
  const user = userEvent.setup();
  render(<RosterAdminPanel />);
  await user.click(
    await screen.findByRole('button', {
      name: 'Transfer ownership: 100 Example Lane',
    }),
  );
  await user.click(screen.getByRole('checkbox', { name: 'Seller Example' }));
  await user.click(screen.getByRole('checkbox', { name: 'Buyer Example' }));
  return user;
}
it('requires a preview, invalidates it after an edit, and refreshes the roster after confirmation', async () => {
  const user = await start();
  expect(
    screen.queryByRole('button', { name: 'Confirm ownership transfer' }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Review transfer' }));
  expect(
    await screen.findByText('Unchanged co-owners: Co-owner Example.'),
  ).toBeInTheDocument();
  expect(screen.getByText(/Member Access retained/)).toBeInTheDocument();
  expect(transferApi.commitOwnershipTransfer).not.toHaveBeenCalled();
  await user.click(screen.getByRole('checkbox', { name: 'Buyer Example' }));
  expect(
    screen.queryByRole('button', { name: 'Confirm ownership transfer' }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: 'Buyer Example' }));
  await user.click(screen.getByRole('button', { name: 'Review transfer' }));
  await user.click(
    await screen.findByRole('button', { name: 'Confirm ownership transfer' }),
  );
  await waitFor(() =>
    expect(transferApi.commitOwnershipTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        lotId: 'lot',
        departingOwnershipIds: ['ownership-Seller'],
        incomingPartyIds: ['Buyer'],
      }),
      'preview-1',
    ),
  );
  expect(
    await screen.findByText('Ownership transfer recorded.'),
  ).toBeInTheDocument();
  expect(rosterApi.fetchRoster).toHaveBeenCalledTimes(2);
});
it('shows a stale-preview error and requires another review before retrying', async () => {
  const user = await start();
  vi.mocked(transferApi.commitOwnershipTransfer).mockRejectedValue(
    new Error('Transfer data changed — review again'),
  );
  await user.click(screen.getByRole('button', { name: 'Review transfer' }));
  await user.click(
    await screen.findByRole('button', { name: 'Confirm ownership transfer' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Transfer data changed',
  );
  expect(
    screen.queryByRole('button', { name: 'Confirm ownership transfer' }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Review transfer' })).toBeEnabled();
});
it('requires a new preview after choosing a Board Term substitute', async () => {
  vi.mocked(transferApi.previewOwnershipTransfer).mockResolvedValue({
    ...review,
    boardTerms: [
      {
        termId: 'term',
        personId: 'Seller',
        displayName: 'Seller Example',
        action: 'end',
        substituteLotId: null,
        availableLots: [{ id: 'other', address: '200 Example Lane' }],
        offices: ['president'],
        boardGrantsEnding: 1,
      },
    ],
  });
  const user = await start();
  await user.click(screen.getByRole('button', { name: 'Review transfer' }));
  await user.selectOptions(
    await screen.findByRole('combobox', {
      name: 'Board-qualifying Lot for Seller Example',
    }),
    'other',
  );
  expect(
    screen.queryByRole('button', { name: 'Confirm ownership transfer' }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Review transfer' }));
  await waitFor(() =>
    expect(transferApi.previewOwnershipTransfer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        substitutions: [{ termId: 'term', qualifyingLotId: 'other' }],
      }),
    ),
  );
});
it('cancels without committing a transfer', async () => {
  const user = await start();
  await user.click(screen.getByRole('button', { name: 'Review transfer' }));
  await screen.findByRole('button', { name: 'Confirm ownership transfer' });
  await user.click(screen.getByRole('button', { name: 'Cancel transfer' }));
  expect(
    screen.queryByRole('button', { name: 'Confirm ownership transfer' }),
  ).not.toBeInTheDocument();
  expect(transferApi.commitOwnershipTransfer).not.toHaveBeenCalled();
});
