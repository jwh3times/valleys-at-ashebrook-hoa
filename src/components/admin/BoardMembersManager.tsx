import { useEffect, useState } from 'react';
import {
  fetchBoardMembers,
  promoteToBoard,
  demoteFromBoard,
} from '../../lib/admin';
import type { MemberUser } from '../../lib/types';

export default function BoardMembersManager() {
  const [board, setBoard] = useState<MemberUser[]>([]);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function load() {
    setLoading(true);
    setBoard(await fetchBoardMembers());
    setLoading(false);
  }
  useEffect(() => {
    load();
  }, []);

  async function promote(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      await promoteToBoard(email.trim());
      setEmail('');
      setMsg('Promoted to board.');
      await load();
    } catch (err: any) {
      setMsg('Error: ' + (err?.message ?? 'could not promote.'));
    } finally {
      setBusy(false);
    }
  }

  async function demote(u: MemberUser) {
    setMsg('');
    try {
      await demoteFromBoard(u.id);
      setMsg('Board member demoted.');
      await load();
    } catch (err: any) {
      setMsg('Error: ' + (err?.message ?? 'could not demote.'));
    }
  }

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Board members</h1>
      </div>
      <p className="admin-panel__intro">
        Promote an existing account to the board or demote a board member. For a
        handoff, the outgoing member promotes the incoming one, then the
        incoming member demotes the outgoing one. The last remaining board
        member can't be demoted.
      </p>

      {msg && <div className="form-message form-message--success">{msg}</div>}

      <form
        className="panel-card"
        style={{ maxWidth: '620px', marginBottom: '18px' }}
        onSubmit={promote}
      >
        <div className="field">
          <label>Promote account by email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="person@example.com"
            required
          />
        </div>
        <div className="btn-row">
          <button className="btn btn--small" type="submit" disabled={busy}>
            {busy ? 'Promoting…' : 'Promote to board'}
          </button>
        </div>
      </form>

      <div className="panel-editor__title">Current board</div>
      <div className="panel-list">
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : board.length === 0 ? (
          <p className="muted panel-pad">No board members.</p>
        ) : (
          board.map((u) => (
            <div key={u.id} className="list-row">
              <div className="admin-row-main">
                <div className="admin-row-title">{u.name}</div>
                <div className="admin-row-sub">{u.email}</div>
              </div>
              <div className="row-actions">
                <button
                  className="row-link row-link--danger"
                  onClick={() => demote(u)}
                >
                  Demote
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
