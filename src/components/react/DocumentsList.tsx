import { groupDocumentsByCategory } from '../../lib/content';
import { formatDate } from '../../lib/format';
import type { DocumentItem } from '../../lib/types';

interface Props {
  /** Documents to render (read server-side and passed in). */
  docs: DocumentItem[];
}

export default function DocumentsList({ docs }: Props) {
  if (docs.length === 0)
    return (
      <p className="muted">
        No documents have been posted yet. Check back soon.
      </p>
    );

  const groups = groupDocumentsByCategory(docs);

  return (
    <div className="doc-groups">
      {Object.entries(groups).map(([category, items]) => (
        <section key={category}>
          <h2 className="doc-group__label">{category}</h2>
          <ul className="doc-list">
            {items.map((d) => (
              <li key={d.id}>
                <span className="doc-icon" aria-hidden="true">
                  <span>PDF</span>
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="doc-name">{d.title}</div>
                  <div className="doc-meta">
                    PDF
                    {d.updatedAt ? ` · Updated ${formatDate(d.updatedAt)}` : ''}
                  </div>
                </div>
                <a
                  className="doc-dl"
                  href={`/api/files/${d.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Download ↓
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
