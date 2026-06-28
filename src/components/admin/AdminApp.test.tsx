import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { User } from 'firebase/auth';

vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));
vi.mock('../../lib/firebase', () => ({
  isFirebaseConfigured: true,
  getFirebaseAuth: vi.fn(() => ({})),
}));
vi.mock('firebase/auth', () => ({
  signOut: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
}));
// Keep the manager tabs from touching Firestore on mount.
vi.mock('../../lib/content', async (orig) => ({
  ...(await orig<typeof import('../../lib/content')>()),
  fetchAnnouncements: vi.fn().mockResolvedValue([]),
  fetchDocuments: vi.fn().mockResolvedValue([]),
}));

import AdminApp from './AdminApp';
import { useAuth } from './useAuth';

const fakeUser = { email: 'board@example.com', uid: 'abc' } as User;

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
      screen.getByRole('heading', { name: /board admin/i }),
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
});
