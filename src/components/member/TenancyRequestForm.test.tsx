import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TenancyRequestForm from './TenancyRequestForm';
import * as member from '../../lib/member';

vi.mock('../../lib/member');
const mocked = vi.mocked(member);

const realLocation = window.location;
const assign = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  mocked.tenancyAction.mockResolvedValue(undefined);
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { assign },
  });
});
afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: realLocation,
  });
});

const lots = [
  { lotId: 'lot-1', address: '100 Example Lane' },
  { lotId: 'lot-2', address: '102 Example Lane' },
];

describe('TenancyRequestForm', () => {
  it('limits the contact to the roster’s length for the chosen channel', async () => {
    render(
      <TenancyRequestForm
        lots={lots}
        minEndDay="2026-10-26"
        maxEndDay="2027-11-25"
      />,
    );
    expect(screen.getByLabelText('Email address')).toHaveAttribute(
      'maxLength',
      '320',
    );
    await userEvent
      .setup()
      .selectOptions(screen.getByLabelText('Contact by'), 'sms');
    expect(screen.getByLabelText('Mobile number')).toHaveAttribute(
      'maxLength',
      '32',
    );
  });

  it('requests a tenant for the chosen Lot, then reloads the page saying so', async () => {
    render(
      <TenancyRequestForm
        lots={lots}
        minEndDay="2026-10-26"
        maxEndDay="2027-11-25"
      />,
    );
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Lot'), 'lot-2');
    await user.type(screen.getByLabelText('Tenant’s full name'), 'Sam New');
    await user.selectOptions(screen.getByLabelText('Contact by'), 'sms');
    await user.type(screen.getByLabelText('Mobile number'), '555-555-0142');
    await user.type(screen.getByLabelText('Access ends on'), '2027-08-01');
    await user.click(screen.getByRole('button', { name: 'Ask the board' }));
    await waitFor(() =>
      expect(mocked.tenancyAction).toHaveBeenCalledWith({
        action: 'request',
        lotId: 'lot-2',
        tenantName: 'Sam New',
        channel: 'sms',
        contact: '555-555-0142',
        scheduledEndDay: '2027-08-01',
      }),
    );
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('/tenants?done=request'),
    );
  });

  it('bounds the end day to after today and the latest allowed', () => {
    render(
      <TenancyRequestForm
        lots={lots.slice(0, 1)}
        minEndDay="2026-10-26"
        maxEndDay="2027-11-25"
      />,
    );
    const end = screen.getByLabelText('Access ends on');
    expect(end).toHaveAttribute('min', '2026-10-26');
    expect(end).toHaveAttribute('max', '2027-11-25');
    // One Lot needs no picker.
    expect(screen.queryByLabelText('Lot')).not.toBeInTheDocument();
  });

  it('shows the server’s reason when the request is refused', async () => {
    mocked.tenancyAction.mockRejectedValue(
      new Error(
        'There is already an open request for this contact on this Lot',
      ),
    );
    render(
      <TenancyRequestForm
        lots={lots.slice(0, 1)}
        minEndDay="2026-10-26"
        maxEndDay="2027-11-25"
      />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Tenant’s full name'), 'Sam New');
    await user.type(screen.getByLabelText('Email address'), 'sam@example.test');
    await user.type(screen.getByLabelText('Access ends on'), '2027-08-01');
    await user.click(screen.getByRole('button', { name: 'Ask the board' }));
    expect(
      await screen.findByText(
        'Error: There is already an open request for this contact on this Lot',
      ),
    ).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });
});
