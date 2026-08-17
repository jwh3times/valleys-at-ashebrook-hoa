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
import RosterAdminPanel from './RosterAdminPanel';
import BoardServicePanel from './BoardServicePanel';
import AccessPanel from './AccessPanel';
import ReviewPanel from './ReviewPanel';
import CompliancePanel from './CompliancePanel';
import MembersManager from './MembersManager';
import BoardAccessManager from './BoardAccessManager';
import MeetingsManager from './MeetingsManager';
import ResolutionsManager from './ResolutionsManager';
import ElectionsManager from './ElectionsManager';
import ProxiesManager from './ProxiesManager';
import AssistantChat from './AssistantChat';
import ReportsManager from './ReportsManager';

const SECTIONS = [
  {
    key: 'announcements',
    label: 'Announcements',
    render: () => <AnnouncementsManager />,
  },
  { key: 'documents', label: 'Documents', render: () => <DocumentsManager /> },
  { key: 'assistant', label: 'Assistant', render: () => <AssistantChat /> },
  { key: 'reports', label: 'Reports', render: () => <ReportsManager /> },
  {
    key: 'duplicates',
    label: 'Duplicates',
    render: () => <DuplicatesManager />,
  },
  // The legacy homes+owners editor. Writable and authoritative until the ADR
  // 0022 flip; retired in phase 4 (#212).
  {
    key: 'roster',
    label: 'Homes & owners (legacy)',
    render: () => <RosterManager />,
  },
  // ADR 0022 phase 3e (#221): the five writable surfaces over the party
  // roster, per #205's taxonomy. They replace the phase-2 read-only preview;
  // in production their writes stay held by the operator write freeze until
  // the flip's authoritative backfill has run (#222 owns the sequencing).
  {
    key: 'party-roster',
    label: 'Roster',
    render: () => <RosterAdminPanel />,
  },
  {
    key: 'board-service',
    label: 'Board',
    render: () => <BoardServicePanel />,
  },
  { key: 'access', label: 'Access', render: () => <AccessPanel /> },
  { key: 'review', label: 'Review', render: () => <ReviewPanel /> },
  {
    key: 'compliance',
    label: 'Compliance',
    render: () => <CompliancePanel />,
  },
  { key: 'members', label: 'Members', render: () => <MembersManager /> },
  {
    key: 'meetings',
    label: 'Meetings',
    render: () => <MeetingsManager />,
  },
  {
    key: 'resolutions',
    label: 'Resolutions',
    render: () => <ResolutionsManager />,
  },
  {
    key: 'elections',
    label: 'Elections',
    render: () => <ElectionsManager />,
  },
  {
    key: 'proxies',
    label: 'Proxies',
    render: () => <ProxiesManager />,
  },
  {
    // Legacy site sign-in access (users.role). Its buttons drive the
    // re-pointed /api/admin/roles, so it acts on whichever model cutover_mode
    // says is live; the Access panel above is the grant-level surface.
    // Retired in phase 4 (#212).
    key: 'board',
    label: 'Board access (legacy)',
    render: () => <BoardAccessManager />,
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
