import { useEffect, useState } from 'react';
import { fetchMembers, fetchProperties, memberAction } from '../../lib/admin';
import { formatDate } from '../../lib/format';
import type {
  MembersView,
  ManualApprovalItem,
  MemberUser,
  PropertyWithOwners,
} from '../../lib/types';

/** Best-effort default: match a claimed address to an active home by a
 * case-insensitive compare of trimmed strings. Returns '' when unsure. */
function defaultHomeId(claimed: string, homes: PropertyWithOwners[]): string {
  const c = claimed.trim().toLowerCase();
  const hit = homes.find((h) => h.address.trim().toLowerCase() === c);
  return hit?.id ?? '';
}

export default function MembersManager() {
  const [data, setData] = useState<MembersView>({ recent: [], queue: [] });
  const [homes, setHomes] = useState<PropertyWithOwners[]>([]);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  async function load() {
    setLoading(true);
    const [members, props] = await Promise.all([
      fetchMembers(),
      fetchProperties(),
    ]);
    const active = props.filter((h) => h.status === 'active');
    setHomes(active);
    setData(members);
    setPicks(
      Object.fromEntries(
        members.queue.map((q) => [
          q.id,
          defaultHomeId(q.claimedAddress, active),
        ]),
      ),
    );
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  async function act(
    payload: Parameters<typeof memberAction>[0],
    okMsg: string,
  ) {
    setMsg('');
    try {
      await memberAction(payload);
      setMsg(okMsg);
      await load();
    } catch (err: any) {
      setMsg('Error: ' + (err?.message ?? 'action failed.'));
    }
  }

  async function approve(q: ManualApprovalItem) {
    const propertyId = picks[q.id];
    if (!propertyId) {
      setMsg('Pick a home to link before approving.');
      return;
    }
    await act(
      { action: 'approve', queueId: q.id, propertyId },
      'Request approved.',
    );
  }

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Members</h1>
      </div>
      <p className="admin-panel__intro">
        Pending homeowner requests that could not be auto-verified, and current
        homeowners. Approving links the person to a home; revoking returns them
        to visitor access.
      </p>

      {msg && <div className="form-message form-message--success">{msg}</div>}

      <div className="panel-editor__title">Pending requests</div>
      <div className="panel-list" style={{ marginBottom: '26px' }}>
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : data.queue.length === 0 ? (
          <p className="muted panel-pad">No pending requests.</p>
        ) : (
          data.queue.map((q) => (
            <div key={q.id} className="list-row">
              <div className="admin-row-date">{formatDate(q.createdAt)}</div>
              <div className="admin-row-main">
                <div className="admin-row-title">{q.email ?? q.userId}</div>
                <div className="admin-row-sub">
                  Claimed: {q.claimedAddress} — {q.reason}
                </div>
                <label
                  htmlFor={`home-${q.id}`}
                  className="sr-only"
                >{`Home for ${q.email ?? q.userId}`}</label>
                <select
                  id={`home-${q.id}`}
                  value={picks[q.id] ?? ''}
                  onChange={(e) =>
                    setPicks({ ...picks, [q.id]: e.target.value })
                  }
                >
                  <option value="">Select a home…</option>
                  {homes.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.address}
                      {h.unit ? ` · Unit ${h.unit}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="row-actions">
                <button className="row-link" onClick={() => approve(q)}>
                  Approve
                </button>
                <button
                  className="row-link row-link--danger"
                  onClick={() =>
                    act({ action: 'deny', queueId: q.id }, 'Request denied.')
                  }
                >
                  Deny
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="panel-editor__title">Recent homeowners</div>
      <div className="panel-list">
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : data.recent.length === 0 ? (
          <p className="muted panel-pad">None yet.</p>
        ) : (
          data.recent.map((u: MemberUser) => (
            <div key={u.id} className="list-row">
              <div className="admin-row-main">
                <div className="admin-row-title">{u.name}</div>
                <div className="admin-row-sub">{u.email}</div>
              </div>
              <div className="row-actions">
                <button
                  className="row-link row-link--danger"
                  onClick={() =>
                    act(
                      { action: 'revoke', userId: u.id },
                      'Homeowner access revoked.',
                    )
                  }
                >
                  Revoke
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
