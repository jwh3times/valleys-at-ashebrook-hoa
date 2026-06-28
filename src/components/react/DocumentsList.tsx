import { useEffect, useState } from 'react';
import { fetchDocuments, groupDocumentsByCategory } from '../../lib/content';
import { isFirebaseConfigured } from '../../lib/firebase';
import type { DocumentItem } from '../../lib/types';

export default function DocumentsList() {
  const [docs, setDocs] = useState<DocumentItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isFirebaseConfigured) {
      setDocs([]);
      return;
    }
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
    <div>
      {Object.entries(groups).map(([category, items]) => (
        <section
          key={category}
          className="card"
          style={{ marginBottom: '1rem' }}
        >
          <h2 style={{ marginTop: 0 }}>{category}</h2>
          <ul className="doc-list">
            {items.map((d) => (
              <li key={d.id}>
                <span>📄 {d.title}</span>
                <a
                  className="btn btn--outline btn--small"
                  href={d.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Download
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
