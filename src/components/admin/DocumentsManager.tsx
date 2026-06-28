import { useEffect, useRef, useState } from 'react';
import { fetchDocuments } from '../../lib/content';
import { deleteDocument, uploadDocument } from '../../lib/admin';
import { DOCUMENT_CATEGORIES, type DocumentItem } from '../../lib/types';

export default function DocumentsManager() {
  const [items, setItems] = useState<DocumentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<string>(DOCUMENT_CATEGORIES[0]);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  async function load() {
    setLoading(true);
    setItems(await fetchDocuments());
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    setMsg('');
    if (!file) {
      setMsg('Please choose a PDF file.');
      return;
    }
    if (file.type !== 'application/pdf') {
      setMsg('Only PDF files are allowed.');
      return;
    }
    setBusy(true);
    try {
      await uploadDocument(file, title, category);
      setMsg('Document uploaded.');
      setTitle('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      await load();
    } catch (err: any) {
      setMsg('Error: ' + (err?.message ?? 'upload failed.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(item: DocumentItem) {
    if (!confirm(`Delete "${item.title}"? This cannot be undone.`)) return;
    await deleteDocument(item);
    await load();
  }

  return (
    <div>
      <h2>Upload a document</h2>
      {msg && <div className="form-message form-message--success">{msg}</div>}
      <form className="card" onSubmit={handleUpload} style={{ marginBottom: '2rem' }}>
        <div className="field">
          <label>Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Bylaws (2024)"
            required
          />
        </div>
        <div className="field">
          <label>Category</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {DOCUMENT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>PDF file (max 25 MB)</label>
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            required
          />
        </div>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Uploading…' : 'Upload document'}
        </button>
      </form>

      <h2>Documents</h2>
      {loading ? (
        <p className="loading">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        items.map((d) => (
          <div key={d.id} className="list-row">
            <div>
              <strong>{d.title}</strong>
              <div className="muted" style={{ fontSize: '0.85rem' }}>
                {d.category}
              </div>
            </div>
            <div className="row-actions">
              <a
                className="btn btn--outline btn--small"
                href={d.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                View
              </a>
              <button
                className="btn btn--danger btn--small"
                onClick={() => handleDelete(d)}
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
