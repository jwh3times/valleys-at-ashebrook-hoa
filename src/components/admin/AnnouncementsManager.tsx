import { useState } from 'react';
import { fetchAnnouncements } from '../../lib/content';
import { deleteAnnouncement, saveAnnouncement } from '../../lib/admin';
import { formatDate, todayIso } from '../../lib/format';
import type { Announcement, Visibility } from '../../lib/types';
import { useAdminResource } from './useAdminResource';

const empty: {
  title: string;
  body: string;
  date: string;
  pinned: boolean;
  visibility: Visibility;
} = {
  title: '',
  body: '',
  date: todayIso(),
  pinned: false,
  visibility: 'public',
};

export default function AnnouncementsManager() {
  const {
    data: items,
    loading,
    reload,
    busy,
    msg,
    setMsg,
    run,
  } = useAdminResource<Announcement[]>(fetchAnnouncements, []);
  const [form, setForm] = useState<typeof empty>(empty);
  const [editingId, setEditingId] = useState<string | null>(null);

  function startEdit(a: Announcement) {
    setEditingId(a.id);
    setForm({
      title: a.title,
      body: a.body,
      date: a.date,
      pinned: !!a.pinned,
      visibility: a.visibility,
    });
    setMsg('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function reset() {
    setEditingId(null);
    setForm({ ...empty, date: todayIso() });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await run(
      async () => {
        await saveAnnouncement(
          {
            title: form.title,
            body: form.body,
            date: form.date,
            pinned: form.pinned,
            visibility: form.visibility,
          },
          editingId ?? undefined,
        );
        reset();
        await reload();
      },
      editingId ? 'Announcement updated.' : 'Announcement posted.',
    );
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this announcement? This cannot be undone.')) return;
    await deleteAnnouncement(id);
    await reload();
  }

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Announcements</h1>
      </div>
      <p className="admin-panel__intro">
        Announcements appear on the Home and Announcements pages. Use the
        Visibility field to control who sees each one: Public (everyone),
        Homeowners only, or Board only.
      </p>

      {msg && <div className="form-message form-message--success">{msg}</div>}

      <form
        className="panel-card"
        onSubmit={handleSave}
        style={{ marginBottom: '26px' }}
      >
        <div className="panel-editor__title">
          {editingId ? 'Edit Announcement' : 'New Announcement'}
        </div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Title</label>
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Announcement title"
              required
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Date</label>
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              required
            />
          </div>
        </div>
        <div className="field">
          <label>Message</label>
          <textarea
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            placeholder="Write the announcement…"
            required
          />
        </div>
        <label
          style={{
            display: 'flex',
            gap: '0.5rem',
            alignItems: 'center',
            fontSize: '14px',
            marginBottom: '18px',
          }}
        >
          <input
            type="checkbox"
            checked={form.pinned}
            onChange={(e) => setForm({ ...form, pinned: e.target.checked })}
            style={{ width: 'auto' }}
          />
          Pin to top
        </label>
        <div className="field" style={{ marginBottom: '18px' }}>
          <label>Visibility</label>
          <select
            value={form.visibility}
            onChange={(e) =>
              setForm({
                ...form,
                visibility: e.target.value as typeof form.visibility,
              })
            }
          >
            <option value="public">Public</option>
            <option value="homeowner">Homeowners only</option>
            <option value="board">Board only</option>
          </select>
        </div>
        <div className="btn-row">
          <button className="btn btn--small" type="submit" disabled={busy}>
            {busy ? 'Saving…' : editingId ? 'Save Changes' : 'Publish'}
          </button>
          {editingId && (
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={reset}
            >
              Cancel
            </button>
          )}
        </div>
      </form>

      <div className="panel-list">
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted panel-pad">None yet.</p>
        ) : (
          items.map((a) => (
            <div key={a.id} className="list-row">
              <div className="admin-row-date">{formatDate(a.date)}</div>
              <div className="admin-row-main">
                <div className="admin-row-title">
                  {a.title}
                  {a.pinned && <span className="pinned-badge">Pinned</span>}
                </div>
                <div className="admin-row-sub">{a.body}</div>
              </div>
              <div className="row-actions">
                <button className="row-link" onClick={() => startEdit(a)}>
                  Edit
                </button>
                <button
                  className="row-link row-link--danger"
                  onClick={() => handleDelete(a.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
