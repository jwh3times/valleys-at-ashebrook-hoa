import { useState } from 'react';
import { authClient } from '../../lib/auth-client';
import { useAuth } from './useAuth';
import Login from './Login';
import AnnouncementsManager from './AnnouncementsManager';
import DocumentsManager from './DocumentsManager';
import DuplicatesManager from './DuplicatesManager';
import DuesManager from './DuesManager';
import SiteManager from './SiteManager';
import RosterManager from './RosterManager';
import MembersManager from './MembersManager';
import BoardMembersManager from './BoardMembersManager';

const SECTIONS = [
  {
    key: 'announcements',
    label: 'Announcements',
    render: () => <AnnouncementsManager />,
  },
  { key: 'documents', label: 'Documents', render: () => <DocumentsManager /> },
  {
    key: 'duplicates',
    label: 'Duplicates',
    render: () => <DuplicatesManager />,
  },
  { key: 'roster', label: 'Roster', render: () => <RosterManager /> },
  { key: 'members', label: 'Members', render: () => <MembersManager /> },
  {
    key: 'board',
    label: 'Board members',
    render: () => <BoardMembersManager />,
  },
  { key: 'dues', label: 'Dues', render: () => <DuesManager /> },
  { key: 'site', label: 'Site Settings', render: () => <SiteManager /> },
] as const;

/** A centered card on the full-screen navy field (login / status screens). */
function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="admin-login">
      <span
        className="admin-login__plat admin-login__plat--a"
        aria-hidden="true"
      />
      <span
        className="admin-login__plat admin-login__plat--b"
        aria-hidden="true"
      />
      <div className="admin-login__inner">{children}</div>
    </div>
  );
}

export default function AdminApp() {
  const { loading, user, isAdmin } = useAuth();
  const [section, setSection] =
    useState<(typeof SECTIONS)[number]['key']>('announcements');

  if (loading) {
    return (
      <AuthShell>
        <p className="loading" style={{ color: '#fff', textAlign: 'center' }}>
          Loading…
        </p>
      </AuthShell>
    );
  }

  if (!user) return <Login />;

  if (!isAdmin) {
    return (
      <AuthShell>
        <div className="admin-login__card">
          <h1>Not authorized</h1>
          <p>
            You're signed in as <strong>{user.email as string}</strong>, but
            this account isn't on the board admin list. Ask the site
            administrator to add your account, then sign in again.
          </p>
          <button
            className="btn btn--outline"
            style={{ width: '100%', marginTop: '4px' }}
            onClick={() => authClient.signOut()}
          >
            Sign out
          </button>
        </div>
      </AuthShell>
    );
  }

  const active = SECTIONS.find((s) => s.key === section) ?? SECTIONS[0];

  return (
    <div className="admin-shell">
      <h1 className="sr-only">Site Admin</h1>
      <aside className="admin-side">
        <div className="admin-side__brand">
          <span className="mark mark--lg mark--inverse" aria-hidden="true">
            <i></i>
          </span>
          <span className="admin-side__brandtext">
            Ashebrook
            <br />
            <span>Admin</span>
          </span>
        </div>
        <div className="admin-side__label">Manage</div>
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            className={`admin-navbtn${s.key === section ? ' active' : ''}`}
            onClick={() => setSection(s.key)}
          >
            <span>{s.label}</span>
          </button>
        ))}
        <div className="admin-side__foot">
          <div className="lbl">Signed in as</div>
          <div className="who">{user.email as string}</div>
          <div className="acts">
            <a href="/">View site</a>
            <button onClick={() => authClient.signOut()}>Log out</button>
          </div>
        </div>
      </aside>

      <main className="admin-main">{active.render()}</main>
    </div>
  );
}
