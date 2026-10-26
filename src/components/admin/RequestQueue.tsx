import type { ReactNode } from 'react';

// The list half of a board request queue (#294 slice 3), the sibling of
// `QueueDialog`. A labelled region of cards, each with a title, a detail
// line, an optional note and its row actions. The Tenants panel is the first
// queue; the verification and correction queues are meant to reuse it.

interface Props<T> {
  /** The region's heading and accessible name. */
  title: string;
  emptyText: string;
  items: T[];
  rowKey: (item: T) => string;
  rowTitle: (item: T) => ReactNode;
  rowDetail: (item: T) => ReactNode;
  rowNote?: (item: T) => ReactNode;
  rowActions: (item: T) => ReactNode;
}

export default function RequestQueue<T>({
  title,
  emptyText,
  items,
  rowKey,
  rowTitle,
  rowDetail,
  rowNote,
  rowActions,
}: Props<T>) {
  const headingId = `queue-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section aria-labelledby={headingId} className="panel-list">
      <h2 id={headingId}>{title}</h2>
      {items.length === 0 ? (
        <p className="muted panel-pad">{emptyText}</p>
      ) : (
        items.map((item) => (
          <div
            key={rowKey(item)}
            className="panel-card"
            style={{ marginBottom: '14px' }}
          >
            <div className="list-row">
              <div className="admin-row-main">
                <div className="admin-row-title">{rowTitle(item)}</div>
                <div className="muted">{rowDetail(item)}</div>
                {rowNote?.(item)}
              </div>
              <div className="row-actions">{rowActions(item)}</div>
            </div>
          </div>
        ))
      )}
    </section>
  );
}
