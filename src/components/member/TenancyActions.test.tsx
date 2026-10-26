import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TenancyActions from './TenancyActions';
import * as member from '../../lib/member';

vi.mock('../../lib/member');
const mocked = vi.mocked(member);

const realLocation = window.location;
const assign = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
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

const tenancy = {
  kind: 'tenancy',
  tenancyId: 'ten-1',
  tenantName: 'Tess Tenant',
  address: '100 Example Lane',
  renew: { minEndDay: '2027-01-02', maxEndDay: '2028-02-01' },
  reinvite: true,
} as const;

describe('TenancyActions', () => {
  it('ends a tenancy after confirming, then reloads the page saying so', async () => {
    render(<TenancyActions {...tenancy} />);
    await userEvent.click(
      screen.getByRole('button', {
        name: 'End tenancy: Tess Tenant, 100 Example Lane',
      }),
    );
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() =>
      expect(mocked.tenancyAction).toHaveBeenCalledWith({
        action: 'end',
        tenancyId: 'ten-1',
      }),
    );
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('/tenants?done=end'),
    );
  });

  it('does nothing when the end is not confirmed', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    render(<TenancyActions {...tenancy} />);
    await userEvent.click(
      screen.getByRole('button', {
        name: 'End tenancy: Tess Tenant, 100 Example Lane',
      }),
    );
    expect(mocked.tenancyAction).not.toHaveBeenCalled();
  });

  it('asks for a new end day within the renewal’s bounds', async () => {
    render(<TenancyActions {...tenancy} />);
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', {
        name: 'Renew tenancy: Tess Tenant, 100 Example Lane',
      }),
    );
    const until = screen.getByLabelText('Renew until');
    expect(until).toHaveAttribute('min', '2027-01-02');
    expect(until).toHaveAttribute('max', '2028-02-01');
    await user.type(until, '2028-01-01');
    await user.click(screen.getByRole('button', { name: 'Ask to renew' }));
    await waitFor(() =>
      expect(mocked.tenancyAction).toHaveBeenCalledWith({
        action: 'renew',
        tenancyId: 'ten-1',
        scheduledEndDay: '2028-01-01',
      }),
    );
  });

  it('offers no Renew for a tenancy that cannot be renewed', () => {
    render(<TenancyActions {...tenancy} renew={null} />);
    expect(
      screen.queryByRole('button', { name: /Renew tenancy/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'End tenancy: Tess Tenant, 100 Example Lane',
      }),
    ).toBeInTheDocument();
  });

  it('sends a fresh invitation to a tenant who has not claimed, then reloads saying so', async () => {
    render(<TenancyActions {...tenancy} />);
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Re-invite tenant: Tess Tenant, 100 Example Lane',
      }),
    );
    await waitFor(() =>
      expect(mocked.tenancyAction).toHaveBeenCalledWith({
        action: 'reinvite',
        tenancyId: 'ten-1',
      }),
    );
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('/tenants?done=reinvite'),
    );
  });

  it('offers no Re-invite once the tenant has claimed, or while tenant access is off', () => {
    render(<TenancyActions {...tenancy} reinvite={false} />);
    expect(
      screen.queryByRole('button', { name: /Re-invite tenant/ }),
    ).not.toBeInTheDocument();
  });

  it('withdraws an open request', async () => {
    render(
      <TenancyActions
        kind="request"
        requestId="req-1"
        tenantName="Ned Next"
        address="100 Example Lane"
      />,
    );
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Withdraw tenancy request: Ned Next, 100 Example Lane',
      }),
    );
    await waitFor(() =>
      expect(mocked.tenancyAction).toHaveBeenCalledWith({
        action: 'withdraw',
        requestId: 'req-1',
      }),
    );
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('/tenants?done=withdraw'),
    );
  });

  it('shows the server’s reason and stays on the page when an action fails', async () => {
    mocked.tenancyAction.mockRejectedValue(
      new Error('Tenancy already ended or voided'),
    );
    render(<TenancyActions {...tenancy} />);
    await userEvent.click(
      screen.getByRole('button', {
        name: 'End tenancy: Tess Tenant, 100 Example Lane',
      }),
    );
    expect(
      await screen.findByText('Error: Tenancy already ended or voided'),
    ).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });
});
