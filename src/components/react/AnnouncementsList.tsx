import { useEffect, useState } from 'react';
import { fetchAnnouncements } from '../../lib/content';
import { formatDate } from '../../lib/format';
import type { Announcement } from '../../lib/types';

interface Props {
  /** Optionally cap how many announcements to show (e.g. on the home page). */
  limit?: number;
  /** Link to the full announcements page when truncated. */
  showMoreLink?: boolean;
  /** 'list' is the compact home-page list; 'page' is the wide date column. */
  variant?: 'list' | 'page';
}

export default function AnnouncementsList({
  limit,
  showMoreLink,
  variant = 'list',
}: Props) {
  const [items, setItems] = useState<Announcement[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
    <div className={variant === 'page' ? 'ann-page' : 'ann-list'}>
      {shown.map((a) => (
        <article key={a.id} className="ann">
          <div className="ann__date">
            {formatDate(a.date)}
            {a.pinned && <span className="pinned-badge">Pinned</span>}
          </div>
          <div>
            <h3 className="ann__title">{a.title}</h3>
            <div className="ann__body">{a.body}</div>
          </div>
        </article>
      ))}
      {showMoreLink && limit && items.length > limit && (
        <p style={{ marginTop: '1.25rem' }}>
          <a className="link-more" href="/announcements">
            View all announcements →
          </a>
        </p>
      )}
    </div>
  );
}
