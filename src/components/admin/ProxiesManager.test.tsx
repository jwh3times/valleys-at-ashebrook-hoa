import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProxiesManager from './ProxiesManager';
import * as admin from '../../lib/admin';
import type {
  ProxyDetail,
  MeetingSummary,
  ElectionDetail,
  PropertyWithOwners,
} from '../../lib/types';

vi.mock('../../lib/admin');

const mocked = vi.mocked(admin);

beforeEach(() => {
  vi.resetAllMocks();
  mocked.fetchProperties.mockResolvedValue([]);
  mocked.fetchMeetings.mockResolvedValue([]);
  mocked.fetchElections.mockResolvedValue([]);
});

function proxy(overrides: Partial<ProxyDetail> = {}): ProxyDetail {
  return {
    id: 'px1',
    propertyId: 'p1',
    address: '100 Main St',
    grantorOwnerId: 'o1',
    grantorName: 'Jane Doe',
    holderName: 'Alice Holder',
    holderOwnerId: null,
    holderOwnerName: null,
    meetingId: null,
    electionId: null,
    ...overrides,
  };
}

function meeting(overrides: Partial<MeetingSummary> = {}): MeetingSummary {
  return {
    id: 'm1',
    body: 'member',
    kind: 'annual',
    date: '2026-09-14',
    title: 'September meeting',
    status: 'approved',
    visibility: 'board',
    motionCount: 0,
    ...overrides,
  };
}

function election(overrides: Partial<ElectionDetail> = {}): ElectionDetail {
  return {
    id: 'e1',
    meetingId: null,
    title: 'Board Election 2026',
    seats: 2,
    electionDate: '2026-01-15',
    source: 'recorded',
    status: 'closed',
    visibility: 'board',
    candidates: [],
    turnout: {
      ballotsCast: 0,
      weightCast: 0,
      eligibleCount: 0,
      eligibleWeight: 0,
      eligibilityFrozen: false,
    },
    eligibleProperties: [],
    ballots: [],
    ...overrides,
  };
}

function property(
  overrides: Partial<PropertyWithOwners> = {},
): PropertyWithOwners {
  return {
    id: 'p1',
    address: '100 Main St',
    unit: null,
    status: 'active',
    notes: null,
    voteWeight: 1,
    owners: [],
    ...overrides,
  };
}

describe('ProxiesManager', () => {
  it('shows an empty state when there are no proxies', async () => {
    mocked.fetchProxies.mockResolvedValue([]);
    render(<ProxiesManager />);
    expect(
      await screen.findByText(/no proxies recorded yet/i),
    ).toBeInTheDocument();
  });

  it('groups proxies under their meeting or election', async () => {
    mocked.fetchMeetings.mockResolvedValue([
      meeting({ id: 'm1', date: '2026-09-14', title: 'September meeting' }),
    ]);
    mocked.fetchElections.mockResolvedValue([
      election({
        id: 'e1',
        electionDate: '2026-01-15',
        title: 'Board Election 2026',
      }),
    ]);
    mocked.fetchProxies.mockResolvedValue([
      proxy({
        id: 'px1',
        propertyId: 'p1',
        address: '100 Main St',
        holderName: 'Alice Holder',
        meetingId: 'm1',
        electionId: null,
      }),
      proxy({
        id: 'px2',
        propertyId: 'p2',
        address: '200 Oak St',
        holderName: 'Bob Holder',
        meetingId: null,
        electionId: 'e1',
      }),
    ]);
    render(<ProxiesManager />);

    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: /2026-09-14.*september meeting/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: /2026-01-15.*board election 2026/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/alice holder/i)).toBeInTheDocument();
    expect(screen.getByText(/bob holder/i)).toBeInTheDocument();
  });

  it('creating a proxy posts propertyId, grantorOwnerId, holderName and the chosen occasion', async () => {
    mocked.fetchProxies.mockResolvedValue([]);
    mocked.fetchProperties.mockResolvedValue([
      property({
        id: 'p1',
        address: '100 Main St',
        owners: [
          {
            id: 'o1',
            propertyId: 'p1',
            fullName: 'Jane Doe',
            phone: null,
            email: null,
            status: 'active',
            notes: null,
          },
        ],
      }),
    ]);
    mocked.fetchMeetings.mockResolvedValue([
      meeting({ id: 'm1', date: '2026-09-14', title: 'September meeting' }),
    ]);
    mocked.saveProxy.mockResolvedValue(undefined);
    render(<ProxiesManager />);
    await screen.findByText(/no proxies recorded yet/i);

    await userEvent.selectOptions(screen.getByLabelText(/^property$/i), 'p1');
    await userEvent.selectOptions(screen.getByLabelText(/^grantor/i), 'o1');
    await userEvent.type(
      screen.getByLabelText(/proxy holder name/i),
      'Alice Holder',
    );
    await userEvent.selectOptions(screen.getByLabelText(/^meeting$/i), 'm1');
    await userEvent.click(screen.getByRole('button', { name: /^add proxy$/i }));

    await waitFor(() =>
      expect(mocked.saveProxy).toHaveBeenCalledWith({
        propertyId: 'p1',
        grantorOwnerId: 'o1',
        holderName: 'Alice Holder',
        holderOwnerId: null,
        meetingId: 'm1',
        electionId: null,
      }),
    );
    expect(await screen.findByText(/proxy recorded/i)).toBeInTheDocument();
  });

  it('delete asks for confirmation before calling deleteProxy', async () => {
    mocked.fetchMeetings.mockResolvedValue([
      meeting({ id: 'm1', date: '2026-09-14', title: 'September meeting' }),
    ]);
    mocked.fetchProxies.mockResolvedValue([
      proxy({
        id: 'px1',
        propertyId: 'p1',
        address: '100 Main St',
        holderName: 'Alice Holder',
        meetingId: 'm1',
      }),
    ]);
    render(<ProxiesManager />);
    await screen.findByText(/alice holder/i);

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await userEvent.click(
      screen.getByRole('button', { name: /delete proxy for 100 main st/i }),
    );
    expect(confirmSpy).toHaveBeenCalled();
    expect(mocked.deleteProxy).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    await userEvent.click(
      screen.getByRole('button', { name: /delete proxy for 100 main st/i }),
    );
    await waitFor(() => expect(mocked.deleteProxy).toHaveBeenCalledWith('px1'));
    confirmSpy.mockRestore();
  });

  it('occasion picker offers member meetings only, but board-meeting proxies still render in the list', async () => {
    mocked.fetchMeetings.mockResolvedValue([
      meeting({ id: 'm1', body: 'member', title: 'Annual meeting' }),
      meeting({ id: 'mB', body: 'board', title: 'Board session' }),
    ]);
    mocked.fetchProxies.mockResolvedValue([proxy({ meetingId: 'mB' })]);
    render(<ProxiesManager />);
    await waitFor(() =>
      expect(
        screen.getByRole('option', { name: /Annual meeting/ }),
      ).toBeInTheDocument(),
    );
    // The board meeting is not offered as a new-proxy occasion…
    expect(
      screen.queryByRole('option', { name: /Board session/ }),
    ).not.toBeInTheDocument();
    // …but the legacy proxy recorded against it still shows in the record list
    // (positive control that the filter is scoped to the picker).
    expect(screen.getByText(/Board session/)).toBeInTheDocument();
    expect(screen.getByText(/Alice Holder/)).toBeInTheDocument();
  });

  describe('inactive grantor warning', () => {
    // The route accepts an inactive grantor on purpose (historical paper
    // records), but the phase 3d grantor re-validation refuses the proxy
    // wherever it would be used — the panel says so at entry time.
    function grantorProperty() {
      return property({
        id: 'p1',
        address: '100 Main St',
        owners: [
          {
            id: 'o1',
            propertyId: 'p1',
            fullName: 'Jane Doe',
            phone: null,
            email: null,
            status: 'active' as const,
            notes: null,
          },
          {
            id: 'o2',
            propertyId: 'p1',
            fullName: 'Prior Owner',
            phone: null,
            email: null,
            status: 'inactive' as const,
            notes: null,
          },
        ],
      });
    }

    it('warns that the proxy would be born unusable when the grantor is inactive', async () => {
      mocked.fetchProxies.mockResolvedValue([]);
      mocked.fetchProperties.mockResolvedValue([grantorProperty()]);
      render(<ProxiesManager />);
      await screen.findByText(/no proxies recorded yet/i);

      await userEvent.selectOptions(screen.getByLabelText(/^property$/i), 'p1');
      await userEvent.selectOptions(screen.getByLabelText(/^grantor/i), 'o2');

      expect(
        await screen.findByText(
          /is not currently an active owner of this lot/i,
        ),
      ).toBeInTheDocument();
      // Entry is still allowed — the warning never disables the form.
      expect(
        screen.getByRole('button', { name: /^add proxy$/i }),
      ).not.toBeDisabled();
    });

    it('does not warn when the grantor is an active owner', async () => {
      mocked.fetchProxies.mockResolvedValue([]);
      mocked.fetchProperties.mockResolvedValue([grantorProperty()]);
      render(<ProxiesManager />);
      await screen.findByText(/no proxies recorded yet/i);

      await userEvent.selectOptions(screen.getByLabelText(/^property$/i), 'p1');
      await userEvent.selectOptions(screen.getByLabelText(/^grantor/i), 'o1');

      expect(
        screen.queryByText(/is not currently an active owner of this lot/i),
      ).not.toBeInTheDocument();
    });
  });

  describe('edit affordance', () => {
    // Owner requires the full seven-field shape (src/lib/types.ts:205).
    function owner(id: string, fullName: string) {
      return {
        id,
        propertyId: 'p1',
        fullName,
        phone: null,
        email: null,
        status: 'active' as const,
        notes: null,
      };
    }

    function setupEditFixtures() {
      mocked.fetchProperties.mockResolvedValue([
        property({
          id: 'p1',
          address: '100 Main St',
          owners: [owner('o1', 'Jane Doe'), owner('o2', 'John Roe')],
        }),
      ]);
      mocked.fetchMeetings.mockResolvedValue([meeting({ id: 'm1' })]);
      mocked.fetchProxies.mockResolvedValue([
        proxy({ id: 'px1', meetingId: 'm1' }),
      ]);
    }

    it('Edit loads the proxy, disables scope fields, and PATCHes only editable keys', async () => {
      const user = userEvent.setup();
      setupEditFixtures();
      mocked.saveProxy.mockResolvedValue();
      render(<ProxiesManager />);
      await user.click(
        await screen.findByRole('button', {
          name: 'Edit proxy for 100 Main St',
        }),
      );

      // Form is in edit mode with the proxy loaded…
      expect(screen.getByText('Edit Proxy')).toBeInTheDocument();
      expect(screen.getByLabelText('Proxy holder name')).toHaveValue(
        'Alice Holder',
      );
      // …and the non-editable fields are disabled (PATCH rejects them on key
      // presence — the UI must not even offer the change).
      expect(screen.getByLabelText('Occasion type')).toBeDisabled();
      expect(screen.getByLabelText('Meeting')).toBeDisabled();
      expect(screen.getByLabelText('Property')).toBeDisabled();
      expect(screen.getByLabelText('Grantor (owner)')).not.toBeDisabled();

      await user.clear(screen.getByLabelText('Proxy holder name'));
      await user.type(
        screen.getByLabelText('Proxy holder name'),
        'Bob Carrier',
      );
      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() =>
        expect(mocked.saveProxy).toHaveBeenCalledWith(
          {
            grantorOwnerId: 'o1',
            holderName: 'Bob Carrier',
            holderOwnerId: null,
          },
          'px1',
        ),
      );
    });

    it('Cancel returns the form to add mode', async () => {
      const user = userEvent.setup();
      setupEditFixtures();
      render(<ProxiesManager />);
      await user.click(
        await screen.findByRole('button', {
          name: 'Edit proxy for 100 Main St',
        }),
      );
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      // Title and submit button both read "Add Proxy" in add mode, so target
      // the button by role rather than getByText (which would multi-match).
      expect(
        screen.getByRole('button', { name: 'Add Proxy' }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText('Proxy holder name')).toHaveValue('');
      expect(screen.getByLabelText('Property')).not.toBeDisabled();
    });
  });
});
