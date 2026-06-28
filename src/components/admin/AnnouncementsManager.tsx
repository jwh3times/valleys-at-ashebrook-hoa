import { useEffect, useState } from 'react';
import { fetchAnnouncements } from '../../lib/content';
import { deleteAnnouncement, saveAnnouncement } from '../../lib/admin';
import { formatDate, todayIso } from '../../lib/format';
import type { Announcement } from '../../lib/types';

const empty = { title: '', body: '', date: todayIso(), pinned: false };

export default function AnnouncementsManager() {
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<typeof empty>(empty);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function load() {
    setLoading(true);
    setItems(await fetchAnnouncements());
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  function startEdit(a: Announcement) {
    setEditingId(a.id);
    setForm({ title: a.title, body: a.body, date: a.date, pinned: !!a.pinned });
    setMsg('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function reset() {
    setEditingId(null);
    setForm({ ...empty, date: todayIso() });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      await saveAnnouncement(
        {
          title: form.title,
          body: form.body,
          date: form.date,
          pinned: form.pinned,
        },
        editingId ?? undefined,
      );
      setMsg(editingId ? 'Announcement updated.' : 'Announcement posted.');
      reset();
      await load();
    } catch (err: any) {
      setMsg('Error: ' + (err?.message ?? 'could not save.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this announcement? This cannot be undone.')) return;
    await deleteAnnouncement(id);
    await load();
  }

  return (
    <div>
      <h2>{editingId ? 'Edit announcement' : 'New announcement'}</h2>
      {msg && <div className="form-message form-message--success">{msg}</div>}
      <form className="card" onSubmit={handleSave} style={{ marginBottom: '2rem' }}>
        <div className="field">
          <label>Title</label>
          <input
            type="text"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            required
          />
        </div>
        <div className="field">
          <label>Date</label>
          <input
            type="date"
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
            required
          />
        </div>
        <div className="field">
          <label>Message</label>
          <textarea
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            required
          />
        </div>
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={form.pinned}
            onChange={(e) => setForm({ ...form, pinned: e.target.checked })}
            style={{ width: 'auto' }}
          />
          Pin to top
        </label>
        <div style={{ marginTop: '1rem' }}>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Saving…' : editingId ? 'Update' : 'Post announcement'}
          </button>
          {editingId && (
            <button
              type="button"
              className="btn btn--outline"
              style={{ marginLeft: '0.5rem' }}
              onClick={reset}
            >
              Cancel
            </button>
          )}
        </div>
      </form>

      <h2>Posted announcements</h2>
      {loading ? (
        <p className="loading">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        items.map((a) => (
          <div key={a.id} className="list-row">
            <div>
              <strong>{a.title}</strong>
              {a.pinned && <span className="pinned-badge">Pinned</span>}
              <div className="muted" style={{ fontSize: '0.85rem' }}>
                {formatDate(a.date)}
              </div>
            </div>
            <div className="row-actions">
              <button
                className="btn btn--outline btn--small"
                onClick={() => startEdit(a)}
              >
                Edit
              </button>
              <button
                className="btn btn--danger btn--small"
                onClick={() => handleDelete(a.id)}
              >
                Delete
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
