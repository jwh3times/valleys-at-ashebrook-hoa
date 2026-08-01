import { useState } from 'react';
import {
  fetchBoardPeople,
  saveBoardPerson,
  deleteBoardPerson,
  saveBoardTerm,
  deleteBoardTerm,
} from '../../lib/admin';
import type { BoardPersonWithTerms, BoardTerm } from '../../lib/types';
import { useAdminResource } from './useAdminResource';

const emptyPerson = { fullName: '' };
const emptyTerm = { title: '', termStart: '', termEnd: '' };

export default function BoardPanel() {
  const {
    data: people,
    loading,
    reload,
    busy,
    msg,
    setMsg,
    run,
  } = useAdminResource<BoardPersonWithTerms[]>(fetchBoardPeople, []);

  const [personForm, setPersonForm] = useState(emptyPerson);
  const [editingPersonId, setEditingPersonId] = useState<string | null>(null);

  const [termForm, setTermForm] = useState(emptyTerm);
  const [termPersonId, setTermPersonId] = useState<string | null>(null);
  const [editingTermId, setEditingTermId] = useState<string | null>(null);

  function resetPerson() {
    setEditingPersonId(null);
    setPersonForm(emptyPerson);
  }
  function resetTerm() {
    setEditingTermId(null);
    setTermPersonId(null);
    setTermForm(emptyTerm);
  }
  function toTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function startEditPerson(p: BoardPersonWithTerms) {
    resetTerm();
    setEditingPersonId(p.id);
    setPersonForm({ fullName: p.fullName });
    setMsg('');
    toTop();
  }
  function startAddTerm(personId: string) {
    resetPerson();
    resetTerm();
    setTermPersonId(personId);
    setMsg('');
    toTop();
  }
  function startEditTerm(t: BoardTerm) {
    resetPerson();
    setEditingTermId(t.id);
    setTermPersonId(t.personId);
    setTermForm({
      title: t.title ?? '',
      termStart: t.termStart,
      termEnd: t.termEnd ?? '',
    });
    setMsg('');
    toTop();
  }

  async function submitPerson(e: React.FormEvent) {
    e.preventDefault();
    await run(
      async () => {
        await saveBoardPerson(
          { fullName: personForm.fullName },
          editingPersonId ?? undefined,
        );
        resetPerson();
        await reload();
      },
      editingPersonId ? 'Person updated.' : 'Person added.',
    );
  }

  async function submitTerm(e: React.FormEvent) {
    e.preventDefault();
    await run(
      async () => {
        await saveBoardTerm(
          editingTermId
            ? {
                title: termForm.title || null,
                termStart: termForm.termStart,
                termEnd: termForm.termEnd || null,
              }
            : {
                personId: termPersonId ?? undefined,
                title: termForm.title || null,
                termStart: termForm.termStart,
                termEnd: termForm.termEnd || null,
              },
          editingTermId ?? undefined,
        );
        resetTerm();
        await reload();
      },
      editingTermId ? 'Term updated.' : 'Term added.',
    );
  }

  async function removePerson(p: BoardPersonWithTerms) {
    if (!confirm(`Delete ${p.fullName}? This cannot be undone.`)) return;
    await run(async () => {
      await deleteBoardPerson(p.id);
      await reload();
    }, 'Person removed.');
  }

  async function removeTerm(t: BoardTerm) {
    if (
      !confirm(
        `Delete the term starting ${t.termStart}${t.title ? ` (${t.title})` : ''}? This cannot be undone.`,
      )
    )
      return;
    await run(async () => {
      await deleteBoardTerm(t.id);
      await reload();
    }, 'Term removed.');
  }

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>The Board</h1>
      </div>
      <p className="admin-panel__intro">
        Who serves on the board, in which office, and over which dates. A person
        who leaves and returns keeps one entry with two terms, so their record
        stays together. This is separate from Board access, which controls who
        can sign in to this admin panel.
      </p>

      {msg && (
        <div
          className={
            msg.startsWith('Error:')
              ? 'form-message form-message--error'
              : 'form-message form-message--success'
          }
        >
          {msg}
        </div>
      )}

      <form
        className="panel-card"
        onSubmit={submitPerson}
        style={{ marginBottom: '18px' }}
      >
        <div className="panel-editor__title">
          {editingPersonId ? 'Edit Person' : 'Add Person'}
        </div>
        <div className="field" style={{ marginBottom: '16px' }}>
          <label htmlFor="board-person-name">Full name</label>
          <input
            id="board-person-name"
            type="text"
            value={personForm.fullName}
            onChange={(e) =>
              setPersonForm({ ...personForm, fullName: e.target.value })
            }
            required
          />
        </div>
        <div className="btn-row">
          <button className="btn btn--small" type="submit" disabled={busy}>
            {busy ? 'Saving…' : editingPersonId ? 'Save Person' : 'Add Person'}
          </button>
          {editingPersonId && (
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={resetPerson}
            >
              Cancel
            </button>
          )}
        </div>
      </form>

      {termPersonId && (
        <form
          className="panel-card"
          onSubmit={submitTerm}
          style={{ marginBottom: '26px' }}
        >
          <div className="panel-editor__title">
            {editingTermId ? 'Edit Term' : 'Add Term'}
          </div>
          <div className="field" style={{ marginBottom: '16px' }}>
            <label htmlFor="term-title">Office (optional)</label>
            <input
              id="term-title"
              type="text"
              value={termForm.title}
              onChange={(e) =>
                setTermForm({ ...termForm, title: e.target.value })
              }
              placeholder="President, Treasurer, …"
            />
          </div>
          <div className="field-grid" style={{ marginBottom: '16px' }}>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="term-start">Term start</label>
              <input
                id="term-start"
                type="date"
                value={termForm.termStart}
                onChange={(e) =>
                  setTermForm({ ...termForm, termStart: e.target.value })
                }
                required
              />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="term-end">Term end (blank = still serving)</label>
              <input
                id="term-end"
                type="date"
                value={termForm.termEnd}
                onChange={(e) =>
                  setTermForm({ ...termForm, termEnd: e.target.value })
                }
              />
            </div>
          </div>
          <div className="btn-row">
            <button className="btn btn--small" type="submit" disabled={busy}>
              {busy ? 'Saving…' : editingTermId ? 'Save Term' : 'Add Term'}
            </button>
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={resetTerm}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="panel-list">
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : people.length === 0 ? (
          <p className="muted panel-pad">No board members yet.</p>
        ) : (
          people.map((p) => (
            <div
              key={p.id}
              className="panel-card"
              style={{ marginBottom: '14px' }}
            >
              <div className="list-row">
                <div className="admin-row-main">
                  <div className="admin-row-title">{p.fullName}</div>
                </div>
                <div className="row-actions">
                  <button
                    className="row-link"
                    onClick={() => startEditPerson(p)}
                  >
                    Edit
                  </button>
                  <button
                    className="row-link"
                    aria-label={`Add term for ${p.fullName}`}
                    onClick={() => startAddTerm(p.id)}
                  >
                    Add term
                  </button>
                  <button
                    className="row-link row-link--danger"
                    aria-label={`Delete ${p.fullName}`}
                    onClick={() => removePerson(p)}
                  >
                    Delete
                  </button>
                </div>
              </div>
              {p.terms.map((t) => (
                <div
                  key={t.id}
                  className="list-row"
                  style={{ paddingLeft: '18px' }}
                >
                  <div className="admin-row-main">
                    <div className="admin-row-title">
                      {t.title ?? 'Member'}
                      {t.termEnd === null && (
                        <span className="pinned-badge"> Serving</span>
                      )}
                    </div>
                    <div className="admin-row-sub">
                      {t.termStart} — {t.termEnd ?? 'present'}
                    </div>
                  </div>
                  <div className="row-actions">
                    <button
                      className="row-link"
                      aria-label={`Edit term starting ${t.termStart}`}
                      onClick={() => startEditTerm(t)}
                    >
                      Edit
                    </button>
                    <button
                      className="row-link row-link--danger"
                      aria-label={`Delete term starting ${t.termStart}`}
                      onClick={() => removeTerm(t)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
