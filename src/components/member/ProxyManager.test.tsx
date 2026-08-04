import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProxyManager from './ProxyManager';
import * as member from '../../lib/member';
import type {
  MemberLot,
  MemberProxyDetail,
  UpcomingOccasion,
} from '../../lib/types';

vi.mock('../../lib/member');
const mocked = vi.mocked(member);

const lots: MemberLot[] = [
  {
    id: 'p1',
    address: '1 Oak St',
    unit: null,
    owners: [
      { id: 'o1', fullName: 'Jane Doe' },
      { id: 'o1c', fullName: 'Co Owner' },
    ],
  },
];

const occasions: UpcomingOccasion[] = [
  {
    kind: 'meeting',
    id: 'm1',
    title: 'Annual meeting',
    date: '2026-09-01',
    seats: null,
  },
  {
    kind: 'election',
    id: 'e1',
    title: 'Board election',
    date: '2026-10-01',
    seats: 2,
  },
];

function proxyDetail(
  overrides: Partial<MemberProxyDetail> = {},
): MemberProxyDetail {
  return {
    id: 'px1',
    propertyId: 'p1',
    address: '1 Oak St',
    grantorOwnerId: 'o1',
    grantorName: 'Jane Doe',
    holderName: 'John Roe',
    holderOwnerId: 'o2',
    holderOwnerName: 'John Roe',
    meetingId: 'm1',
    electionId: null,
    occasionTitle: 'Annual meeting',
    occasionDate: '2026-09-01',
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.fetchMyProxies.mockResolvedValue({ granted: [], held: [] });
});

describe('ProxyManager', () => {
  it('shows empty states for both lists', async () => {
    render(<ProxyManager lots={lots} occasions={occasions} />);
    expect(await screen.findByText(/no proxies granted/i)).toBeInTheDocument();
    expect(screen.getByText(/not holding any proxies/i)).toBeInTheDocument();
  });

  it('looks up the holder by address and grants with the full payload', async () => {
    const user = userEvent.setup();
    mocked.lookupOwners.mockResolvedValue({
      propertyId: 'p2',
      address: '2 Oak St',
      owners: [{ id: 'o2', fullName: 'John Roe' }],
    });
    mocked.grantProxy.mockResolvedValue();
    render(<ProxyManager lots={lots} occasions={occasions} />);

    await user.selectOptions(await screen.findByLabelText('Your lot'), 'p1');
    await user.selectOptions(screen.getByLabelText('You are'), 'o1');
    await user.selectOptions(screen.getByLabelText('Occasion'), 'meeting:m1');
    await user.type(
      screen.getByLabelText("Holder's street address"),
      '2 Oak St',
    );
    await user.click(screen.getByRole('button', { name: 'Find owner' }));
    await waitFor(() => expect(mocked.lookupOwners).toHaveBeenCalled());
    await user.selectOptions(
      await screen.findByLabelText('Proxy holder'),
      'o2',
    );
    await user.click(screen.getByRole('button', { name: 'Grant proxy' }));

    await waitFor(() =>
      expect(mocked.grantProxy).toHaveBeenCalledWith({
        propertyId: 'p1',
        grantorOwnerId: 'o1',
        holderOwnerId: 'o2',
        meetingId: 'm1',
        electionId: null,
      }),
    );
    // Lists reload after a successful grant.
    expect(mocked.fetchMyProxies).toHaveBeenCalledTimes(2);
  });

  it('surfaces a lookup failure without crashing the form', async () => {
    const user = userEvent.setup();
    mocked.lookupOwners.mockRejectedValue(new Error('No matching property'));
    render(<ProxyManager lots={lots} occasions={occasions} />);
    await user.type(
      await screen.findByLabelText("Holder's street address"),
      '9 Nowhere Ln',
    );
    await user.click(screen.getByRole('button', { name: 'Find owner' }));
    expect(
      await screen.findByText(/no matching property/i),
    ).toBeInTheDocument();
  });

  it('renders granted and held lists and revokes a granted proxy', async () => {
    const user = userEvent.setup();
    mocked.fetchMyProxies.mockResolvedValue({
      granted: [proxyDetail()],
      held: [
        proxyDetail({
          id: 'px2',
          propertyId: 'p2',
          address: '2 Oak St',
          // Distinct from the granted row's holder ("John Roe") so the two
          // rendered <p> cards don't both match /John Roe/ and make
          // findByText ambiguous.
          grantorName: 'Pat Smith',
          holderName: 'Jane Doe',
          holderOwnerId: 'o1',
        }),
      ],
    });
    mocked.revokeProxy.mockResolvedValue();
    window.confirm = vi.fn(() => true);
    render(<ProxyManager lots={lots} occasions={occasions} />);
    expect(await screen.findByText(/John Roe/)).toBeInTheDocument();
    expect(screen.getByText(/2 Oak St/)).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Revoke proxy for 1 Oak St' }),
    );
    await waitFor(() => expect(mocked.revokeProxy).toHaveBeenCalledWith('px1'));
  });

  it('grants an election proxy with only electionId set', async () => {
    const user = userEvent.setup();
    mocked.lookupOwners.mockResolvedValue({
      propertyId: 'p2',
      address: '2 Oak St',
      owners: [{ id: 'o2', fullName: 'John Roe' }],
    });
    mocked.grantProxy.mockResolvedValue();
    render(<ProxyManager lots={lots} occasions={occasions} />);

    await user.selectOptions(await screen.findByLabelText('Your lot'), 'p1');
    await user.selectOptions(screen.getByLabelText('You are'), 'o1');
    await user.selectOptions(screen.getByLabelText('Occasion'), 'election:e1');
    await user.type(
      screen.getByLabelText("Holder's street address"),
      '2 Oak St',
    );
    await user.click(screen.getByRole('button', { name: 'Find owner' }));
    await user.selectOptions(
      await screen.findByLabelText('Proxy holder'),
      'o2',
    );
    await user.click(screen.getByRole('button', { name: 'Grant proxy' }));

    await waitFor(() =>
      expect(mocked.grantProxy).toHaveBeenCalledWith({
        propertyId: 'p1',
        grantorOwnerId: 'o1',
        holderOwnerId: 'o2',
        meetingId: null,
        electionId: 'e1',
      }),
    );
  });

  it('shows a load error instead of false empty states when initial loading fails', async () => {
    mocked.fetchMyProxies.mockRejectedValue(new Error('Network unavailable'));
    render(<ProxyManager lots={lots} occasions={occasions} />);

    expect(
      await screen.findAllByText(
        "Couldn't load your proxies — reload the page to try again.",
      ),
    ).toHaveLength(2);
    expect(screen.queryByText('No proxies granted.')).not.toBeInTheDocument();
    expect(
      screen.queryByText('You are not holding any proxies.'),
    ).not.toBeInTheDocument();
  });

  it('keeps the lot selected and clears the occasion after a successful grant', async () => {
    const user = userEvent.setup();
    mocked.lookupOwners.mockResolvedValue({
      propertyId: 'p2',
      address: '2 Oak St',
      owners: [{ id: 'o2', fullName: 'John Roe' }],
    });
    mocked.grantProxy.mockResolvedValue();
    render(<ProxyManager lots={lots} occasions={occasions} />);

    await user.selectOptions(await screen.findByLabelText('Your lot'), 'p1');
    await user.selectOptions(screen.getByLabelText('You are'), 'o1');
    await user.selectOptions(screen.getByLabelText('Occasion'), 'meeting:m1');
    await user.type(
      screen.getByLabelText("Holder's street address"),
      '2 Oak St',
    );
    await user.click(screen.getByRole('button', { name: 'Find owner' }));
    await user.selectOptions(
      await screen.findByLabelText('Proxy holder'),
      'o2',
    );
    await user.click(screen.getByRole('button', { name: 'Grant proxy' }));

    expect(await screen.findByText('Proxy granted.')).toBeInTheDocument();
    expect(screen.getByLabelText('Your lot')).toHaveValue('p1');
    expect(screen.getByLabelText('Occasion')).toHaveValue('');
  });
});
