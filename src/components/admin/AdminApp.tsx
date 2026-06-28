import { useState } from 'react';
import { signOut } from 'firebase/auth';
import { getFirebaseAuth, isFirebaseConfigured } from '../../lib/firebase';
import { useAuth } from './useAuth';
import Login from './Login';
import AnnouncementsManager from './AnnouncementsManager';
import DocumentsManager from './DocumentsManager';
import DuesManager from './DuesManager';
import SiteManager from './SiteManager';

const TABS = [
  {
    key: 'announcements',
    label: 'Announcements',
    render: () => <AnnouncementsManager />,
  },
  { key: 'documents', label: 'Documents', render: () => <DocumentsManager /> },
  { key: 'dues', label: 'Dues', render: () => <DuesManager /> },
  { key: 'site', label: 'Site Settings', render: () => <SiteManager /> },
] as const;

export default function AdminApp() {
  const { loading, user, isAdmin } = useAuth();
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('announcements');

  if (!isFirebaseConfigured) {
    return (
      <div className="notice">
        <strong>Setup needed:</strong> Firebase isn’t configured. Add your
        Firebase project values to <code>.env</code> before using the admin (see{' '}
        <code>SETUP.md</code>).
      </div>
    );
  }

  if (loading) return <p className="loading">Loading…</p>;

  if (!user) return <Login />;

  if (!isAdmin) {
    return (
      <div className="login-box card">
        <h1 style={{ marginTop: 0 }}>Not authorized</h1>
        <p>
          You’re signed in as <strong>{user.email}</strong>, but this account
          isn’t on the board admin list. Ask the site administrator to add your
          account, then sign in again.
        </p>
        <button
          className="btn btn--outline"
          onClick={() => signOut(getFirebaseAuth())}
        >
          Sign out
        </button>
      </div>
    );
  }

  const active = TABS.find((t) => t.key === tab) ?? TABS[0];

  return (
    <div className="admin-shell">
      <div className="admin-bar">
        <h1 style={{ margin: 0 }}>Board Admin</h1>
        <div>
          <span className="muted" style={{ marginRight: '0.75rem' }}>
            {user.email}
          </span>
          <button
            className="btn btn--outline btn--small"
            onClick={() => signOut(getFirebaseAuth())}
          >
            Sign out
          </button>
        </div>
      </div>

      <div className="admin-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={t.key === tab ? 'active' : ''}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {active.render()}
    </div>
  );
}
