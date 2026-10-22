import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TenantsPanel from './TenantsPanel';
import * as rosterAdmin from '../../lib/roster-admin';
import type { AdminTenancy } from '../../lib/roster-admin';

vi.mock('../../lib/roster-admin');

const mocked = vi.mocked(rosterAdmin);

function tenancy(overrides: Partial<AdminTenancy> = {}): AdminTenancy {
  return {
    id: 'ten-1',
    tenantPersonId: 'p-1',
    tenantName: 'Tess Tenant',
    lotId: 'lot-1',
    address: '100 Example Lane',
    startDay: '2026-01-01',
    scheduledEndDay: '2027-01-01',
    actualEndDay: null,
    endReason: null,
    renewsTenancyId: null,
    status: 'current',
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('TenantsPanel', () => {
  it('lists each tenancy with its tenant, Lot and status', async () => {
    mocked.fetchTenancies.mockResolvedValue([
      tenancy(),
      tenancy({
        id: 'ten-2',
        tenantName: 'Ned Next',
        status: 'ended',
        actualEndDay: '2026-05-01',
        endReason: 'basis_ended',
      }),
    ]);
    render(<TenantsPanel />);
    expect(
      await screen.findByText('100 Example Lane — Tess Tenant'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Current, 2026-01-01 to 2027-01-01'),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Ended 2026-05-01: the owner's ownership ended"),
    ).toBeInTheDocument();
  });

  it('says so when there are no tenancies', async () => {
    mocked.fetchTenancies.mockResolvedValue([]);
    render(<TenantsPanel />);
    expect(
      await screen.findByText('No tenancies recorded yet.'),
    ).toBeInTheDocument();
  });

  it('ends a current tenancy and reloads the list', async () => {
    mocked.fetchTenancies
      .mockResolvedValueOnce([tenancy()])
      .mockResolvedValueOnce([
        tenancy({
          status: 'ended',
          actualEndDay: '2026-06-01',
          endReason: 'board_ended',
        }),
      ]);
    mocked.endTenancy.mockResolvedValue(undefined);
    render(<TenantsPanel />);
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'End tenancy: Tess Tenant, 100 Example Lane',
      }),
    );
    expect(mocked.endTenancy).toHaveBeenCalledWith('ten-1');
    expect(await screen.findByText('Tenancy ended.')).toBeInTheDocument();
    expect(
      screen.getByText('Ended 2026-06-01: ended by the board'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^End tenancy/ }),
    ).not.toBeInTheDocument();
  });

  it('does nothing when the board cancels the confirmation', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    mocked.fetchTenancies.mockResolvedValue([tenancy()]);
    render(<TenantsPanel />);
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Void tenancy: Tess Tenant, 100 Example Lane',
      }),
    );
    expect(mocked.voidTenancy).not.toHaveBeenCalled();
  });

  it('voids a tenancy and shows the server’s refusal when one comes back', async () => {
    mocked.fetchTenancies.mockResolvedValue([tenancy()]);
    mocked.voidTenancy.mockRejectedValue(new Error('Tenancy already voided'));
    render(<TenantsPanel />);
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Void tenancy: Tess Tenant, 100 Example Lane',
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText('Error: Tenancy already voided'),
      ).toBeInTheDocument(),
    );
  });

  it('offers no actions on a voided tenancy, and only Void on an ended one', async () => {
    mocked.fetchTenancies.mockResolvedValue([
      tenancy({ id: 'v', tenantName: 'Vic Void', status: 'voided' }),
      tenancy({
        id: 'e',
        tenantName: 'Ed Ended',
        status: 'ended',
        actualEndDay: '2026-03-01',
        endReason: 'board_ended',
      }),
    ]);
    render(<TenantsPanel />);
    await screen.findByText('100 Example Lane — Vic Void');
    expect(screen.queryByRole('button', { name: /Vic Void/ })).toBeNull();
    expect(
      screen.getByRole('button', {
        name: 'Void tenancy: Ed Ended, 100 Example Lane',
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^End tenancy: Ed/ }),
    ).toBeNull();
  });
});
