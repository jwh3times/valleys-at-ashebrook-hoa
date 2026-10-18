import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { fetchDriveStatus, disconnectDrive } = vi.hoisted(() => ({
  fetchDriveStatus: vi.fn(),
  disconnectDrive: vi.fn(),
}));
vi.mock('../../lib/drive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/drive')>()),
  fetchDriveStatus: (...a: unknown[]) => fetchDriveStatus(...a),
  disconnectDrive: (...a: unknown[]) => disconnectDrive(...a),
}));

import DriveConnectionCard, { DriveStatusLine } from './DriveConnectionCard';

// #290 slice 2 (spec decision 8): the Drive connection card in Site Settings,
// and the one-line status System Administrators see above Documents.

const connected = (canManage: boolean) => ({
  configured: true,
  status: 'connected',
  canManage,
  googleEmail: 'association@example.test',
  connectedBy: 'sa-1',
  connectedByName: 'Sys Admin',
  connectedAt: Date.UTC(2026, 9, 18, 14),
  lastUsedAt: null,
  lastRefreshedAt: null,
  brokenAt: null,
});

beforeEach(() => {
  fetchDriveStatus.mockReset();
  disconnectDrive.mockReset();
  window.history.replaceState(null, '', '/admin');
});
afterEach(() => vi.restoreAllMocks());

describe('DriveConnectionCard', () => {
  it('renders nothing while the Drive import is not configured', async () => {
    fetchDriveStatus.mockResolvedValue(null);
    const { container } = render(<DriveConnectionCard />);
    await waitFor(() => expect(fetchDriveStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('offers a System Administrator a connect link when nothing is connected', async () => {
    fetchDriveStatus.mockResolvedValue({
      configured: true,
      status: 'none',
      canManage: true,
    });
    render(<DriveConnectionCard />);
    expect(await screen.findByText(/Not connected/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Connect Google Drive' }),
    ).toHaveAttribute('href', '/api/admin/drive/connect');
  });

  it('shows the connected account, with Reconnect and Disconnect', async () => {
    fetchDriveStatus.mockResolvedValue(connected(true));
    render(<DriveConnectionCard />);
    expect(
      await screen.findByText(/association@example\.test/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Sys Admin/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Reconnect' })).toHaveAttribute(
      'href',
      '/api/admin/drive/connect?reconnect=1',
    );
    expect(
      screen.getByRole('button', { name: 'Disconnect' }),
    ).toBeInTheDocument();
  });

  it('shows a board admin the status but no way to change it', async () => {
    fetchDriveStatus.mockResolvedValue(connected(false));
    render(<DriveConnectionCard />);
    await screen.findByText(/association@example\.test/);
    expect(screen.queryByRole('link', { name: /connect/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    expect(
      screen.getByText(/Only a System Administrator can/),
    ).toBeInTheDocument();
  });

  it('explains a broken connection', async () => {
    fetchDriveStatus.mockResolvedValue({
      ...connected(true),
      status: 'broken',
      brokenAt: Date.UTC(2026, 9, 18, 7),
    });
    render(<DriveConnectionCard />);
    expect(await screen.findByText(/stopped working/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('warns what Disconnect does, and does nothing when cancelled', async () => {
    fetchDriveStatus.mockResolvedValue(connected(true));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<DriveConnectionCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(confirm.mock.calls[0][0]).toMatch(/Documents already imported stay/);
    expect(confirm.mock.calls[0][0]).toMatch(/reconnecting the same account/);
    expect(disconnectDrive).not.toHaveBeenCalled();
  });

  it('gives the manual step when Google did not confirm the revoke', async () => {
    fetchDriveStatus.mockResolvedValueOnce(connected(true));
    fetchDriveStatus.mockResolvedValueOnce({
      configured: true,
      status: 'none',
      canManage: true,
    });
    disconnectDrive.mockResolvedValue({ revokeFailed: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<DriveConnectionCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(
      await screen.findByText(/Your connections to third-party apps/),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Not connected/)).toBeInTheDocument();
  });

  it('explains what happened when Google sends the browser back', async () => {
    window.history.replaceState(null, '', '/admin?drive=drive-not-granted');
    fetchDriveStatus.mockResolvedValue({
      configured: true,
      status: 'none',
      canManage: true,
    });
    render(<DriveConnectionCard />);
    expect(
      await screen.findByText(/didn't grant access to Google Drive/),
    ).toBeInTheDocument();
  });
});

describe('DriveStatusLine', () => {
  it('shows a System Administrator the connection status with a link to manage it', async () => {
    fetchDriveStatus.mockResolvedValue(connected(true));
    render(<DriveStatusLine />);
    expect(
      await screen.findByText(
        /Google Drive: connected as association@example\.test/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Manage the Google Drive connection' }),
    ).toHaveAttribute('href', '/admin?section=site');
  });

  it('shows nothing to a board admin who cannot manage it', async () => {
    fetchDriveStatus.mockResolvedValue(connected(false));
    const { container } = render(<DriveStatusLine />);
    await waitFor(() => expect(fetchDriveStatus).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
