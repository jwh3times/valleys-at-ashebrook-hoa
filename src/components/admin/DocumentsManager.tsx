import { useEffect, useRef, useState } from 'react';
import { fetchDocuments } from '../../lib/content';
import { deleteDocument, editDocument, uploadDocument } from '../../lib/admin';
import {
  DOCUMENT_CATEGORIES,
  type DocumentItem,
  type Visibility,
} from '../../lib/types';

type EditForm = {
  title: string;
  category: string;
  visibility: Visibility;
};

const VISIBILITY_OPTIONS: { value: Visibility; label: string }[] = [
  { value: 'public', label: 'Public (everyone)' },
  { value: 'homeowner', label: 'Homeowners only' },
  { value: 'board', label: 'Board only' },
];

// Mirror the server-side allowlist in src/pages/api/admin/documents.ts.
const ALLOWED_EXTENSIONS = [
  'pdf',
  'txt',
  'md',
  'csv',
  'doc',
  'docx',
  'xls',
  'xlsx',
];
const ACCEPT_ATTR = ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(',');

export default function DocumentsManager() {
  const [items, setItems] = useState<DocumentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<string>(DOCUMENT_CATEGORIES[0]);
  const [visibility, setVisibility] = useState<Visibility>('board');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({
    title: '',
    category: DOCUMENT_CATEGORIES[0],
    visibility: 'public',
  });
  const fileInput = useRef<HTMLInputElement>(null);

  async function load() {
    setLoading(true);
    setItems(await fetchDocuments());
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  function startEdit(d: DocumentItem) {
    setEditingId(d.id);
    setEditForm({
      title: d.title,
      category: d.category,
      visibility: d.visibility,
    });
    setMsg('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function resetEdit() {
    setEditingId(null);
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    setMsg('');
    if (!file) {
      setMsg('Please choose a file.');
      return;
    }
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      setMsg(
        'Unsupported file type. Allowed: PDF, Word, Excel, CSV, text, Markdown.',
      );
      return;
    }
    setBusy(true);
    try {
      await uploadDocument(file, title, category, visibility);
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

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    setBusy(true);
    setMsg('');
    try {
      await editDocument(editingId, editForm);
      setMsg('Document updated.');
      resetEdit();
      await load();
    } catch (err: any) {
      setMsg('Error: ' + (err?.message ?? 'edit failed.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(item: DocumentItem) {
    if (!confirm(`Delete "${item.title}"? This cannot be undone.`)) return;
    await deleteDocument(item.id);
    await load();
  }

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Documents</h1>
      </div>
      <p className="admin-panel__intro">
        Upload, organize, and remove the documents shown on the public Documents
        page.
      </p>

      {msg && <div className="form-message form-message--success">{msg}</div>}

      {editingId ? (
        <form
          className="panel-card"
          onSubmit={handleEdit}
          style={{ marginBottom: '26px' }}
        >
          <div className="panel-editor__title">Edit Document</div>
          <div className="field-grid" style={{ marginBottom: '16px' }}>
            <div className="field" style={{ margin: 0 }}>
              <label>Title</label>
              <input
                type="text"
                value={editForm.title}
                onChange={(e) =>
                  setEditForm({ ...editForm, title: e.target.value })
                }
                required
              />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Category</label>
              <select
                value={editForm.category}
                onChange={(e) =>
                  setEditForm({ ...editForm, category: e.target.value })
                }
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
            <label>Visibility</label>
            <select
              value={editForm.visibility}
              onChange={(e) =>
                setEditForm({
                  ...editForm,
                  visibility: e.target.value as Visibility,
                })
              }
            >
              {VISIBILITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="btn-row">
            <button className="btn btn--small" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save Changes'}
            </button>
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={resetEdit}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
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
            <label>Visibility</label>
            <select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as Visibility)}
            >
              {VISIBILITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>File (max 25 MB)</label>
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPT_ATTR}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
            />
            <p style={{ fontSize: '13px', color: '#666', marginTop: '6px' }}>
              Allowed: PDF, Word (.doc/.docx), Excel (.xls/.xlsx), CSV, text,
              Markdown.
            </p>
          </div>
          <div className="btn-row">
            <button className="btn btn--small" type="submit" disabled={busy}>
              {busy ? 'Uploading…' : 'Upload document'}
            </button>
          </div>
        </form>
      )}

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
                <div className="admin-row-sub">
                  {d.category} &middot; {d.visibility}
                </div>
              </div>
              <div className="row-actions">
                <a
                  className="row-link"
                  href={`/api/files/${d.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View
                </a>
                <button className="row-link" onClick={() => startEdit(d)}>
                  Edit
                </button>
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
