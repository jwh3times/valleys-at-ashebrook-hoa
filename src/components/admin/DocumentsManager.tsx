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
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Documents</h1>
      </div>
      <p className="admin-panel__intro">
        Upload, organize, and remove the PDFs shown on the public Documents
        page.
      </p>

      {msg && <div className="form-message form-message--success">{msg}</div>}

      <form
        className="panel-card"
        onSubmit={handleUpload}
        style={{ marginBottom: '26px' }}
      >
        <div className="panel-editor__title">Upload a document</div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label>Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Bylaws (2024)"
              required
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label>Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {DOCUMENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
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
        <div className="btn-row">
          <button className="btn btn--small" type="submit" disabled={busy}>
            {busy ? 'Uploading…' : 'Upload document'}
          </button>
        </div>
      </form>

      <div className="panel-list">
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted panel-pad">None yet.</p>
        ) : (
          items.map((d) => (
            <div key={d.id} className="list-row">
              <div className="admin-row-main">
                <div className="admin-row-title">{d.title}</div>
                <div className="admin-row-sub">{d.category}</div>
              </div>
              <div className="row-actions">
                <a
                  className="row-link"
                  href={d.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View
                </a>
                <button
                  className="row-link row-link--danger"
                  onClick={() => handleDelete(d)}
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
