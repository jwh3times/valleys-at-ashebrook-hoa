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
    },
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
});
