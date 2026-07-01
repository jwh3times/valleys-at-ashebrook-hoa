import { useEffect, useState } from 'react';
import { fetchDocuments, groupDocumentsByCategory } from '../../lib/content';
import { formatDate } from '../../lib/format';
import type { DocumentItem } from '../../lib/types';

export default function DocumentsList() {
  const [docs, setDocs] = useState<DocumentItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchDocuments()
      .then(setDocs)
      .catch((e) => setError(e.message ?? 'Could not load documents.'));
  }, []);

  if (error) return <p className="form-message form-message--error">{error}</p>;
  if (docs === null) return <p className="loading">Loading documents…</p>;
  if (docs.length === 0)
    return (
      <p className="muted">
        No documents have been posted yet. The board will add governing
        documents, meeting minutes, and forms here.
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
