# Roster Admin UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two admin sections — Roster (home-centric CRUD over `/api/admin/{properties,owners}`) and Members (approval-queue + revoke over `/api/admin/members`) — plus a small `members` GET email join, so the board manages the person-per-home roster and homeowner access from `/admin`.

**Architecture:** Two new React manager components following the existing AdminApp pattern (component per section; reads via a `lib` helper, writes via `lib/admin.ts`; shared `admin-panel`/`panel-card`/`list-row` classes; soft-delete via `status`). Thin board-only fetch helpers in `lib/admin.ts`, new shapes in `lib/types.ts`, and a `users` left-join in the members GET so queue rows carry the requester email.

**Tech Stack:** Astro SSR + React 19 on Cloudflare Workers, D1 via Drizzle, Vitest + @testing-library/react (jsdom) for component tests, `@cloudflare/vitest-pool-workers` for server tests.

## Global Constraints

- Route handlers: `import { env } from 'cloudflare:workers'` + `export const prerender = false`. Board-only via `requireBoard(request, env)` first; fail-closed.
- Worker/D1 tests import `{ env, applyD1Migrations }` from `cloudflare:test`; `applyD1Migrations(env.DATABASE, env.MIGRATIONS!)` in `beforeAll`; run via `--config vitest.workers.config.ts`. To simulate a board caller, `vi.mock('../../src/server/authz/context', () => ({ getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }) }))`.
- jsdom component tests live beside the component as `*.test.tsx`, run by `npm test`; mock `../../lib/admin` and `../../lib/content` helpers with `vi.mock`; use `@testing-library/react` (`render`, `screen`, `fireEvent`, `waitFor`).
- Soft-delete only: deactivate = `PATCH { status: 'inactive' }`; nothing is hard-deleted.
- Phones are E.164 (`+1XXXXXXXXXX`) — the owner form accepts what the board types (no client reformatting).
- Timestamps arrive as ISO strings; format with `lib/format` `formatDate`.
- CI gates: `format:check`, `check` (0 errors), `test`, `test:server`, `build`. Run `npm run format` before every commit; end commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Spec: `docs/superpowers/specs/2026-07-02-roster-admin-ui-design.md`.

---

### Task 1: Types + board-only client helpers

**Files:**

- Modify: `src/lib/types.ts` (append new shapes)
- Modify: `src/lib/admin.ts` (append helpers)

**Interfaces:**

- Produces (types): `PropertyWithOwners`, `ManualApprovalItem`, `MemberUser`, `MembersView` (uses existing `Property`, `Owner`).
- Produces (helpers): `fetchProperties(): Promise<PropertyWithOwners[]>`, `saveProperty(data, id?): Promise<void>`, `saveOwner(data, id?): Promise<void>`, `fetchMembers(): Promise<MembersView>`, `memberAction(payload): Promise<void>`.

- [ ] **Step 1: Add shapes to `src/lib/types.ts`**

Append (after the existing `Owner` interface):

```ts
export type PropertyWithOwners = Property & { owners: Owner[] };

export interface MemberUser {
  id: string;
  name: string;
  email: string;
  createdAt: string; // ISO
}

export interface ManualApprovalItem {
  id: string;
  userId: string;
  email: string | null;
  claimedAddress: string;
  reason: string;
  status: string;
  createdAt: string; // ISO
}

export interface MembersView {
  recent: MemberUser[];
  queue: ManualApprovalItem[];
}
```

- [ ] **Step 2: Add helpers to `src/lib/admin.ts`**

Append at the end of the file. Add the type import to the existing top-of-file import from `./types` (it currently imports `Announcement, DuesSettings, SiteSettings`):

```ts
import type {
  Announcement,
  DuesSettings,
  SiteSettings,
  PropertyWithOwners,
  MembersView,
} from './types';
```

Then append:

```ts
// ---------- Roster (board-only reads + writes) ----------
export async function fetchProperties(): Promise<PropertyWithOwners[]> {
  const res = await fetch('/api/admin/properties');
  if (!res.ok) throw new Error(`Load homes failed: ${res.status}`);
  return res.json();
}

export async function saveProperty(
  data: {
    address?: string;
    unit?: string | null;
    notes?: string | null;
    status?: 'active' | 'inactive';
  },
  id?: string,
): Promise<void> {
  const res = await fetch('/api/admin/properties', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(id ? { id, ...data } : data),
  });
  if (!res.ok) throw new Error(`Save home failed: ${res.status}`);
}

export async function saveOwner(
  data: {
    propertyId?: string;
    fullName?: string;
    phone?: string | null;
    email?: string | null;
    notes?: string | null;
    status?: 'active' | 'inactive';
  },
  id?: string,
): Promise<void> {
  const res = await fetch('/api/admin/owners', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(id ? { id, ...data } : data),
  });
  if (!res.ok) throw new Error(`Save owner failed: ${res.status}`);
}

// ---------- Members / access ----------
export async function fetchMembers(): Promise<MembersView> {
  const res = await fetch('/api/admin/members');
  if (!res.ok) throw new Error(`Load members failed: ${res.status}`);
  return res.json();
}

export async function memberAction(payload: {
  action: 'approve' | 'deny' | 'revoke';
  userId?: string;
  queueId?: string;
  propertyId?: string;
}): Promise<void> {
  const res = await fetch('/api/admin/members', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Action failed: ${res.status}`);
}
```

- [ ] **Step 3: Verify type-check**

Run: `npm run check`
Expected: 0 errors. (These helpers are exercised by the component tests in Tasks 3–4, which mock `lib/admin`; there is no direct unit test — consistent with the existing `saveSite`/`saveAnnouncement` helpers.)

- [ ] **Step 4: Format + commit**

Run: `npm run format`

```bash
git add src/lib/types.ts src/lib/admin.ts
git commit -m "feat: roster/members admin types + client helpers"
```

---

### Task 2: `GET /api/admin/members` — email join

**Files:**

- Modify: `src/pages/api/admin/members.ts` (the GET query)
- Test: `test/server/admin-members.test.ts` (create)

**Interfaces:**

- Consumes: nothing new.
- Produces: `GET /api/admin/members` `queue[]` rows now include `email: string | null` alongside `id, userId, claimedAddress, reason, status, createdAt`.

- [ ] **Step 1: Write the failing server test**

Create `test/server/admin-members.test.ts`:

```ts
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { GET } from '../../src/pages/api/admin/members';
import { getDb } from '../../src/server/db/client';
import { manualApprovalQueue, users } from '../../src/server/db/schema';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

describe('admin members GET', () => {
  it('joins the requester email onto each pending queue row', async () => {
    const db = getDb(env);
    const now = new Date();
    await db.insert(users).values({
      id: 'u-q',
      name: 'Queued User',
      email: 'queued@example.com',
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(manualApprovalQueue).values({
      id: 'q-1',
      userId: 'u-q',
      claimedAddress: '1 Test St',
      reason: 'address not found',
      status: 'pending',
      createdAt: now,
    });

    const res = await GET({
      request: new Request('http://localhost/api/admin/members'),
    } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      queue: { id: string; email: string | null; claimedAddress: string }[];
    };
    const row = body.queue.find((q) => q.id === 'q-1');
    expect(row).toBeDefined();
    expect(row!.email).toBe('queued@example.com');
    expect(row!.claimedAddress).toBe('1 Test St');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --config vitest.workers.config.ts test/server/admin-members.test.ts`
Expected: FAIL — the current GET returns raw `manualApprovalQueue` rows with no `email` field, so `row!.email` is `undefined`, not `'queued@example.com'`.

- [ ] **Step 3: Add the join in `src/pages/api/admin/members.ts`**

Replace the `queue` query in the `GET` handler (it currently is `db.select().from(manualApprovalQueue).where(...).orderBy(...)`) with an explicit projection + left join. `users`, `eq`, `desc` are already imported in this file.

```ts
const queue = await db
  .select({
    id: manualApprovalQueue.id,
    userId: manualApprovalQueue.userId,
    email: users.email,
    claimedAddress: manualApprovalQueue.claimedAddress,
    reason: manualApprovalQueue.reason,
    status: manualApprovalQueue.status,
    createdAt: manualApprovalQueue.createdAt,
  })
  .from(manualApprovalQueue)
  .leftJoin(users, eq(manualApprovalQueue.userId, users.id))
  .where(eq(manualApprovalQueue.status, 'pending'))
  .orderBy(desc(manualApprovalQueue.createdAt));
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --config vitest.workers.config.ts test/server/admin-members.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

Run: `npm run check && npm run test:server && npm run build`

```bash
npm run format
git add src/pages/api/admin/members.ts test/server/admin-members.test.ts
git commit -m "feat: include requester email on admin members queue rows"
```

---

### Task 3: RosterManager section

**Files:**

- Create: `src/components/admin/RosterManager.tsx`
- Modify: `src/components/admin/AdminApp.tsx` (import + SECTIONS entry)
- Test: `src/components/admin/RosterManager.test.tsx` (create)

**Interfaces:**

- Consumes: `fetchProperties`, `saveProperty`, `saveOwner` (Task 1); `PropertyWithOwners`, `Owner` types.
- Produces: default-exported `RosterManager` React component; a `roster` entry in AdminApp `SECTIONS`.

- [ ] **Step 1: Write the failing component test**

Create `src/components/admin/RosterManager.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchProperties = vi.fn();
const saveProperty = vi.fn().mockResolvedValue(undefined);
const saveOwner = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/admin', () => ({
  fetchProperties: (...a: unknown[]) => fetchProperties(...a),
  saveProperty: (...a: unknown[]) => saveProperty(...a),
  saveOwner: (...a: unknown[]) => saveOwner(...a),
}));

import RosterManager from './RosterManager';

const HOME = {
  id: 'p1',
  address: '1 Test St',
  unit: null,
  status: 'active' as const,
  notes: null,
  owners: [
    {
      id: 'o1',
      propertyId: 'p1',
      fullName: 'Jane Doe',
      phone: '+15551234567',
      email: 'jane@x.com',
      status: 'active' as const,
      notes: null,
    },
  ],
};

beforeEach(() => {
  fetchProperties.mockReset().mockResolvedValue([HOME]);
  saveProperty.mockClear();
  saveOwner.mockClear();
});

describe('RosterManager', () => {
  it('renders homes with their owners', async () => {
    render(<RosterManager />);
    expect(await screen.findByText('1 Test St')).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
  });

  it('adds an owner to a home with the correct propertyId', async () => {
    render(<RosterManager />);
    fireEvent.click(
      await screen.findByRole('button', { name: /add owner to/i }),
    );
    fireEvent.change(screen.getByLabelText(/full name/i), {
      target: { value: 'John Roe' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^add owner$/i }));
    await waitFor(() => expect(saveOwner).toHaveBeenCalledTimes(1));
    expect(saveOwner.mock.calls[0][0]).toMatchObject({
      propertyId: 'p1',
      fullName: 'John Roe',
    });
    expect(saveOwner.mock.calls[0][1]).toBeUndefined(); // create (no id)
  });

  it('deactivates an owner via a status PATCH', async () => {
    render(<RosterManager />);
    await screen.findByText('Jane Doe');
    fireEvent.click(screen.getByRole('button', { name: /deactivate owner/i }));
    await waitFor(() => expect(saveOwner).toHaveBeenCalledTimes(1));
    expect(saveOwner.mock.calls[0][0]).toMatchObject({ status: 'inactive' });
    expect(saveOwner.mock.calls[0][1]).toBe('o1'); // patch by id
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/admin/RosterManager.test.tsx`
Expected: FAIL — module `./RosterManager` does not exist.

- [ ] **Step 3: Create `src/components/admin/RosterManager.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { fetchProperties, saveProperty, saveOwner } from '../../lib/admin';
import type { PropertyWithOwners, Owner } from '../../lib/types';

const emptyHome = { address: '', unit: '', notes: '' };
const emptyOwner = { fullName: '', phone: '', email: '', notes: '' };
type Status = 'active' | 'inactive';

export default function RosterManager() {
  const [homes, setHomes] = useState<PropertyWithOwners[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const [homeForm, setHomeForm] = useState(emptyHome);
  const [homeStatus, setHomeStatus] = useState<Status>('active');
  const [editingHomeId, setEditingHomeId] = useState<string | null>(null);

  const [ownerForm, setOwnerForm] = useState(emptyOwner);
  const [ownerStatus, setOwnerStatus] = useState<Status>('active');
  const [ownerPropertyId, setOwnerPropertyId] = useState<string | null>(null);
  const [editingOwnerId, setEditingOwnerId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setHomes(await fetchProperties());
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  function resetHome() {
    setEditingHomeId(null);
    setHomeForm(emptyHome);
    setHomeStatus('active');
  }
  function resetOwner() {
    setEditingOwnerId(null);
    setOwnerPropertyId(null);
    setOwnerForm(emptyOwner);
    setOwnerStatus('active');
  }
  function toTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function startEditHome(h: PropertyWithOwners) {
    resetOwner();
    setEditingHomeId(h.id);
    setHomeForm({
      address: h.address,
      unit: h.unit ?? '',
      notes: h.notes ?? '',
    });
    setHomeStatus(h.status);
    setMsg('');
    toTop();
  }
  function startAddOwner(propertyId: string) {
    resetOwner();
    setOwnerPropertyId(propertyId);
    setMsg('');
    toTop();
  }
  function startEditOwner(o: Owner) {
    setEditingOwnerId(o.id);
    setOwnerPropertyId(o.propertyId);
    setOwnerForm({
      fullName: o.fullName,
      phone: o.phone ?? '',
      email: o.email ?? '',
      notes: o.notes ?? '',
    });
    setOwnerStatus(o.status);
    setMsg('');
    toTop();
  }

  async function submitHome(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      await saveProperty(
        {
          address: homeForm.address,
          unit: homeForm.unit || null,
          notes: homeForm.notes || null,
          ...(editingHomeId ? { status: homeStatus } : {}),
        },
        editingHomeId ?? undefined,
      );
      setMsg(editingHomeId ? 'Home updated.' : 'Home added.');
      resetHome();
      await load();
    } catch (err: any) {
      setMsg('Error: ' + (err?.message ?? 'could not save.'));
    } finally {
      setBusy(false);
    }
  }

  async function submitOwner(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      await saveOwner(
        editingOwnerId
          ? {
              fullName: ownerForm.fullName,
              phone: ownerForm.phone || null,
              email: ownerForm.email || null,
              notes: ownerForm.notes || null,
              status: ownerStatus,
            }
          : {
              propertyId: ownerPropertyId ?? undefined,
              fullName: ownerForm.fullName,
              phone: ownerForm.phone || null,
              email: ownerForm.email || null,
              notes: ownerForm.notes || null,
            },
        editingOwnerId ?? undefined,
      );
      setMsg(editingOwnerId ? 'Owner updated.' : 'Owner added.');
      resetOwner();
      await load();
    } catch (err: any) {
      setMsg('Error: ' + (err?.message ?? 'could not save.'));
    } finally {
      setBusy(false);
    }
  }

  async function toggleHome(h: PropertyWithOwners) {
    await saveProperty(
      { status: h.status === 'active' ? 'inactive' : 'active' },
      h.id,
    );
    await load();
  }
  async function toggleOwner(o: Owner) {
    await saveOwner(
      { status: o.status === 'active' ? 'inactive' : 'active' },
      o.id,
    );
    await load();
  }

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Roster</h1>
      </div>
      <p className="admin-panel__intro">
        Homes and their owners. Verification matches a home by address and sends
        the code to every contact on that home. Deactivating a home or owner
        revokes their access without deleting the record.
      </p>

      {msg && <div className="form-message form-message--success">{msg}</div>}

      <form
        className="panel-card"
        onSubmit={submitHome}
        style={{ marginBottom: '18px' }}
      >
        <div className="panel-editor__title">
          {editingHomeId ? 'Edit Home' : 'Add Home'}
        </div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="home-address">Address</label>
            <input
              id="home-address"
              type="text"
              value={homeForm.address}
              onChange={(e) =>
                setHomeForm({ ...homeForm, address: e.target.value })
              }
              placeholder="123 Example Dr Raleigh, NC 27603"
              required
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="home-unit">Unit (optional)</label>
            <input
              id="home-unit"
              type="text"
              value={homeForm.unit}
              onChange={(e) =>
                setHomeForm({ ...homeForm, unit: e.target.value })
              }
            />
          </div>
        </div>
        {editingHomeId && (
          <div className="field" style={{ marginBottom: '16px' }}>
            <label htmlFor="home-status">Status</label>
            <select
              id="home-status"
              value={homeStatus}
              onChange={(e) => setHomeStatus(e.target.value as Status)}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        )}
        <div className="btn-row">
          <button className="btn btn--small" type="submit" disabled={busy}>
            {busy ? 'Saving…' : editingHomeId ? 'Save Home' : 'Add Home'}
          </button>
          {editingHomeId && (
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={resetHome}
            >
              Cancel
            </button>
          )}
        </div>
      </form>

      {ownerPropertyId && (
        <form
          className="panel-card"
          onSubmit={submitOwner}
          style={{ marginBottom: '26px' }}
        >
          <div className="panel-editor__title">
            {editingOwnerId ? 'Edit Owner' : 'Add Owner'}
          </div>
          <div className="field-grid" style={{ marginBottom: '16px' }}>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="owner-name">Full name</label>
              <input
                id="owner-name"
                type="text"
                value={ownerForm.fullName}
                onChange={(e) =>
                  setOwnerForm({ ...ownerForm, fullName: e.target.value })
                }
                required
              />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="owner-phone">
                Phone (E.164, e.g. +19195551234)
              </label>
              <input
                id="owner-phone"
                type="text"
                value={ownerForm.phone}
                onChange={(e) =>
                  setOwnerForm({ ...ownerForm, phone: e.target.value })
                }
                placeholder="+19195551234"
              />
            </div>
          </div>
          <div className="field" style={{ marginBottom: '16px' }}>
            <label htmlFor="owner-email">Email</label>
            <input
              id="owner-email"
              type="email"
              value={ownerForm.email}
              onChange={(e) =>
                setOwnerForm({ ...ownerForm, email: e.target.value })
              }
            />
          </div>
          {editingOwnerId && (
            <div className="field" style={{ marginBottom: '16px' }}>
              <label htmlFor="owner-status">Status</label>
              <select
                id="owner-status"
                value={ownerStatus}
                onChange={(e) => setOwnerStatus(e.target.value as Status)}
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
          )}
          <div className="btn-row">
            <button className="btn btn--small" type="submit" disabled={busy}>
              {busy ? 'Saving…' : editingOwnerId ? 'Save Owner' : 'Add Owner'}
            </button>
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={resetOwner}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="panel-list">
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : homes.length === 0 ? (
          <p className="muted panel-pad">No homes yet.</p>
        ) : (
          homes.map((h) => (
            <div
              key={h.id}
              className="panel-card"
              style={{ marginBottom: '14px' }}
            >
              <div className="list-row">
                <div className="admin-row-main">
                  <div className="admin-row-title">
                    {h.address}
                    {h.unit ? ` · Unit ${h.unit}` : ''}
                    {h.status === 'inactive' && (
                      <span className="pinned-badge"> Inactive</span>
                    )}
                  </div>
                </div>
                <div className="row-actions">
                  <button className="row-link" onClick={() => startEditHome(h)}>
                    Edit
                  </button>
                  <button
                    className="row-link"
                    aria-label={`Add owner to ${h.address}`}
                    onClick={() => startAddOwner(h.id)}
                  >
                    Add owner
                  </button>
                  <button
                    className="row-link row-link--danger"
                    onClick={() => toggleHome(h)}
                  >
                    {h.status === 'active' ? 'Deactivate' : 'Reactivate'}
                  </button>
                </div>
              </div>
              {h.owners.map((o) => (
                <div
                  key={o.id}
                  className="list-row"
                  style={{ paddingLeft: '18px' }}
                >
                  <div className="admin-row-main">
                    <div className="admin-row-title">
                      {o.fullName}
                      {o.status === 'inactive' && (
                        <span className="pinned-badge"> Inactive</span>
                      )}
                    </div>
                    <div className="admin-row-sub">
                      {[o.phone, o.email].filter(Boolean).join(' · ') ||
                        'no contact'}
                    </div>
                  </div>
                  <div className="row-actions">
                    <button
                      className="row-link"
                      onClick={() => startEditOwner(o)}
                    >
                      Edit
                    </button>
                    <button
                      className="row-link row-link--danger"
                      aria-label="Deactivate owner"
                      onClick={() => toggleOwner(o)}
                    >
                      {o.status === 'active' ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

Note: the list "Add owner" button carries `aria-label={`Add owner to ${h.address}`}` so its accessible name differs from the owner-form submit ("Add Owner") — the test targets the list button with `/add owner to/i` and the submit with the anchored `/^add owner$/i`, with no collision. The deactivate-owner button carries `aria-label="Deactivate owner"` so the test targets it unambiguously versus the home's "Deactivate".

- [ ] **Step 4: Wire into `src/components/admin/AdminApp.tsx`**

Add the import beside the other manager imports:

```tsx
import RosterManager from './RosterManager';
```

Add to the `SECTIONS` array, after the `documents` entry and before `dues`:

```tsx
  { key: 'roster', label: 'Roster', render: () => <RosterManager /> },
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/components/admin/RosterManager.test.tsx src/components/admin/AdminApp.test.tsx`
Expected: PASS for both. (AdminApp default tab is Announcements, so RosterManager does not mount there and needs no new mock; the existing AdminApp tabs test still passes.)

- [ ] **Step 6: Full gate + commit**

Run: `npm run check && npm test && npm run build`

```bash
npm run format
git add src/components/admin/RosterManager.tsx src/components/admin/RosterManager.test.tsx src/components/admin/AdminApp.tsx
git commit -m "feat: admin Roster section (homes + owners CRUD)"
```

---

### Task 4: MembersManager section

**Files:**

- Create: `src/components/admin/MembersManager.tsx`
- Modify: `src/components/admin/AdminApp.tsx` (import + SECTIONS entry)
- Test: `src/components/admin/MembersManager.test.tsx` (create)

**Interfaces:**

- Consumes: `fetchMembers`, `memberAction`, `fetchProperties` (Task 1); `MembersView`, `PropertyWithOwners` types.
- Produces: default-exported `MembersManager`; a `members` entry in AdminApp `SECTIONS`.

- [ ] **Step 1: Write the failing component test**

Create `src/components/admin/MembersManager.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchMembers = vi.fn();
const fetchProperties = vi.fn();
const memberAction = vi.fn().mockResolvedValue(undefined);
vi.mock('../../lib/admin', () => ({
  fetchMembers: (...a: unknown[]) => fetchMembers(...a),
  fetchProperties: (...a: unknown[]) => fetchProperties(...a),
  memberAction: (...a: unknown[]) => memberAction(...a),
}));

import MembersManager from './MembersManager';

beforeEach(() => {
  fetchMembers.mockReset().mockResolvedValue({
    recent: [
      {
        id: 'u1',
        name: 'Existing HO',
        email: 'ho@x.com',
        createdAt: '2026-06-01T00:00:00.000Z',
      },
    ],
    queue: [
      {
        id: 'q1',
        userId: 'u2',
        email: 'pending@x.com',
        claimedAddress: '9 Elm St',
        reason: 'address not found',
        status: 'pending',
        createdAt: '2026-06-20T00:00:00.000Z',
      },
    ],
  });
  fetchProperties.mockReset().mockResolvedValue([
    {
      id: 'p9',
      address: '9 Elm St',
      unit: null,
      status: 'active',
      notes: null,
      owners: [],
    },
  ]);
  memberAction.mockClear();
});

describe('MembersManager', () => {
  it('renders the pending queue with the requester email, and recent homeowners', async () => {
    render(<MembersManager />);
    expect(await screen.findByText('pending@x.com')).toBeInTheDocument();
    expect(screen.getByText('9 Elm St')).toBeInTheDocument();
    expect(screen.getByText('ho@x.com')).toBeInTheDocument();
  });

  it('approves a pending request with the selected propertyId', async () => {
    render(<MembersManager />);
    await screen.findByText('pending@x.com');
    fireEvent.change(screen.getByLabelText(/home for pending@x.com/i), {
      target: { value: 'p9' },
    });
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(memberAction).toHaveBeenCalledTimes(1));
    expect(memberAction.mock.calls[0][0]).toEqual({
      action: 'approve',
      queueId: 'q1',
      propertyId: 'p9',
    });
  });

  it('revokes a homeowner', async () => {
    render(<MembersManager />);
    await screen.findByText('ho@x.com');
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }));
    await waitFor(() => expect(memberAction).toHaveBeenCalledTimes(1));
    expect(memberAction.mock.calls[0][0]).toEqual({
      action: 'revoke',
      userId: 'u1',
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/admin/MembersManager.test.tsx`
Expected: FAIL — module `./MembersManager` does not exist.

- [ ] **Step 3: Create `src/components/admin/MembersManager.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { fetchMembers, fetchProperties, memberAction } from '../../lib/admin';
import { formatDate } from '../../lib/format';
import type {
  MembersView,
  ManualApprovalItem,
  MemberUser,
  PropertyWithOwners,
} from '../../lib/types';

/** Best-effort default: match a claimed address to an active home by a
 * case-insensitive compare of trimmed strings. Returns '' when unsure. */
function defaultHomeId(claimed: string, homes: PropertyWithOwners[]): string {
  const c = claimed.trim().toLowerCase();
  const hit = homes.find((h) => h.address.trim().toLowerCase() === c);
  return hit?.id ?? '';
}

export default function MembersManager() {
  const [data, setData] = useState<MembersView>({ recent: [], queue: [] });
  const [homes, setHomes] = useState<PropertyWithOwners[]>([]);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  async function load() {
    setLoading(true);
    const [members, props] = await Promise.all([
      fetchMembers(),
      fetchProperties(),
    ]);
    const active = props.filter((h) => h.status === 'active');
    setHomes(active);
    setData(members);
    setPicks(
      Object.fromEntries(
        members.queue.map((q) => [
          q.id,
          defaultHomeId(q.claimedAddress, active),
        ]),
      ),
    );
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  async function act(
    payload: Parameters<typeof memberAction>[0],
    okMsg: string,
  ) {
    setMsg('');
    try {
      await memberAction(payload);
      setMsg(okMsg);
      await load();
    } catch (err: any) {
      setMsg('Error: ' + (err?.message ?? 'action failed.'));
    }
  }

  async function approve(q: ManualApprovalItem) {
    const propertyId = picks[q.id];
    if (!propertyId) {
      setMsg('Pick a home to link before approving.');
      return;
    }
    await act(
      { action: 'approve', queueId: q.id, propertyId },
      'Request approved.',
    );
  }

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Members</h1>
      </div>
      <p className="admin-panel__intro">
        Pending homeowner requests that could not be auto-verified, and current
        homeowners. Approving links the person to a home; revoking returns them
        to visitor access.
      </p>

      {msg && <div className="form-message form-message--success">{msg}</div>}

      <div className="panel-editor__title">Pending requests</div>
      <div className="panel-list" style={{ marginBottom: '26px' }}>
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : data.queue.length === 0 ? (
          <p className="muted panel-pad">No pending requests.</p>
        ) : (
          data.queue.map((q) => (
            <div key={q.id} className="list-row">
              <div className="admin-row-date">{formatDate(q.createdAt)}</div>
              <div className="admin-row-main">
                <div className="admin-row-title">{q.email ?? q.userId}</div>
                <div className="admin-row-sub">
                  Claimed: {q.claimedAddress} — {q.reason}
                </div>
                <label
                  htmlFor={`home-${q.id}`}
                  className="sr-only"
                >{`Home for ${q.email ?? q.userId}`}</label>
                <select
                  id={`home-${q.id}`}
                  value={picks[q.id] ?? ''}
                  onChange={(e) =>
                    setPicks({ ...picks, [q.id]: e.target.value })
                  }
                >
                  <option value="">Select a home…</option>
                  {homes.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.address}
                      {h.unit ? ` · Unit ${h.unit}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="row-actions">
                <button className="row-link" onClick={() => approve(q)}>
                  Approve
                </button>
                <button
                  className="row-link row-link--danger"
                  onClick={() =>
                    act({ action: 'deny', queueId: q.id }, 'Request denied.')
                  }
                >
                  Deny
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="panel-editor__title">Recent homeowners</div>
      <div className="panel-list">
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : data.recent.length === 0 ? (
          <p className="muted panel-pad">None yet.</p>
        ) : (
          data.recent.map((u: MemberUser) => (
            <div key={u.id} className="list-row">
              <div className="admin-row-main">
                <div className="admin-row-title">{u.name}</div>
                <div className="admin-row-sub">{u.email}</div>
              </div>
              <div className="row-actions">
                <button
                  className="row-link row-link--danger"
                  onClick={() =>
                    act(
                      { action: 'revoke', userId: u.id },
                      'Homeowner access revoked.',
                    )
                  }
                >
                  Revoke
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire into `src/components/admin/AdminApp.tsx`**

Add the import:

```tsx
import MembersManager from './MembersManager';
```

Add to `SECTIONS`, immediately after the `roster` entry:

```tsx
  { key: 'members', label: 'Members', render: () => <MembersManager /> },
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/components/admin/MembersManager.test.tsx src/components/admin/AdminApp.test.tsx`
Expected: PASS for both.

- [ ] **Step 6: Full gate + commit**

Run: `npm run check && npm test && npm run test:server && npm run build`

```bash
npm run format
git add src/components/admin/MembersManager.tsx src/components/admin/MembersManager.test.tsx src/components/admin/AdminApp.tsx
git commit -m "feat: admin Members section (approvals + revoke)"
```

---

## Self-Review

**Spec coverage:**

- RosterManager (home-centric CRUD, soft-delete, add-owner-with-propertyId) → Task 3. ✔
- MembersManager (queue approve with property-picker, deny, revoke; recent homeowners) → Task 4. ✔
- `members` GET email join → Task 2. ✔
- Client helpers (`fetchProperties`, `saveProperty`, `saveOwner`, `fetchMembers`, `memberAction`) → Task 1. ✔
- Types (`PropertyWithOwners`, `ManualApprovalItem`, `MemberUser`, `MembersView`) → Task 1. ✔
- AdminApp wiring (roster + members sections) → Tasks 3 & 4. ✔
- Component + server tests → Tasks 2/3/4. ✔
- Non-goal (no hard delete) honored: only `status` PATCHes. ✔

**Placeholder scan:** No TBD/TODO. Every code step shows complete code; every test asserts concrete payloads; every command has an expected result.

**Type consistency:** Helper names/signatures in Task 1 (`fetchProperties`, `saveProperty(data,id?)`, `saveOwner(data,id?)`, `fetchMembers`, `memberAction(payload)`) match their use in Tasks 3–4. `PropertyWithOwners`/`Owner`/`MembersView`/`ManualApprovalItem`/`MemberUser` used consistently. The members GET projection (`id,userId,email,claimedAddress,reason,status,createdAt`) matches `ManualApprovalItem`. SECTIONS keys `roster`/`members` are unique against existing `announcements`/`documents`/`dues`/`site`.

**Test-targeting note (resolved):** RosterManager's list "Add owner" button uses `aria-label="Add owner to <address>"` so its accessible name never collides with the owner-form submit ("Add Owner"); the test uses `/add owner to/i` for the list button and the anchored `/^add owner$/i` for the submit. The owner Deactivate uses `aria-label="Deactivate owner"` to stay distinct from the home Deactivate.
