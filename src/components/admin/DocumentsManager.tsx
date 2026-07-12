import { useRef, useState } from 'react';
import {
  deleteDocument,
  editDocument,
  uploadDocument,
  fetchAdminDocuments,
  DuplicateError,
} from '../../lib/admin';
import {
  DOCUMENT_CATEGORIES,
  type AdminDocumentItem,
  type Visibility,
} from '../../lib/types';
import { useAdminResource } from './useAdminResource';

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

// Segmented filter for the document list. 'all' is the reset that shows every doc.
const FILTER_TABS: { value: Visibility | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'public', label: 'Public' },
  { value: 'homeowner', label: 'Homeowners' },
  { value: 'board', label: 'Board' },
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
  const {
    data: items,
    loading,
    reload,
    busy,
    msg,
    setMsg,
    run,
  } = useAdminResource<AdminDocumentItem[]>(fetchAdminDocuments, []);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<string>(DOCUMENT_CATEGORIES[0]);
  const [visibility, setVisibility] = useState<Visibility>('board');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dupWarning, setDupWarning] = useState<{
    similar: { id: string; title?: string; filename?: string }[];
  } | null>(null);
  const [filter, setFilter] = useState<Visibility | 'all'>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({
    title: '',
    category: DOCUMENT_CATEGORIES[0],
    visibility: 'public',
  });
  const fileInput = useRef<HTMLInputElement>(null);

  function startEdit(d: AdminDocumentItem) {
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

  async function submitUpload(confirmDuplicate: boolean) {
    setMsg('');
    if (!file) {
      setMsg('Please choose a file.');
      return;
    }
    setUploading(true);
    try {
      await uploadDocument(file, title, category, visibility, confirmDuplicate);
      setDupWarning(null);
      setTitle('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      await reload();
      setMsg('Document uploaded.');
    } catch (err: unknown) {
      if (err instanceof DuplicateError && err.kind === 'exact') {
        setDupWarning(null);
        setMsg(
          `Error: This exact file is already on the site as "${err.existing?.title ?? 'an existing document'}". Nothing was uploaded.`,
        );
      } else if (err instanceof DuplicateError && err.kind === 'near') {
        setMsg('');
        setDupWarning({ similar: err.similar ?? [] });
      } else {
        setDupWarning(null);
        setMsg(
          'Error: ' +
            ((err as { message?: string } | null)?.message ??
              'could not upload.'),
        );
      }
    } finally {
      setUploading(false);
    }
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
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
    setDupWarning(null);
    await submitUpload(false);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    await run(async () => {
      await editDocument(editingId, editForm);
      resetEdit();
      await reload();
    }, 'Document updated.');
  }

  async function handleDelete(item: AdminDocumentItem) {
    if (!confirm(`Delete "${item.title}"? This cannot be undone.`)) return;
    await deleteDocument(item.id);
    await reload();
  }

  const shown =
    filter === 'all' ? items : items.filter((d) => d.visibility === filter);
  const countFor = (value: Visibility | 'all') =>
    value === 'all'
      ? items.length
      : items.filter((d) => d.visibility === value).length;

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
            <button
              className="btn btn--small"
              type="submit"
              disabled={uploading}
            >
              {uploading ? 'Uploading…' : 'Upload document'}
            </button>
          </div>
          {dupWarning && (
            <div
              className="form-message"
              style={{ marginTop: '12px' }}
              role="alert"
            >
              <p style={{ margin: '0 0 8px' }}>
                A similar document is already on the site:
              </p>
              <ul style={{ margin: '0 0 10px 18px' }}>
                {dupWarning.similar.map((s) => (
                  <li key={s.id}>
                    {s.title ?? 'Untitled'}{' '}
                    <span className="muted">
                      ({s.filename ?? 'unknown filename'})
                    </span>
                  </li>
                ))}
              </ul>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={uploading}
                  onClick={() => submitUpload(true)}
                >
                  Upload anyway
                </button>
                <button
                  type="button"
                  className="btn btn--outline btn--small"
                  onClick={() => setDupWarning(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </form>
      )}

      {!loading && items.length > 0 && (
        <div
          className="doc-filter"
          role="group"
          aria-label="Filter documents by visibility"
          style={{
            display: 'flex',
            gap: '8px',
            flexWrap: 'wrap',
            marginBottom: '14px',
          }}
        >
          {FILTER_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={`btn btn--small${filter === tab.value ? '' : ' btn--outline'}`}
              aria-pressed={filter === tab.value}
              onClick={() => setFilter(tab.value)}
            >
              {tab.label} ({countFor(tab.value)})
            </button>
          ))}
        </div>
      )}

      <div className="panel-list">
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted panel-pad">None yet.</p>
        ) : shown.length === 0 ? (
          <p className="muted panel-pad">
            No documents are set to this visibility.
          </p>
        ) : (
          shown.map((d) => (
            <div key={d.id} className="list-row">
              <div className="admin-row-main">
                <div className="admin-row-title">{d.title}</div>
                <div className="admin-row-sub">
                  {d.category} &middot; {d.visibility}
                  {d.ragStatus === 'unsupported' && (
                    <span
                      className="pinned-badge"
                      title="This file (a scan or unsupported format) couldn't be made searchable — download still works."
                    >
                      Not searchable
                    </span>
                  )}
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
