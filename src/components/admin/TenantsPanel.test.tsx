import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TenantsPanel from './TenantsPanel';
import * as rosterAdmin from '../../lib/roster-admin';
import type {
  AdminRoster,
  AdminTenancy,
  AdminTenancyRequest,
  TenantsPanelData,
} from '../../lib/roster-admin';

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

function request(
  overrides: Partial<AdminTenancyRequest> = {},
): AdminTenancyRequest {
  return {
    id: 'req-1',
    kind: 'new',
    lotId: 'lot-1',
    address: '100 Example Lane',
    requesterName: 'Olive Owner',
    tenantName: 'Ned Next',
    channel: 'email',
    contact: 'ned@example.test',
    scheduledEndDay: '2027-06-01',
    renewsTenancyId: null,
    createdAt: 1,
    basisEnded: false,
    candidates: [],
    ...overrides,
  };
}

function panel(
  tenancies: AdminTenancy[],
  requests: AdminTenancyRequest[] = [],
  approvalOpen = true,
): TenantsPanelData {
  return { tenancies, requests, approvalOpen };
}

/** A roster holding the requested tenant under another name, and a
 * consolidated duplicate who must never be offered. */
function roster(): AdminRoster {
  return {
    lots: [],
    people: [
      {
        partyId: 'p-7',
        displayName: 'Edward Next',
        nameRedacted: false,
        consolidatedIntoPartyId: null,
      },
      {
        partyId: 'p-6',
        displayName: 'Edward Nextdoor',
        nameRedacted: false,
        consolidatedIntoPartyId: 'p-7',
      },
      {
        partyId: 'p-5',
        displayName: 'Olive Owner',
        nameRedacted: false,
        consolidatedIntoPartyId: null,
      },
    ],
    organizations: [],
    ownerships: [],
    representations: [],
    contactMethods: [
      {
        id: 'cm-1',
        partyId: 'p-5',
        channel: 'sms',
        value: '(555) 555-0142',
        redacted: false,
        isPreferred: true,
        startDay: null,
        endDay: null,
        voided: false,
      },
    ],
    advisories: { ownerlessLotIds: [] },
  };
}

async function openApproveDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole('button', {
      name: 'Approve tenancy request: Ned Next, 100 Example Lane',
    }),
  );
  return screen.getByRole('dialog', { name: 'Approve tenancy' });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('TenantsPanel', () => {
  it('lists each tenancy with its tenant, Lot and status', async () => {
    mocked.fetchTenantsPanel.mockResolvedValue(
      panel([
        tenancy(),
        tenancy({
          id: 'ten-2',
          tenantName: 'Ned Next',
          status: 'ended',
          actualEndDay: '2026-05-01',
          endReason: 'basis_ended',
        }),
      ]),
    );
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
    mocked.fetchTenantsPanel.mockResolvedValue(panel([]));
    render(<TenantsPanel />);
    expect(
      await screen.findByText('No tenancies recorded yet.'),
    ).toBeInTheDocument();
  });

  it('ends a current tenancy and reloads the list', async () => {
    mocked.fetchTenantsPanel
      .mockResolvedValueOnce(panel([tenancy()]))
      .mockResolvedValueOnce(
        panel([
          tenancy({
            status: 'ended',
            actualEndDay: '2026-06-01',
            endReason: 'board_ended',
          }),
        ]),
      );
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
    mocked.fetchTenantsPanel.mockResolvedValue(panel([tenancy()]));
    render(<TenantsPanel />);
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Void tenancy: Tess Tenant, 100 Example Lane',
      }),
    );
    expect(mocked.voidTenancy).not.toHaveBeenCalled();
  });

  it('voids a tenancy and shows the server’s refusal when one comes back', async () => {
    mocked.fetchTenantsPanel.mockResolvedValue(panel([tenancy()]));
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
    mocked.fetchTenantsPanel.mockResolvedValue(
      panel([
        tenancy({ id: 'v', tenantName: 'Vic Void', status: 'voided' }),
        tenancy({
          id: 'e',
          tenantName: 'Ed Ended',
          status: 'ended',
          actualEndDay: '2026-03-01',
          endReason: 'board_ended',
        }),
      ]),
    );
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

describe('TenantsPanel request queue', () => {
  it('lists each open request with its requester, contact and end day', async () => {
    mocked.fetchTenantsPanel.mockResolvedValue(
      panel(
        [],
        [
          request(),
          request({
            id: 'req-2',
            kind: 'renewal',
            tenantName: 'Tess Tenant',
            channel: null,
            contact: null,
            renewsTenancyId: 'ten-1',
          }),
        ],
      ),
    );
    render(<TenantsPanel />);
    const queue = await screen.findByRole('region', {
      name: 'Requests waiting',
    });
    expect(
      within(queue).getByText('100 Example Lane — Ned Next'),
    ).toBeInTheDocument();
    expect(
      within(queue).getByText(
        'New tenant, asked by Olive Owner · ned@example.test · until 2027-06-01',
      ),
    ).toBeInTheDocument();
    expect(
      within(queue).getByText(
        'Renewal, asked by Olive Owner · until 2027-06-01',
      ),
    ).toBeInTheDocument();
  });

  it('approves a new request as a new Person by default', async () => {
    mocked.fetchTenantsPanel.mockResolvedValue(panel([], [request()]));
    mocked.approveTenancyRequest.mockResolvedValue(undefined);
    render(<TenantsPanel />);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', {
        name: 'Approve tenancy request: Ned Next, 100 Example Lane',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Approve tenancy' });
    expect(
      within(dialog).getByLabelText('Record Ned Next as a new person'),
    ).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(mocked.approveTenancyRequest).toHaveBeenCalledWith('req-1', null),
    );
    expect(await screen.findByText('Tenancy approved.')).toBeInTheDocument();
    expect(mocked.fetchTenantsPanel).toHaveBeenCalledTimes(2);
  });

  it('approves naming a matching Person the board picks', async () => {
    mocked.fetchTenantsPanel.mockResolvedValue(
      panel(
        [],
        [
          request({
            candidates: [
              { personId: 'p-9', name: 'Ned Next', matchedBy: 'contact' },
              { personId: 'p-8', name: 'Ned Next', matchedBy: 'name' },
            ],
          }),
        ],
      ),
    );
    mocked.approveTenancyRequest.mockResolvedValue(undefined);
    render(<TenantsPanel />);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', {
        name: 'Approve tenancy request: Ned Next, 100 Example Lane',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Approve tenancy' });
    await user.click(
      within(dialog).getByLabelText('Ned Next — already holds this contact'),
    );
    expect(
      within(dialog).getByLabelText('Ned Next — same name'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(mocked.approveTenancyRequest).toHaveBeenCalledWith('req-1', 'p-9'),
    );
  });

  it('shows the reason when approval is refused', async () => {
    mocked.fetchTenantsPanel.mockResolvedValue(panel([], [request()]));
    mocked.approveTenancyRequest.mockRejectedValue(
      new Error('This request has already been decided.'),
    );
    render(<TenantsPanel />);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', {
        name: 'Approve tenancy request: Ned Next, 100 Example Lane',
      }),
    );
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Approve',
      }),
    );
    expect(
      await screen.findByText('Error: This request has already been decided.'),
    ).toBeInTheDocument();
  });

  it('offers only Refuse on a request whose basis has ended', async () => {
    mocked.fetchTenantsPanel.mockResolvedValue(
      panel([], [request({ basisEnded: true })]),
    );
    render(<TenantsPanel />);
    expect(
      await screen.findByText(
        "The owner's ownership has ended, so this request can only be refused.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Approve tenancy request/ }),
    ).toBeNull();
    expect(
      screen.getByRole('button', {
        name: 'Refuse tenancy request: Ned Next, 100 Example Lane',
      }),
    ).toBeInTheDocument();
  });

  it('refuses with a reason the owner will see', async () => {
    mocked.fetchTenantsPanel.mockResolvedValue(panel([], [request()]));
    mocked.refuseTenancyRequest.mockResolvedValue(undefined);
    render(<TenantsPanel />);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', {
        name: 'Refuse tenancy request: Ned Next, 100 Example Lane',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Refuse request' });
    const confirm = within(dialog).getByRole('button', { name: 'Refuse' });
    expect(confirm).toBeDisabled();
    await user.type(
      within(dialog).getByLabelText('Reason (the owner sees this)'),
      'No lease on file',
    );
    await user.click(confirm);
    await waitFor(() =>
      expect(mocked.refuseTenancyRequest).toHaveBeenCalledWith(
        'req-1',
        'No lease on file',
      ),
    );
    expect(await screen.findByText('Request refused.')).toBeInTheDocument();
  });

  it('closes a dialog on Escape without acting', async () => {
    mocked.fetchTenantsPanel.mockResolvedValue(panel([], [request()]));
    render(<TenantsPanel />);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', {
        name: 'Refuse tenancy request: Ned Next, 100 Example Lane',
      }),
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocked.refuseTenancyRequest).not.toHaveBeenCalled();
  });

  it('searches the roster by name, and approves naming the Person found', async () => {
    mocked.fetchTenantsPanel.mockResolvedValue(panel([], [request()]));
    mocked.fetchRoster.mockResolvedValue(roster());
    mocked.approveTenancyRequest.mockResolvedValue(undefined);
    render(<TenantsPanel />);
    const user = userEvent.setup();
    const dialog = await openApproveDialog(user);
    await user.type(
      within(dialog).getByLabelText('Search the roster by name or contact'),
      'edward',
    );
    await user.click(
      await within(dialog).findByLabelText('Edward Next — found by search'),
    );
    expect(
      within(dialog).queryByLabelText(/Edward Nextdoor/),
    ).not.toBeInTheDocument();
    // Narrowing the search past the choice keeps it on the list.
    await user.type(
      within(dialog).getByLabelText('Search the roster by name or contact'),
      'zzz',
    );
    expect(
      within(dialog).getByLabelText('Edward Next — found by search'),
    ).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(mocked.approveTenancyRequest).toHaveBeenCalledWith('req-1', 'p-7'),
    );
    expect(mocked.fetchRoster).toHaveBeenCalledTimes(1);
  });

  it('searches the roster by a phone number’s digits', async () => {
    mocked.fetchTenantsPanel.mockResolvedValue(panel([], [request()]));
    mocked.fetchRoster.mockResolvedValue(roster());
    render(<TenantsPanel />);
    const user = userEvent.setup();
    const dialog = await openApproveDialog(user);
    await user.type(
      within(dialog).getByLabelText('Search the roster by name or contact'),
      '5550142',
    );
    expect(
      await within(dialog).findByLabelText('Olive Owner — found by search'),
    ).toBeInTheDocument();
  });

  it('offers only Refuse while tenant access is switched off', async () => {
    mocked.fetchTenantsPanel.mockResolvedValue(panel([], [request()], false));
    render(<TenantsPanel />);
    expect(
      await screen.findByText(
        'Tenant access is switched off, so requests can be refused but not approved.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Approve tenancy request/ }),
    ).toBeNull();
    expect(
      screen.getByRole('button', {
        name: 'Refuse tenancy request: Ned Next, 100 Example Lane',
      }),
    ).toBeInTheDocument();
  });
});
