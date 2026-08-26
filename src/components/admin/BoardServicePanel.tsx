import { useEffect, useState } from 'react';
import {
  fetchBoardService,
  createBoardTerm,
  endBoardTerm,
  cancelBoardTerm,
  voidBoardTerm,
  substituteQualifyingLot,
  correctBoardTerm,
  assignOffice,
  endOffice,
  voidOffice,
  OFFICES,
} from '../../lib/roster-admin';
import type {
  BoardServiceDetail,
  BoardServiceTermRow,
  BoardOfficeRow,
  BoardTermCreateReason,
  BoardTermEndReason,
  BoardTermCancelReason,
  CorrectBoardTermPatch,
  Office,
} from '../../lib/roster-admin';
import {
  fetchRosterPeople,
  fetchRosterLots,
  fetchElections,
} from '../../lib/admin';
import { associationDateIso } from '../../lib/format';
import { useAdminResource } from './useAdminResource';

// ADR 0022 phase 3e (#221): the Board panel over /api/admin/board-service.
//
// The three ending kinds are three separately named controls — "End term"
// (it ran and stopped), "Cancel term" (it never started), "Void term" (it was
// never a fact). They are disjoint facts with different reason sets, so they
// are never collapsed into one "remove" button with a hidden mode; the record
// would then no longer mean what it says.

const EMPTY: BoardServiceDetail = {
  terms: [],
  offices: [],
  advisories: {
    currentMemberCount: 0,
    belowMinimum: false,
    aboveMaximum: false,
    vacantOffices: [],
    expiringTermIds: [],
    lapsedTermIds: [],
  },
};

const OFFICE_LABELS: Record<Office, string> = {
  president: 'President',
  vice_president: 'Vice President',
  secretary_treasurer: 'Secretary / Treasurer',
};

const CREATE_REASONS: { value: BoardTermCreateReason; label: string }[] = [
  { value: 'elected', label: 'Elected' },
  { value: 'vacancy_appointment', label: 'Appointed to a vacancy' },
];

const END_REASONS: { value: BoardTermEndReason; label: string }[] = [
  { value: 'term_expired', label: 'Term expired' },
  { value: 'resigned', label: 'Resigned' },
  { value: 'removed', label: 'Removed' },
  { value: 'declared_vacant_absences', label: 'Declared vacant (absences)' },
];

const CANCEL_REASONS: { value: BoardTermCancelReason; label: string }[] = [
  { value: 'resigned', label: 'Resigned before the term began' },
  { value: 'removed', label: 'Removed before the term began' },
  { value: 'recorded_in_error', label: 'Recorded in error' },
];

const emptyCreate = {
  personId: '',
  qualifyingLotId: '',
  reasonCode: 'elected' as BoardTermCreateReason,
  startDay: '',
  scheduledEndDay: '',
  electionId: '',
};

// One draft covers every row action; only the fields the open action renders
// are ever read, and the whole draft resets when a different action opens.
const emptyRowForm = {
  endReason: 'term_expired' as BoardTermEndReason,
  endDay: '',
  cancelReason: 'resigned' as BoardTermCancelReason,
  substituteLotId: '',
  correctLotId: '',
  // Three states, because the route decides by KEY PRESENCE: leave the
  // provenance alone, clear it (null), or point it at an election.
  correctElection: 'unchanged' as 'unchanged' | 'clear' | 'set',
  correctElectionId: '',
  office: 'president' as Office,
  officeStartDay: '',
};

type RowActionKind = 'end' | 'cancel' | 'substitute' | 'correct' | 'office';

const cell = { padding: '6px 10px', verticalAlign: 'top' as const };
const headCell = { ...cell, textAlign: 'left' as const };

function termConcluded(t: BoardServiceTermRow): boolean {
  return t.voided || t.actualEndDay !== null || t.cancelledDay !== null;
}

function termStatus(t: BoardServiceTermRow, today: string): string {
  if (t.voided) return 'Voided';
  if (t.cancelledDay) return `Cancelled ${t.cancelledDay}`;
  if (t.actualEndDay) return `Ended ${t.actualEndDay}`;
  if (t.current) return 'Current';
  if (t.startDay > today) return 'Scheduled';
  return 'Concluded';
}

function officeStatus(o: BoardOfficeRow): string {
  if (o.voided) return 'Voided';
  if (o.endDay) return `Ended ${o.endDay}`;
  return o.current ? 'Current' : 'Not current';
}

export default function BoardServicePanel() {
  const {
    data: service,
    loading,
    reload,
    busy,
    msg,
    setMsg,
    run,
  } = useAdminResource<BoardServiceDetail>(fetchBoardService, EMPTY);

  const [createForm, setCreateForm] = useState(emptyCreate);
  const [rowAction, setRowAction] = useState<{
    kind: RowActionKind;
    termId: string;
  } | null>(null);
  const [rowForm, setRowForm] = useState(emptyRowForm);
  const [endingOfficeId, setEndingOfficeId] = useState<string | null>(null);
  const [officeEndDay, setOfficeEndDay] = useState('');

  // Pickers. People and Lots come from the roster read the legacy admin
  // client already exposes for the certification pickers; elections supply the
  // optional provenance link a term may carry.
  const [people, setPeople] = useState<
    { partyId: string; displayName: string }[]
  >([]);
  const [lots, setLots] = useState<{ id: string; address: string }[]>([]);
  const [elections, setElections] = useState<
    { id: string; title: string; electionDate: string }[]
  >([]);

  useEffect(() => {
    // React's documented mount-fetch shape: the load runs in a function
    // declared inside the effect and guarded by `cancelled`, which the cleanup
    // flips so a late response can't write state.
    let cancelled = false;
    async function loadPickers() {
      try {
        const [peopleRows, lotRows, electionRows] = await Promise.all([
          fetchRosterPeople(),
          fetchRosterLots(),
          fetchElections(),
        ]);
        if (cancelled) return;
        setPeople(peopleRows);
        setLots(lotRows);
        setElections(
          electionRows.map((e) => ({
            id: e.id,
            title: e.title,
            electionDate: e.electionDate,
          })),
        );
      } catch (err: unknown) {
        if (cancelled) return;
        const message =
          (err as { message?: string } | null)?.message ??
          'could not load the pickers.';
        setMsg('Error: ' + message);
      }
    }
    void loadPickers();
    return () => {
      cancelled = true;
    };
  }, [setMsg]);

  const today = associationDateIso();
  const termById = new Map(service.terms.map((t) => [t.id, t]));
  const lotLabel = (id: string) => lots.find((l) => l.id === id)?.address ?? id;

  function openRowAction(kind: RowActionKind, term: BoardServiceTermRow) {
    setRowAction({ kind, termId: term.id });
    setRowForm({
      ...emptyRowForm,
      correctLotId: term.qualifyingLotId ?? '',
      substituteLotId: '',
    });
    setMsg('');
  }

  function closeRowAction() {
    setRowAction(null);
    setRowForm(emptyRowForm);
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => {
      await createBoardTerm({
        personId: createForm.personId,
        qualifyingLotId: createForm.qualifyingLotId,
        reasonCode: createForm.reasonCode,
        startDay: createForm.startDay,
        scheduledEndDay: createForm.scheduledEndDay,
        // Omitted rather than sent empty: provenance is optional and the
        // route treats an empty string as an unknown election.
        ...(createForm.electionId ? { electionId: createForm.electionId } : {}),
      });
      setCreateForm(emptyCreate);
      await reload();
    }, 'Term recorded.');
  }

  async function submitRowAction(e: React.FormEvent) {
    e.preventDefault();
    if (!rowAction) return;
    const { kind, termId } = rowAction;
    if (kind === 'end') {
      await run(async () => {
        await endBoardTerm({
          termId,
          reasonCode: rowForm.endReason,
          endDay: rowForm.endDay,
        });
        closeRowAction();
        await reload();
      }, 'Term ended.');
      return;
    }
    if (kind === 'cancel') {
      await run(async () => {
        await cancelBoardTerm({ termId, reasonCode: rowForm.cancelReason });
        closeRowAction();
        await reload();
      }, 'Term cancelled.');
      return;
    }
    if (kind === 'substitute') {
      await run(async () => {
        await substituteQualifyingLot({
          termId,
          qualifyingLotId: rowForm.substituteLotId,
        });
        closeRowAction();
        await reload();
      }, 'Qualifying lot substituted.');
      return;
    }
    if (kind === 'correct') {
      const term = termById.get(termId);
      // Key presence is the contract: only a field the board actually
      // changed is sent, so an untouched field is never rewritten and
      // `electionId: null` can mean "clear this".
      const patch: CorrectBoardTermPatch = {};
      if (
        rowForm.correctLotId &&
        rowForm.correctLotId !== term?.qualifyingLotId
      )
        patch.qualifyingLotId = rowForm.correctLotId;
      if (rowForm.correctElection === 'clear') patch.electionId = null;
      if (rowForm.correctElection === 'set' && rowForm.correctElectionId)
        patch.electionId = rowForm.correctElectionId;
      await run(async () => {
        await correctBoardTerm(termId, patch);
        closeRowAction();
        await reload();
      }, 'Term corrected.');
      return;
    }
    await run(async () => {
      await assignOffice({
        termId,
        office: rowForm.office,
        ...(rowForm.officeStartDay ? { startDay: rowForm.officeStartDay } : {}),
      });
      closeRowAction();
      await reload();
    }, 'Office assigned.');
  }

  function handleVoidTerm(t: BoardServiceTermRow) {
    // confirm() outside run(): the wrapper flips `busy`, and a dialog inside
    // it would hold the panel busy while the prompt sits open.
    if (
      !window.confirm(
        `Void ${t.personName}'s term? A void says the term was never a fact — end or cancel it instead if it really happened.`,
      )
    )
      return;
    void run(async () => {
      await voidBoardTerm(t.id);
      closeRowAction();
      await reload();
    }, 'Term voided.');
  }

  async function submitEndOffice(e: React.FormEvent) {
    e.preventDefault();
    if (!endingOfficeId) return;
    const assignmentId = endingOfficeId;
    const endDay = officeEndDay;
    await run(async () => {
      await endOffice({ assignmentId, ...(endDay ? { endDay } : {}) });
      setEndingOfficeId(null);
      setOfficeEndDay('');
      await reload();
    }, 'Office ended.');
  }

  function handleVoidOffice(o: BoardOfficeRow) {
    if (
      !window.confirm(
        `Void the ${OFFICE_LABELS[o.office]} assignment for ${o.personName}? A void says it was never a fact.`,
      )
    )
      return;
    void run(async () => {
      await voidOffice(o.id);
      await reload();
    }, 'Office voided.');
  }

  const { advisories } = service;
  const expiring = advisories.expiringTermIds
    .map((id) => termById.get(id))
    .filter((t): t is BoardServiceTermRow => t !== undefined);
  const lapsed = advisories.lapsedTermIds
    .map((id) => termById.get(id))
    .filter((t): t is BoardServiceTermRow => t !== undefined);
  const hasAdvisory =
    advisories.belowMinimum ||
    advisories.aboveMaximum ||
    advisories.vacantOffices.length > 0 ||
    advisories.expiringTermIds.length > 0 ||
    advisories.lapsedTermIds.length > 0;

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Board</h1>
      </div>
      <p className="admin-panel__intro">
        Board service terms and office assignments. A term is qualified by a lot
        its holder owns or represents; ending, cancelling, and voiding are three
        different facts, not three ways to delete one.
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

      <div className="panel-card" style={{ marginBottom: '26px' }}>
        <div className="panel-editor__title">Composition</div>
        <p style={{ margin: '0 0 8px' }}>
          {advisories.currentMemberCount} current board{' '}
          {advisories.currentMemberCount === 1 ? 'member' : 'members'}.
        </p>
        {!hasAdvisory && <p className="muted">No advisories.</p>}
        <ul style={{ margin: 0, paddingLeft: '18px' }}>
          {advisories.belowMinimum && <li>Below the three-member minimum.</li>}
          {advisories.aboveMaximum && <li>Above the five-member maximum.</li>}
          {advisories.vacantOffices.length > 0 && (
            <li>
              Vacant{' '}
              {advisories.vacantOffices.length === 1 ? 'office' : 'offices'}:{' '}
              {advisories.vacantOffices.map((o) => OFFICE_LABELS[o]).join(', ')}
              .
            </li>
          )}
          {expiring.map((t) => (
            <li key={`expiring-${t.id}`}>
              Expiring within thirty days: {t.personName} — scheduled end{' '}
              {t.scheduledEndDay}.
            </li>
          ))}
          {lapsed.map((t) => (
            <li key={`lapsed-${t.id}`}>
              Lapsed with no successor recorded: {t.personName} — scheduled end{' '}
              {t.scheduledEndDay}.
            </li>
          ))}
        </ul>
      </div>

      <form
        className="panel-card"
        onSubmit={submitCreate}
        style={{ marginBottom: '26px' }}
      >
        <div className="panel-editor__title">Record a term</div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="term-person">Person</label>
            <select
              id="term-person"
              value={createForm.personId}
              onChange={(e) =>
                setCreateForm({ ...createForm, personId: e.target.value })
              }
              required
            >
              <option value="">— choose a person —</option>
              {people.map((p) => (
                <option key={p.partyId} value={p.partyId}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="term-lot">Qualifying lot</label>
            <select
              id="term-lot"
              value={createForm.qualifyingLotId}
              onChange={(e) =>
                setCreateForm({
                  ...createForm,
                  qualifyingLotId: e.target.value,
                })
              }
              required
            >
              <option value="">— choose a lot —</option>
              {lots.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.address}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="term-start">Start day</label>
            <input
              id="term-start"
              type="date"
              value={createForm.startDay}
              onChange={(e) =>
                setCreateForm({ ...createForm, startDay: e.target.value })
              }
              required
            />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="term-end">Scheduled end day</label>
            <input
              id="term-end"
              type="date"
              value={createForm.scheduledEndDay}
              onChange={(e) =>
                setCreateForm({
                  ...createForm,
                  scheduledEndDay: e.target.value,
                })
              }
              required
            />
          </div>
        </div>
        <div className="field-grid" style={{ marginBottom: '16px' }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="term-reason">Reason</label>
            <select
              id="term-reason"
              value={createForm.reasonCode}
              onChange={(e) =>
                setCreateForm({
                  ...createForm,
                  reasonCode: e.target.value as BoardTermCreateReason,
                })
              }
            >
              {CREATE_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="term-election">Election (optional)</label>
            <select
              id="term-election"
              value={createForm.electionId}
              onChange={(e) =>
                setCreateForm({ ...createForm, electionId: e.target.value })
              }
            >
              <option value="">— no election —</option>
              {elections.map((el) => (
                <option key={el.id} value={el.id}>
                  {el.electionDate} — {el.title}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="btn-row">
          <button className="btn btn--small" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Record term'}
          </button>
        </div>
      </form>

      {rowAction && (
        <form
          className="panel-card"
          onSubmit={submitRowAction}
          style={{ marginBottom: '26px' }}
        >
          <div className="panel-editor__title">
            {rowAction.kind === 'end'
              ? 'End term'
              : rowAction.kind === 'cancel'
                ? 'Cancel term'
                : rowAction.kind === 'substitute'
                  ? 'Substitute qualifying lot'
                  : rowAction.kind === 'correct'
                    ? 'Correct term'
                    : 'Assign office'}
            {' — '}
            {termById.get(rowAction.termId)?.personName ?? rowAction.termId}
          </div>

          {rowAction.kind === 'end' && (
            <div className="field-grid" style={{ marginBottom: '16px' }}>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="end-reason">End reason</label>
                <select
                  id="end-reason"
                  value={rowForm.endReason}
                  onChange={(e) =>
                    setRowForm({
                      ...rowForm,
                      endReason: e.target.value as BoardTermEndReason,
                    })
                  }
                >
                  {END_REASONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="end-day">End day</label>
                <input
                  id="end-day"
                  type="date"
                  value={rowForm.endDay}
                  onChange={(e) =>
                    setRowForm({ ...rowForm, endDay: e.target.value })
                  }
                  required
                />
              </div>
            </div>
          )}

          {rowAction.kind === 'cancel' && (
            <div className="field" style={{ marginBottom: '16px' }}>
              <label htmlFor="cancel-reason">Cancellation reason</label>
              <select
                id="cancel-reason"
                value={rowForm.cancelReason}
                onChange={(e) =>
                  setRowForm({
                    ...rowForm,
                    cancelReason: e.target.value as BoardTermCancelReason,
                  })
                }
              >
                {CANCEL_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {rowAction.kind === 'substitute' && (
            <div className="field" style={{ marginBottom: '16px' }}>
              <label htmlFor="substitute-lot">Replacement qualifying lot</label>
              <select
                id="substitute-lot"
                value={rowForm.substituteLotId}
                onChange={(e) =>
                  setRowForm({ ...rowForm, substituteLotId: e.target.value })
                }
                required
              >
                <option value="">— choose a lot —</option>
                {lots.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.address}
                  </option>
                ))}
              </select>
            </div>
          )}

          {rowAction.kind === 'correct' && (
            <>
              <div className="field" style={{ marginBottom: '16px' }}>
                <label htmlFor="correct-lot">Qualifying lot (correction)</label>
                <select
                  id="correct-lot"
                  value={rowForm.correctLotId}
                  onChange={(e) =>
                    setRowForm({ ...rowForm, correctLotId: e.target.value })
                  }
                >
                  <option value="">— leave unchanged —</option>
                  {lots.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.address}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field-grid" style={{ marginBottom: '16px' }}>
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="correct-election-mode">
                    Election provenance
                  </label>
                  <select
                    id="correct-election-mode"
                    value={rowForm.correctElection}
                    onChange={(e) =>
                      setRowForm({
                        ...rowForm,
                        correctElection: e.target.value as
                          'unchanged' | 'clear' | 'set',
                      })
                    }
                  >
                    <option value="unchanged">Leave unchanged</option>
                    <option value="clear">Clear the election link</option>
                    <option value="set">Point at an election</option>
                  </select>
                </div>
                {rowForm.correctElection === 'set' && (
                  <div className="field" style={{ margin: 0 }}>
                    <label htmlFor="correct-election">Election</label>
                    <select
                      id="correct-election"
                      value={rowForm.correctElectionId}
                      onChange={(e) =>
                        setRowForm({
                          ...rowForm,
                          correctElectionId: e.target.value,
                        })
                      }
                      required
                    >
                      <option value="">— choose an election —</option>
                      {elections.map((el) => (
                        <option key={el.id} value={el.id}>
                          {el.electionDate} — {el.title}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </>
          )}

          {rowAction.kind === 'office' && (
            <div className="field-grid" style={{ marginBottom: '16px' }}>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="assign-office">Office</label>
                <select
                  id="assign-office"
                  value={rowForm.office}
                  onChange={(e) =>
                    setRowForm({ ...rowForm, office: e.target.value as Office })
                  }
                >
                  {OFFICES.map((o) => (
                    <option key={o} value={o}>
                      {OFFICE_LABELS[o]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="assign-office-start">
                  Start day (optional)
                </label>
                <input
                  id="assign-office-start"
                  type="date"
                  value={rowForm.officeStartDay}
                  onChange={(e) =>
                    setRowForm({ ...rowForm, officeStartDay: e.target.value })
                  }
                />
              </div>
            </div>
          )}

          <div className="btn-row">
            <button className="btn btn--small" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Confirm'}
            </button>
            <button
              type="button"
              className="btn btn--outline btn--small"
              onClick={closeRowAction}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="panel-list">
        <h2 style={{ marginBottom: '10px' }}>Terms</h2>
        {loading ? (
          <p className="loading panel-pad">Loading…</p>
        ) : service.terms.length === 0 ? (
          <p className="muted panel-pad">No board terms recorded yet.</p>
        ) : (
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              marginBottom: '26px',
            }}
          >
            <thead>
              <tr>
                <th style={headCell} scope="col">
                  Person
                </th>
                <th style={headCell} scope="col">
                  Qualifying lot
                </th>
                <th style={headCell} scope="col">
                  Term
                </th>
                <th style={headCell} scope="col">
                  Status
                </th>
                <th style={headCell} scope="col">
                  Office
                </th>
                <th style={headCell} scope="col">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {service.terms.map((t) => {
                const held = service.offices.filter(
                  (o) => o.boardTermId === t.id && o.current,
                );
                const concluded = termConcluded(t);
                return (
                  <tr key={t.id}>
                    <td style={cell}>{t.personName}</td>
                    <td style={cell}>
                      {t.qualifyingLotAddress ??
                        (t.qualifyingLotId
                          ? lotLabel(t.qualifyingLotId)
                          : 'None recorded')}
                    </td>
                    <td style={cell}>
                      {t.startDay} → {t.scheduledEndDay}
                    </td>
                    <td style={cell}>{termStatus(t, today)}</td>
                    <td style={cell}>
                      {held.length === 0
                        ? '—'
                        : held.map((o) => OFFICE_LABELS[o.office]).join(', ')}
                    </td>
                    <td style={cell}>
                      <div className="row-actions">
                        {!concluded && (
                          <>
                            <button
                              className="row-link"
                              aria-label={`End term for ${t.personName}`}
                              onClick={() => openRowAction('end', t)}
                            >
                              End term
                            </button>
                            <button
                              className="row-link"
                              aria-label={`Cancel term for ${t.personName}`}
                              onClick={() => openRowAction('cancel', t)}
                            >
                              Cancel term
                            </button>
                          </>
                        )}
                        {!t.voided && (
                          <button
                            className="row-link row-link--danger"
                            aria-label={`Void term for ${t.personName}`}
                            onClick={() => handleVoidTerm(t)}
                          >
                            Void term
                          </button>
                        )}
                        {!concluded && (
                          <>
                            <button
                              className="row-link"
                              aria-label={`Substitute qualifying lot for ${t.personName}`}
                              onClick={() => openRowAction('substitute', t)}
                            >
                              Substitute lot
                            </button>
                            <button
                              className="row-link"
                              aria-label={`Correct term for ${t.personName}`}
                              onClick={() => openRowAction('correct', t)}
                            >
                              Correct term
                            </button>
                            <button
                              className="row-link"
                              aria-label={`Assign office to ${t.personName}`}
                              onClick={() => openRowAction('office', t)}
                            >
                              Assign office
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <h2 style={{ marginBottom: '10px' }}>Offices</h2>
        {loading ? null : service.offices.length === 0 ? (
          <p className="muted panel-pad">No office assignments recorded yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={headCell} scope="col">
                  Person
                </th>
                <th style={headCell} scope="col">
                  Office
                </th>
                <th style={headCell} scope="col">
                  Held
                </th>
                <th style={headCell} scope="col">
                  Status
                </th>
                <th style={headCell} scope="col">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {service.offices.map((o) => (
                <tr key={o.id}>
                  <td style={cell}>{o.personName}</td>
                  <td style={cell}>{OFFICE_LABELS[o.office]}</td>
                  <td style={cell}>
                    {o.startDay} → {o.endDay ?? 'open'}
                  </td>
                  <td style={cell}>{officeStatus(o)}</td>
                  <td style={cell}>
                    <div className="row-actions">
                      {!o.voided && !o.endDay && (
                        <button
                          className="row-link"
                          aria-label={`End ${OFFICE_LABELS[o.office]} for ${o.personName}`}
                          onClick={() => {
                            setEndingOfficeId(o.id);
                            setOfficeEndDay('');
                            setMsg('');
                          }}
                        >
                          End office
                        </button>
                      )}
                      {!o.voided && (
                        <button
                          className="row-link row-link--danger"
                          aria-label={`Void ${OFFICE_LABELS[o.office]} for ${o.personName}`}
                          onClick={() => handleVoidOffice(o)}
                        >
                          Void office
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {endingOfficeId && (
          <form
            className="panel-card"
            onSubmit={submitEndOffice}
            style={{ marginTop: '16px' }}
          >
            <div className="panel-editor__title">End office assignment</div>
            <div className="field" style={{ marginBottom: '16px' }}>
              <label htmlFor="office-end-day">End day (optional)</label>
              <input
                id="office-end-day"
                type="date"
                value={officeEndDay}
                onChange={(e) => setOfficeEndDay(e.target.value)}
              />
            </div>
            <div className="btn-row">
              <button className="btn btn--small" type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Confirm end office'}
              </button>
              <button
                type="button"
                className="btn btn--outline btn--small"
                onClick={() => {
                  setEndingOfficeId(null);
                  setOfficeEndDay('');
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
