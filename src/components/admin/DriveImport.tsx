import { useCallback, useEffect, useState } from 'react';
import { DOCUMENT_CATEGORIES } from '../../lib/types';
import {
  fetchDriveStatus,
  importDriveFile,
  previewDriveFiles,
  startPickerSession,
  type DriveStatus,
  type ImportResult,
  type PreviewFile,
} from '../../lib/drive';
import { pickDriveFiles } from '../../lib/drive-picker';

// #290 slice 3 (spec decisions 2-4, 8): "Import from Google Drive" beside
// Upload. Pick in Google Picker, preview what each file would become, set
// category (required, no default) and visibility (default board) for the batch
// or per file, then import one file at a time with a result per row.

const MAX_FILES = 10;
const VISIBILITIES = ['board', 'homeowner', 'public'] as const;

const defaultPick = async () =>
  pickDriveFiles(await startPickerSession(), MAX_FILES);

interface RowSettings {
  title: string;
  category: string;
  visibility: string;
}

type RowOutcome = { kind: 'importing' } | ImportResult;

const importable = (f: PreviewFile) => f.plan !== 'refused';

export function DriveImportButton({
  onImported,
  pick = defaultPick,
}: {
  onImported: () => void;
  pick?: () => Promise<string[]>;
}) {
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const loadStatus = useCallback(
    () => fetchDriveStatus().catch((): DriveStatus | null => null),
    [],
  );
  useEffect(() => {
    let live = true;
    async function start() {
      const loaded = await loadStatus();
      if (live) setStatus(loaded);
    }
    void start();
    return () => {
      live = false;
    };
  }, [loadStatus]);

  const [files, setFiles] = useState<PreviewFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!status) return null;
  const connected = status.status === 'connected';

  async function open() {
    setError(null);
    setBusy(true);
    try {
      const fileIds = await pick();
      if (fileIds.length === 0) return;
      setFiles(await previewDriveFiles(fileIds.slice(0, MAX_FILES)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google Drive failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="drive-import">
      <button
        type="button"
        className="btn btn--outline"
        disabled={!connected || busy}
        onClick={open}
      >
        Import from Google Drive
      </button>
      {status.status === 'none' && (
        <p className="muted">
          Google Drive isn't connected. Ask a System Administrator to connect
          it.
        </p>
      )}
      {status.status === 'broken' && (
        <p className="muted">
          The Google Drive connection stopped working. Ask a System
          Administrator to reconnect it.
        </p>
      )}
      {connected && (
        <p className="muted">
          Google shows files from the association's Google account. If it asks
          you to sign in, sign in to that account in this browser. You can stay
          signed in to your own account too.
        </p>
      )}
      {error && <div className="form-message">Error: {error}</div>}
      {files && (
        <ImportTable
          files={files}
          onDone={onImported}
          onClose={() => setFiles(null)}
        />
      )}
    </div>
  );
}

function ImportTable({
  files,
  onDone,
  onClose,
}: {
  files: PreviewFile[];
  onDone: () => void;
  onClose: () => void;
}) {
  const [batchCategory, setBatchCategory] = useState('');
  const [batchVisibility, setBatchVisibility] = useState('board');
  const [settings, setSettings] = useState<Record<string, RowSettings>>(() =>
    Object.fromEntries(
      files
        .filter(importable)
        .map((f) => [
          f.fileId,
          { title: f.title ?? f.name, category: '', visibility: 'board' },
        ]),
    ),
  );
  const [outcomes, setOutcomes] = useState<Record<string, RowOutcome>>({});
  const [running, setRunning] = useState(false);

  const rows = files.filter(importable);
  const ready =
    rows.length > 0 &&
    rows.every(
      (f) => settings[f.fileId].title.trim() && settings[f.fileId].category,
    );

  function setRow(fileId: string, patch: Partial<RowSettings>) {
    setSettings((s) => ({ ...s, [fileId]: { ...s[fileId], ...patch } }));
  }
  function setAll(patch: Partial<RowSettings>) {
    setSettings((s) =>
      Object.fromEntries(
        Object.entries(s).map(([id, row]) => [id, { ...row, ...patch }]),
      ),
    );
  }

  async function importOne(file: PreviewFile, confirmDuplicate: boolean) {
    const row = settings[file.fileId];
    setOutcomes((o) => ({ ...o, [file.fileId]: { kind: 'importing' } }));
    const result = await importDriveFile({
      fileId: file.fileId,
      expectedModifiedTime: file.modifiedTime ?? '',
      title: row.title.trim(),
      category: row.category,
      visibility: row.visibility,
      confirmDuplicate,
    }).catch((err: unknown): ImportResult => ({
      kind: 'failed',
      message: err instanceof Error ? err.message : 'Import failed.',
    }));
    setOutcomes((o) => ({ ...o, [file.fileId]: result }));
    return result;
  }

  async function importAll() {
    setRunning(true);
    let any = false;
    for (const file of rows) {
      if (outcomes[file.fileId]?.kind === 'imported') continue;
      const result = await importOne(file, false);
      if (result.kind === 'imported') any = true;
    }
    setRunning(false);
    if (any) onDone();
  }

  async function importAnyway(file: PreviewFile) {
    const result = await importOne(file, true);
    if (result.kind === 'imported') onDone();
  }

  return (
    <div className="panel-card drive-import__preview">
      <h3>Import from Google Drive</h3>
      <div className="form-row">
        <label>
          Category for every file
          <select
            aria-label="Category for every file"
            value={batchCategory}
            onChange={(e) => {
              setBatchCategory(e.target.value);
              setAll({ category: e.target.value });
            }}
          >
            <option value="">Choose a category</option>
            {DOCUMENT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          Visibility for every file
          <select
            aria-label="Visibility for every file"
            value={batchVisibility}
            onChange={(e) => {
              setBatchVisibility(e.target.value);
              setAll({ visibility: e.target.value });
            }}
          >
            {VISIBILITIES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      <table className="drive-import__table">
        <thead>
          <tr>
            <th>Drive file</th>
            <th>Stored as</th>
            <th>Title</th>
            <th>Category</th>
            <th>Visibility</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {files.map((f) => {
            const row = settings[f.fileId];
            const outcome = outcomes[f.fileId];
            return (
              <tr key={f.fileId}>
                <td>
                  <div>{f.name}</div>
                  {f.newerVersionOf?.map((d) => (
                    <div key={d.id} className="muted">
                      A newer version of "{d.title}", already in the library.
                    </div>
                  ))}
                  {f.nearDuplicates?.map((d) => (
                    <div key={d.id} className="muted">
                      Similar to "{d.title}", already in the library.
                    </div>
                  ))}
                </td>
                {f.plan === 'refused' ? (
                  <td colSpan={5}>{f.refusal}</td>
                ) : (
                  <>
                    <td>{f.storedAs?.toUpperCase()}</td>
                    <td>
                      <input
                        aria-label={`Title: ${f.name}`}
                        value={row.title}
                        onChange={(e) =>
                          setRow(f.fileId, { title: e.target.value })
                        }
                      />
                    </td>
                    <td>
                      <select
                        aria-label={`Category: ${f.name}`}
                        value={row.category}
                        onChange={(e) =>
                          setRow(f.fileId, { category: e.target.value })
                        }
                      >
                        <option value="">Choose a category</option>
                        {DOCUMENT_CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        aria-label={`Visibility: ${f.name}`}
                        value={row.visibility}
                        onChange={(e) =>
                          setRow(f.fileId, { visibility: e.target.value })
                        }
                      >
                        {VISIBILITIES.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      {outcome?.kind === 'importing' && 'Importing…'}
                      {outcome?.kind === 'imported' && 'Imported'}
                      {outcome?.kind === 'failed' && outcome.message}
                      {outcome?.kind === 'near-duplicate' && (
                        <>
                          Similar to{' '}
                          {outcome.similar
                            .map((d) => `"${d.title}"`)
                            .join(', ')}
                          , already in the library.{' '}
                          <button
                            type="button"
                            className="row-link"
                            aria-label={`Import anyway: ${row.title}`}
                            onClick={() => importAnyway(f)}
                          >
                            Import anyway
                          </button>
                        </>
                      )}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="btn-row">
        <button
          type="button"
          className="btn"
          disabled={!ready || running}
          onClick={importAll}
        >
          Import
        </button>
        <button type="button" className="btn btn--outline" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
