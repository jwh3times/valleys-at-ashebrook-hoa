import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RosterAdminPanel from './RosterAdminPanel';
import * as rosterAdmin from '../../lib/roster-admin';
import type { AdminRoster } from '../../lib/roster-admin';

vi.mock('../../lib/roster-admin');

const mocked = vi.mocked(rosterAdmin);

function roster(overrides: Partial<AdminRoster> = {}): AdminRoster {
  return {
    lots: [],
    people: [],
    organizations: [],
    ownerships: [],
    representations: [],
    contactMethods: [],
    advisories: { ownerlessLotIds: [] },
    ...overrides,
  };
}

function lot(overrides: Partial<AdminRoster['lots'][number]> = {}) {
  return {
    id: 'l1',
    address: '100 Main St',
    unit: null,
    voteWeight: 1,
    retiredDay: null,
    retiredAt: null,
    ownerless: false,
    ...overrides,
  };
}

function person(overrides: Partial<AdminRoster['people'][number]> = {}) {
  return {
    partyId: 'p1',
    displayName: 'Jane Doe',
    nameRedacted: false,
    consolidatedIntoPartyId: null,
    ...overrides,
  };
}

let createObjectUrl = vi.fn(() => 'blob:roster');

beforeEach(() => {
  vi.resetAllMocks();
  mocked.fetchRoster.mockResolvedValue(roster());
  // jsdom implements neither of these; the export path needs both.
  createObjectUrl = vi.fn(() => 'blob:roster');
  Object.defineProperty(URL, 'createObjectURL', {
    value: createObjectUrl,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RosterAdminPanel', () => {
  it('shows an empty state when the roster has no lots', async () => {
    render(<RosterAdminPanel />);
    expect(
      await screen.findByText(/no lots recorded yet/i),
    ).toBeInTheDocument();
  });

  it('renders the ownerless-lot advisory with addresses', async () => {
    mocked.fetchRoster.mockResolvedValue(
      roster({
        lots: [
          lot({ id: 'l1', address: '100 Main St', ownerless: true }),
          lot({ id: 'l2', address: '200 Oak St' }),
        ],
        advisories: { ownerlessLotIds: ['l1'] },
      }),
    );
    render(<RosterAdminPanel />);

    const advisory = await screen.findByRole('status');
    expect(advisory).toHaveTextContent('Ownerless lots (1)');
    expect(advisory).toHaveTextContent('100 Main St');
    expect(advisory).not.toHaveTextContent('200 Oak St');
  });

  it('retires a lot through the helper and reports it', async () => {
    const user = userEvent.setup();
    mocked.fetchRoster.mockResolvedValue(roster({ lots: [lot()] }));
    mocked.retireLot.mockResolvedValue(undefined);
    render(<RosterAdminPanel />);

    await user.selectOptions(await screen.findByLabelText('Lot'), 'l1');
    await user.click(screen.getByRole('button', { name: 'Retire lot' }));

    await waitFor(() =>
      expect(mocked.retireLot).toHaveBeenCalledWith(
        expect.objectContaining({ lotId: 'l1' }),
      ),
    );
    expect(await screen.findByText('Lot retired.')).toBeInTheDocument();
  });

  it('surfaces the server refusal verbatim', async () => {
    const user = userEvent.setup();
    mocked.fetchRoster.mockResolvedValue(roster({ lots: [lot()] }));
    mocked.retireLot.mockRejectedValue(
      new Error(
        'A current board term names this lot as its qualifying lot — substitute or end the term first',
      ),
    );
    render(<RosterAdminPanel />);

    await user.selectOptions(await screen.findByLabelText('Lot'), 'l1');
    await user.click(screen.getByRole('button', { name: 'Retire lot' }));

    expect(
      await screen.findByText(
        /A current board term names this lot as its qualifying lot — substitute or end the term first/,
      ),
    ).toBeInTheDocument();
  });

  it('consolidation requires an explicitly chosen survivor', async () => {
    const user = userEvent.setup();
    mocked.fetchRoster.mockResolvedValue(
      roster({
        people: [
          person({ partyId: 'p1', displayName: 'Jane Doe' }),
          person({ partyId: 'p2', displayName: 'Jane A. Doe' }),
        ],
      }),
    );
    mocked.consolidateParties.mockResolvedValue(undefined);
    render(<RosterAdminPanel />);

    await user.click(await screen.findByRole('button', { name: 'Parties' }));

    // The survivor is never preselected, so the flow cannot advance on the
    // duplicate alone.
    const survivor = screen.getByLabelText('Surviving party');
    expect(survivor).toHaveValue('');
    await user.selectOptions(screen.getByLabelText('Duplicate party'), 'p1');
    expect(
      screen.getByRole('button', { name: 'Review consolidation' }),
    ).toBeDisabled();

    await user.selectOptions(survivor, 'p2');
    await user.click(
      screen.getByRole('button', { name: 'Review consolidation' }),
    );

    // Reviewing summarises the direction; nothing is written until confirmed.
    expect(screen.getByText(/will be consolidated into/i)).toBeInTheDocument();
    expect(mocked.consolidateParties).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole('button', { name: 'Confirm consolidation' }),
    );
    await waitFor(() =>
      expect(mocked.consolidateParties).toHaveBeenCalledWith(
        expect.objectContaining({
          duplicatePartyId: 'p1',
          survivorPartyId: 'p2',
        }),
      ),
    );
  });

  it('exports only after a confirm stating the permanent record and the loss of control', async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mocked.exportRoster.mockResolvedValue({
      generatedAt: Date.UTC(2026, 7, 17, 16),
      roster: roster(),
    });
    render(<RosterAdminPanel />);
    await screen.findByText(/no lots recorded yet/i);

    await user.click(screen.getByRole('button', { name: 'Export roster' }));
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringMatching(/permanently recorded as an Access Event/),
    );
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringMatching(/removes personal data from the system/),
    );
    expect(mocked.exportRoster).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Export roster' }));
    await waitFor(() => expect(mocked.exportRoster).toHaveBeenCalled());
    expect(createObjectUrl).toHaveBeenCalled();
  });
});
