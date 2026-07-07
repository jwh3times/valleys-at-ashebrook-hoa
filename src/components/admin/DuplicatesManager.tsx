import { useState } from 'react';
import { fetchDuplicates, resolveDuplicates } from '../../lib/admin';
import type { DupeGroupView, DuplicatesView } from '../../lib/types';
import { useAdminResource } from './useAdminResource';

const EMPTY: DuplicatesView = { exact: [], near: [], remaining: 0 };

function GroupCard({
  group,
  kind,
  onResolve,
  busy,
}: {
  group: DupeGroupView;
  kind: 'exact' | 'near';
  onResolve: (keepId: string, deleteIds: string[]) => void;
  busy: boolean;
}) {
  const [keepId, setKeepId] = useState(group.suggestedKeepId);
  const deleteIds = group.members
    .filter((m) => m.id !== keepId)
    .map((m) => m.id);
  return (
    <div className="panel-card" style={{ marginBottom: '16px' }}>
      <div className="panel-editor__title">
        {kind === 'exact' ? 'Identical files' : 'Possibly the same document'}
        {group.reason ? ` - ${group.reason}` : ''}
      </div>
      <div className="panel-list">
        {group.members.map((m) => (
          <label key={m.id} className="list-row" style={{ cursor: 'pointer' }}>
            <input
              type="radio"
              name={`keep-${group.members[0].id}`}
              checked={keepId === m.id}
              onChange={() => setKeepId(m.id)}
              style={{ marginRight: '10px' }}
            />
            <div className="admin-row-main">
              <div className="admin-row-title">{m.title}</div>
              <div className="admin-row-sub">
                {m.filename} &middot; {m.category} &middot; {m.visibility}
              </div>
            </div>
          </label>
        ))}
      </div>
      <div className="btn-row" style={{ marginTop: '10px' }}>
        <button
          className="btn btn--small"
          disabled={busy || deleteIds.length === 0}
          onClick={() => onResolve(keepId, deleteIds)}
        >
          {kind === 'exact'
            ? 'Keep suggested, delete the rest'
            : 'Keep selected, delete the others'}
        </button>
      </div>
    </div>
  );
}

export default function DuplicatesManager() {
  const { data, loading, reload, busy, msg, run } =
    useAdminResource<DuplicatesView>(fetchDuplicates, EMPTY);

  async function handleResolve(keepId: string, deleteIds: string[]) {
    if (
      !confirm(
        `Delete ${deleteIds.length} duplicate file(s)? This cannot be undone.`,
      )
    )
      return;
    await run(async () => {
      await resolveDuplicates(keepId, deleteIds);
      await reload();
    }, 'Duplicates resolved.');
  }

  const total = data.exact.length + data.near.length;

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Duplicates</h1>
      </div>
      <p className="admin-panel__intro">
        Identical files can be collapsed with one click. Possibly similar
        documents should be reviewed before deleting.
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
