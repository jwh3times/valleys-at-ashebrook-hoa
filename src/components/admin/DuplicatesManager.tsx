import { useState } from 'react';
import { fetchDuplicates, resolveDuplicates } from '../../lib/admin';
import type { DupeGroupView, DuplicatesView } from '../../lib/types';
import { useAdminResource } from './useAdminResource';

const EMPTY: DuplicatesView = { exact: [], near: [], remaining: 0 };

function HashLine({ hash }: { hash?: string | null }) {
  return (
    <div
      className="admin-row-sub"
      style={{ wordBreak: 'break-all', marginTop: '4px' }}
    >
      SHA-256: <code>{hash && hash.length > 0 ? hash : 'not hashed yet'}</code>
    </div>
  );
}

function GroupCard({
  group,
  kind,
  onResolve,
  busy,
}: {
  group: DupeGroupView;
  kind: 'exact' | 'near';
  onResolve: (keepIds: string[], deleteIds: string[]) => void;
  busy: boolean;
}) {
  const [deleteIds, setDeleteIds] = useState<Set<string>>(new Set());
  const allIds = group.members.map((m) => m.id);
  const keepIds = allIds.filter((id) => !deleteIds.has(id));
  const deletingAll = deleteIds.size > 0 && keepIds.length === 0;

  const toggle = (id: string) =>
    setDeleteIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectAllButSuggested = () =>
    setDeleteIds(new Set(allIds.filter((id) => id !== group.suggestedKeepId)));

  const label =
    kind === 'near'
      ? 'Near match'
      : group.autoResolvable
        ? 'Same-tier exact'
        : group.sameTier === false
          ? 'Cross-tier exact'
          : 'Exact match';
  const recommendation =
    group.recommendation ??
    (kind === 'exact'
      ? 'These files have identical bytes.'
      : 'These files have similar metadata and should be reviewed manually.');

  return (
    <div className="panel-card" style={{ marginBottom: '16px' }}>
      <div className="panel-editor__title">
        {kind === 'exact' ? 'Identical files' : 'Possibly the same document'}
        {group.reason ? ` - ${group.reason}` : ''}
      </div>
      <div className="form-message" style={{ marginBottom: '12px' }}>
        <strong>{label}.</strong> {recommendation} Check each file you want to
        delete; unchecked files are kept and marked reviewed.
        {kind === 'exact' && group.contentHash && (
          <HashLine hash={group.contentHash} />
        )}
      </div>
      <div className="panel-list">
        {group.members.map((m) => (
          <div key={m.id} className="list-row">
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                flex: 1,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={deleteIds.has(m.id)}
                onChange={() => toggle(m.id)}
                style={{ marginRight: '10px' }}
              />
              <div className="admin-row-main">
                <div className="admin-row-title">
                  {m.title}
                  {m.verifiedAt && (
                    <span className="admin-row-sub">
                      {' '}
                      &middot; kept &#10003;
                    </span>
                  )}
                </div>
                <div className="admin-row-sub">
                  {m.filename} &middot; {m.category} &middot; {m.visibility}
                </div>
                {kind === 'near' && <HashLine hash={m.contentHash} />}
              </div>
            </label>
            <a
              className="row-link"
              href={`/api/files/${m.id}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              View
            </a>
          </div>
        ))}
      </div>
      {kind === 'exact' && group.autoResolvable && (
        <div style={{ marginTop: '8px' }}>
          <button className="row-link" onClick={selectAllButSuggested}>
            Select all but suggested
          </button>
        </div>
      )}
      <div className="btn-row" style={{ marginTop: '10px' }}>
        <button
          className="btn btn--small"
          disabled={busy || deleteIds.size === 0 || deletingAll}
          onClick={() => onResolve(keepIds, [...deleteIds])}
        >
          {deletingAll
            ? 'Keep at least one file'
            : `Delete ${deleteIds.size} selected`}
        </button>
        <button
          className="btn btn--small"
          disabled={busy}
          onClick={() => onResolve(allIds, [])}
        >
          Keep all (mark reviewed)
        </button>
      </div>
    </div>
  );
}

export default function DuplicatesManager() {
  const { data, loading, reload, busy, msg, run } =
    useAdminResource<DuplicatesView>(fetchDuplicates, EMPTY);

  async function handleResolve(keepIds: string[], deleteIds: string[]) {
    if (
      deleteIds.length > 0 &&
      !confirm(
        `Delete ${deleteIds.length} duplicate file(s)? This cannot be undone.`,
      )
    )
      return;
    await run(
      async () => {
        await resolveDuplicates(keepIds, deleteIds);
        await reload();
      },
      deleteIds.length > 0 ? 'Duplicates resolved.' : 'Marked as reviewed.',
    );
  }

  const total = data.exact.length + data.near.length;

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Duplicates</h1>
      </div>
      <p className="admin-panel__intro">
        Identical files share a SHA-256 hash. Check the files you want to delete
        and keep the rest; kept files are marked reviewed and drop off this list
        until a matching document is uploaded again.
      </p>

      {msg && <div className="form-message form-message--success">{msg}</div>}
      {data.remaining > 0 && (
        <div className="form-message" role="status">
          Still scanning... {data.remaining} file(s) not yet hashed.{' '}
          <button className="row-link" onClick={() => reload()}>
            Continue scanning
          </button>
        </div>
      )}

      {loading ? (
        <p className="loading panel-pad">Scanning documents...</p>
      ) : total === 0 ? (
        <p className="muted panel-pad">No duplicates found.</p>
      ) : (
        <>
          {data.exact.map((g) => (
            <GroupCard
              key={g.members[0].id}
              group={g}
              kind="exact"
              busy={busy}
              onResolve={handleResolve}
            />
          ))}
          {data.near.map((g) => (
            <GroupCard
              key={g.members[0].id}
              group={g}
              kind="near"
              busy={busy}
              onResolve={handleResolve}
            />
          ))}
        </>
      )}
    </div>
  );
}
