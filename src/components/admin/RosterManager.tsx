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
