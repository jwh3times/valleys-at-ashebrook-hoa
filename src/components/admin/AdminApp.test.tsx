import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));
vi.mock('../../lib/auth-client', () => ({
  authClient: {
    signOut: vi.fn().mockResolvedValue({}),
    signIn: { email: vi.fn().mockResolvedValue({ data: null, error: null }) },
    requestPasswordReset: vi
      .fn()
      .mockResolvedValue({ data: null, error: null }),
    useSession: vi.fn().mockReturnValue({ data: null, isPending: false }),
  },
}));
// Keep the manager tabs from making real API calls on mount.
vi.mock('../../lib/content', async (orig) => ({
  ...(await orig<typeof import('../../lib/content')>()),
  fetchAnnouncements: vi.fn().mockResolvedValue([]),
  fetchDocuments: vi.fn().mockResolvedValue([]),
}));

import AdminApp from './AdminApp';
import { useAuth } from './useAuth';

const fakeUser = { email: 'board@example.com', uid: 'abc' };

describe('AdminApp', () => {
  beforeEach(() => vi.mocked(useAuth).mockReset());

  it('shows a loading state while auth resolves', () => {
    vi.mocked(useAuth).mockReturnValue({
      loading: true,
      user: null,
      isAdmin: false,
    });
    render(<AdminApp />);
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
  });

  it('shows the login screen when signed out', () => {
    vi.mocked(useAuth).mockReturnValue({
      loading: false,
      user: null,
      isAdmin: false,
    });
    render(<AdminApp />);
    expect(
      screen.getByRole('heading', { name: /board login/i }),
    ).toBeInTheDocument();
  });

  it('blocks signed-in users who are not board admins', () => {
    vi.mocked(useAuth).mockReturnValue({
      loading: false,
      user: fakeUser,
      isAdmin: false,
    });
    render(<AdminApp />);
    expect(
      screen.getByRole('heading', { name: /not authorized/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('board@example.com')).toBeInTheDocument();
  });

  it('renders the admin dashboard with tabs for board admins', async () => {
    vi.mocked(useAuth).mockReturnValue({
      loading: false,
      user: fakeUser,
      isAdmin: true,
    });
    render(<AdminApp />);
    expect(
      screen.getByRole('heading', { name: /site admin/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Documents' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dues' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Site Settings' }),
    ).toBeInTheDocument();
    // Flush the announcements manager's initial load.
    expect(await screen.findByText('None yet.')).toBeInTheDocument();
  });

  it('offers a Meetings tab', () => {
    vi.mocked(useAuth).mockReturnValue({
      loading: false,
      user: fakeUser,
      isAdmin: true,
    });
    render(<AdminApp />);
    expect(
      screen.getByRole('button', { name: 'Meetings' }),
    ).toBeInTheDocument();
  });

  it('offers a Resolutions tab', () => {
    vi.mocked(useAuth).mockReturnValue({
      loading: false,
      user: fakeUser,
      isAdmin: true,
    });
    render(<AdminApp />);
    expect(
      screen.getByRole('button', { name: 'Resolutions' }),
    ).toBeInTheDocument();
  });

  it('offers an Elections tab', () => {
    vi.mocked(useAuth).mockReturnValue({
      loading: false,
      user: fakeUser,
      isAdmin: true,
    });
    render(<AdminApp />);
    expect(
      screen.getByRole('button', { name: 'Elections' }),
    ).toBeInTheDocument();
  });

  it('offers a Board access tab', () => {
    // #218 retired the separate "The Board" roster panel (BoardPanel), which
    // read/wrote the legacy board_people/board_terms tables through the now-
    // removed /api/admin/board-people and /api/admin/board-terms routes.
    // Board access (sign-in rank) is unaffected and still gets its own tab.
    vi.mocked(useAuth).mockReturnValue({
      loading: false,
      user: fakeUser,
      isAdmin: true,
    });
    render(<AdminApp />);
    expect(
      screen.getByRole('button', { name: 'Board access' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'The Board' }),
    ).not.toBeInTheDocument();
  });
});
