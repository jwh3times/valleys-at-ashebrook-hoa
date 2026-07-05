import { useState } from 'react';
import {
  fetchBoardMembers,
  promoteToBoard,
  demoteFromBoard,
} from '../../lib/admin';
import type { MemberUser } from '../../lib/types';
import { useAdminResource } from './useAdminResource';

export default function BoardMembersManager() {
  const {
    data: board,
    loading,
    reload,
    busy,
    msg,
    setMsg,
    run,
  } = useAdminResource<MemberUser[]>(fetchBoardMembers, []);
  const [email, setEmail] = useState('');

  async function promote(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => {
      await promoteToBoard(email.trim());
      setEmail('');
      await reload();
    }, 'Promoted to board.');
  }

  // Not routed through `run`: demote intentionally leaves `busy` untouched (the
  // promote button shouldn't disable while a demote is in flight).
  async function demote(u: MemberUser) {
    setMsg('');
    try {
      await demoteFromBoard(u.id);
      setMsg('Board member demoted.');
      await reload();
    } catch (err: unknown) {
      const message =
        (err as { message?: string } | null)?.message ?? 'could not demote.';
      setMsg('Error: ' + message);
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
