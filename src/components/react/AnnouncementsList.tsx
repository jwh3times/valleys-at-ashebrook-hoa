import { useEffect, useState } from 'react';
import { fetchAnnouncements } from '../../lib/content';
import { isFirebaseConfigured } from '../../lib/firebase';
import { formatDate } from '../../lib/format';
import type { Announcement } from '../../lib/types';

interface Props {
  /** Optionally cap how many announcements to show (e.g. on the home page). */
  limit?: number;
  /** Link to the full announcements page when truncated. */
  showMoreLink?: boolean;
}

export default function AnnouncementsList({ limit, showMoreLink }: Props) {
  const [items, setItems] = useState<Announcement[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isFirebaseConfigured) {
      setItems([]);
      return;
    }
    fetchAnnouncements()
      .then(setItems)
      .catch((e) => setError(e.message ?? 'Could not load announcements.'));
  }, []);

  if (error) return <p className="form-message form-message--error">{error}</p>;
  if (items === null) return <p className="loading">Loading announcements…</p>;
  if (items.length === 0)
    return <p className="muted">No announcements yet. Check back soon.</p>;

  const shown = limit ? items.slice(0, limit) : items;

  return (
    <div>
      {shown.map((a) => (
        <article key={a.id} className="card announcement">
          <div className="announcement__meta">
            {formatDate(a.date)}
            {a.pinned && <span className="pinned-badge">Pinned</span>}
          </div>
          <h3 style={{ margin: '0 0 0.4rem' }}>{a.title}</h3>
          <div className="announcement__body">{a.body}</div>
        </article>
      ))}
      {showMoreLink && limit && items.length > limit && (
        <p style={{ marginTop: '1rem' }}>
          <a href="/announcements">View all announcements →</a>
        </p>
      )}
    </div>
  );
}
