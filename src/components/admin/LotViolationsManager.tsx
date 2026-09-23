import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchLotViolations,
  fetchLotRecordEvents,
  createLotViolation,
  transitionLotViolation,
  editLotViolation,
  fetchLots,
} from '../../lib/admin';
import { fetchSiteSettings } from '../../lib/content';
import {
  LOT_RECORD_REASON_CODES,
  LOT_VIOLATION_CATEGORIES,
  type LotRecordEventDetail,
  type LotRecordReasonCode,
  type LotViolationCategory,
  type LotViolationDetail,
  type LotSummary,
} from '../../lib/types';
// Shared with the homeowner page, so the board and the homeowner cannot word
// the same category differently.
import {
  LOT_RECORD_EVENT_LABELS as EVENT_LABELS,
  LOT_RECORD_REASON_LABELS as REASON_LABELS,
  LOT_VIOLATION_CATEGORY_LABELS as CATEGORY_LABELS,
  LOT_VIOLATION_STATUS_LABELS as STATUS_LABELS,
} from '../../lib/lot-records';

/**
 * The board's Lot Record surface (ADR 0024, #291 slice 3).
 *
 * Three things shape this panel more than the CRUD does.
 *
 * **What it shows belongs to one Lot, not to the association.** Every row is
 * headed by its Lot, and the create form asks for the Lot first, because
 * recording a violation against the wrong Lot publishes it to the wrong
 * people. The filter narrows a list; it never becomes a bulk action, and it is
 * locked while a write is in flight so the list and the filter cannot disagree
 * about which Lot is on screen.
 *
 * **Status is not a field.** It moves only through the named actions, which is
 * what lets the record's history describe its lifecycle, so the row offers
 * buttons rather than a dropdown. Voiding asks first: it is the correction
 * path, it is terminal, and its reason is recorded.
 *
 * **A failed read is not an empty list.** "No violations recorded" is a claim
 * about a Lot, and making it when the truth is "we could not read" is the most
 * consequential thing this panel could get wrong. A load failure suppresses
 * both the empty state and the create form, which could not work anyway
 * without the Lot list.
 */

/** The actions each status offers, in the order a board member wants them. */
const ACTIONS: Record<
  LotViolationDetail['status'],
  { action: 'cure' | 'close' | 'reopen'; label: string }[]
> = {
  open: [
    { action: 'cure', label: 'Cured' },
    { action: 'close', label: 'Close' },
  ],
  cured: [{ action: 'close', label: 'Close' }],
  closed: [{ action: 'reopen', label: 'Reopen' }],
  voided: [],
};

const emptyForm = {
  lotId: '',
  category: 'other' as LotViolationCategory,
  effectiveDay: '',
  summary: '',
  internalNote: '',
};

export default function LotViolationsManager() {
  const [rows, setRows] = useState<LotViolationDetail[]>([]);
  const [lots, setLots] = useState<LotSummary[]>([]);
  const [gateOff, setGateOff] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const [filterLotId, setFilterLotId] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);

  /** Which record is being voided, and with which reason. */
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [voidReason, setVoidReason] =
    useState<LotRecordReasonCode>('entered_in_error');

  /** Which record's history is open, and what it holds. */
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [history, setHistory] = useState<LotRecordEventDetail[]>([]);

  /**
   * Every read is numbered, and only the newest may write. The mount effect
   * has its own unmount flag, but a row action's reload has no effect to hang
   * a flag on — and it races the filter's reload, which is how one Lot's
   * records can land under another Lot's heading.
   */
  const latestRead = useRef(0);

  const refresh = useCallback(
    async (isStale: () => boolean = () => false) => {
      const seq = ++latestRead.current;
      const superseded = () => isStale() || seq !== latestRead.current;
      try {
        const violations = await fetchLotViolations(filterLotId || undefined);
        if (superseded()) return;
        setGateOff(!violations.enabled);
        setRows(violations.rows);
        setLoadError('');
      } catch (err: unknown) {
        if (superseded()) return;
        setLoadError(
          (err as { message?: string } | null)?.message ??
            'Could not load lot records.',
        );
      }
    },
    [filterLotId],
  );

  /**
   * The Lot list and the gate, read once. They are a separate loader from the
   * records on purpose: they do not change when the filter does, and reloading
   * them after every row action would refetch the whole property table to
   * throw it away.
   *
   * The gate is read here rather than inferred from the API's 404, so an
   * unexplained 404 — a renamed route, a client bundle ahead of its deploy —
   * cannot masquerade as "the feature is switched off" and send the board to a
   * Site Settings page where the switch is already on.
   */
  const loadContext = useCallback(async (isStale: () => boolean) => {
    const [site, properties] = await Promise.all([
      fetchSiteSettings().catch(() => null),
      fetchLots().catch(() => [] as LotSummary[]),
    ]);
    if (isStale()) return;
    if (site) setGateOff(!(site.officialMode && site.lotRecordsEnabled));
    setLots(properties);
  }, []);

  useEffect(() => {
    // The documented mount-fetch shape: a memoized loader as the effect's
    // dependency, started from a function declared inside the callback, with a
    // flag the cleanup flips so a late response cannot write.
    let ignore = false;
    async function loadOnMount() {
      await loadContext(() => ignore);
    }
    void loadOnMount();
    return () => {
      ignore = true;
    };
  }, [loadContext]);

  useEffect(() => {
    // The records, reloaded whenever the filter changes. Only the first load
    // replaces the panel with "Loading…"; a filter change keeps the list and
    // its controls mounted, so focus stays where the board member put it.
    let ignore = false;
    async function loadRecords() {
      await refresh(() => ignore);
      if (!ignore) setLoading(false);
    }
    void loadRecords();
    return () => {
      ignore = true;
    };
  }, [refresh]);

  /** A write, then a reload of the records only — the Lot list has not moved. */
  async function run(action: () => Promise<void>, successMsg: string) {
    setBusy(true);
    setMsg('');
    try {
      await action();
      await refresh();
      setMsg(successMsg);
    } catch (err: unknown) {
      setMsg(
        'Error: ' +
          ((err as { message?: string } | null)?.message ?? 'action failed.'),
      );
    } finally {
      setBusy(false);
    }
  }

  const addressOf = (lotId: string) =>
    lots.find((l) => l.id === lotId)?.address ?? lotId;

  /** The row's visible identity, for accessible names on its controls. */
  const identityOf = (row: LotViolationDetail) =>
    `${addressOf(row.lotId)}: ${row.summary}`;

  function submitForm(e: React.FormEvent) {
    e.preventDefault();
    const summary = form.summary.trim();
    if (!form.lotId || !form.effectiveDay || !summary) {
      setMsg('Error: lot, date, and summary are all required.');
      return;
    }
    const note = form.internalNote.trim();
    if (editingId) {
      const id = editingId;
      void run(async () => {
        // No lotId and no status: `edit` owns neither, and the lot IS the
        // audience.
        await editLotViolation(id, {
          category: form.category,
          effectiveDay: form.effectiveDay,
          summary,
          internalNote: note,
        });
        setEditingId(null);
        setForm(emptyForm);
      }, 'Violation updated.');
      return;
    }
    void run(async () => {
      await createLotViolation({
        lotId: form.lotId,
        category: form.category,
        effectiveDay: form.effectiveDay,
        summary,
        ...(note ? { internalNote: note } : {}),
      });
      // Inside the action, after the await: a failed create keeps the lot the
      // board chose, so a retry cannot attach to a different one.
      setForm(emptyForm);
    }, 'Violation recorded.');
  }

  function startEdit(row: LotViolationDetail) {
    setEditingId(row.id);
    setForm({
      lotId: row.lotId,
      category: row.category,
      effectiveDay: row.effectiveDay,
      summary: row.summary,
      internalNote: row.internalNote ?? '',
    });
  }

  function toggleVoid(row: LotViolationDetail) {
    const opening = voidingId !== row.id;
    // Reset the reason per record: a code chosen for one violation must never
    // ride along to the next, because it lands in that record's own history.
    setVoidReason('entered_in_error');
    setVoidingId(opening ? row.id : null);
  }

  function toggleHistory(row: LotViolationDetail) {
    if (historyId === row.id) {
      setHistoryId(null);
      return;
    }
    // Deliberately not through `run`: opening a history is a read, and it must
    // not clear the banner reporting what the last write did.
    void (async () => {
      try {
        setHistory(await fetchLotRecordEvents(row.id));
        setHistoryId(row.id);
      } catch (err: unknown) {
        setMsg(
          'Error: ' +
            ((err as { message?: string } | null)?.message ??
              'could not load the record history.'),
        );
      }
    })();
  }

  // Only the first load replaces the panel. A filter change keeps the list and
  // its controls mounted, so focus stays where the board member put it.
  if (loading)
    return (
      <div className="admin-panel">
        <p className="loading panel-pad">Loading…</p>
      </div>
    );

  if (gateOff)
    return (
      <div className="admin-panel">
        <div className="admin-bar">
          <h1>Lot Records</h1>
        </div>
        <p className="admin-panel__intro">
          Lot records are switched off. They hold what belongs to one lot rather
          than to the association — dues balances and violations — and they need
          both <strong>Official mode</strong> and <strong>Lot records</strong>{' '}
          turned on in Site Settings before anything can be recorded or shown.
          Turn them on only once the records are loaded and checked: a homeowner
          reading their own record is the point, and a wrong one is worse than
          none.
        </p>
      </div>
    );

  const banner = loadError ? `Error: ${loadError}` : msg;

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Lot Records</h1>
      </div>
      <p className="admin-panel__intro">
        Violations recorded against one lot. Everyone who holds that lot sees
        them — co-owners and an organization&rsquo;s representatives alike —
        from the day their ownership began. Board notes stay here and are never
        shown to a homeowner.
      </p>

      {banner && (
        <div
          className={
            banner.startsWith('Error:')
              ? 'form-message form-message--error'
              : 'form-message form-message--success'
          }
        >
          {banner}
        </div>
      )}

      {loadError ? (
        <div className="panel-card" style={{ marginBottom: '26px' }}>
          <p className="muted" style={{ margin: 0 }}>
            The records could not be read, so nothing is shown and nothing can
            be recorded. This is not the same as a lot having no violations.
          </p>
        </div>
      ) : (
        <form
          className="panel-card"
          onSubmit={submitForm}
          style={{ marginBottom: '26px' }}
        >
          <div className="panel-editor__title">
            {editingId ? 'Correct this violation' : 'Record a violation'}
          </div>
          <div className="field-grid" style={{ marginBottom: '16px' }}>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="violation-lot">Lot</label>
              <select
                id="violation-lot"
                value={form.lotId}
                // The lot is the audience, so it is fixed once a record
                // exists; the server refuses to move it either.
                disabled={editingId !== null || busy}
                onChange={(e) => setForm({ ...form, lotId: e.target.value })}
              >
                <option value="">— choose a lot —</option>
                {lots.map((lot) => (
                  <option key={lot.id} value={lot.id}>
                    {lot.address}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="violation-category">Category</label>
              <select
                id="violation-category"
                value={form.category}
                disabled={busy}
                onChange={(e) =>
                  setForm({
                    ...form,
                    category: e.target.value as LotViolationCategory,
                  })
                }
              >
                {LOT_VIOLATION_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field-grid" style={{ marginBottom: '16px' }}>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="violation-day">Date observed</label>
              <input
                id="violation-day"
                type="date"
                value={form.effectiveDay}
                disabled={busy}
                onChange={(e) =>
                  setForm({ ...form, effectiveDay: e.target.value })
                }
              />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="violation-summary">
                Summary (the homeowner sees this)
              </label>
              <input
                id="violation-summary"
                type="text"
                value={form.summary}
                disabled={busy}
                onChange={(e) => setForm({ ...form, summary: e.target.value })}
              />
            </div>
          </div>
          <div className="field" style={{ marginBottom: '16px' }}>
            <label htmlFor="violation-note">
              Board note (never shown to the homeowner)
            </label>
            <textarea
              id="violation-note"
              value={form.internalNote}
              rows={2}
              disabled={busy}
              onChange={(e) =>
                setForm({ ...form, internalNote: e.target.value })
              }
            />
          </div>
          <div className="btn-row">
            <button className="btn btn--small" type="submit" disabled={busy}>
              {busy
                ? 'Saving…'
                : editingId
                  ? 'Save correction'
                  : 'Record violation'}
            </button>
            {editingId && (
              <button
                type="button"
                className="btn btn--outline btn--small"
                disabled={busy}
                onClick={() => {
                  setEditingId(null);
                  setForm(emptyForm);
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      )}

      <div className="field" style={{ marginBottom: '16px' }}>
        <label htmlFor="violation-filter">Show violations for</label>
        <select
          id="violation-filter"
          value={filterLotId}
          // Locked during a write: the list is reloaded when the write
          // returns, and a filter changed mid-flight would label those rows
          // with the wrong lot.
          disabled={busy}
          onChange={(e) => setFilterLotId(e.target.value)}
        >
          <option value="">Every lot</option>
          {lots.map((lot) => (
            <option key={lot.id} value={lot.id}>
              {lot.address}
            </option>
          ))}
        </select>
      </div>

      <div className="panel-list">
        {loadError ? null : rows.length === 0 ? (
          <p className="muted panel-pad">No violations recorded.</p>
        ) : (
          rows.map((row) => (
            <div
              key={row.id}
              className="panel-card"
              style={{ marginBottom: '14px' }}
            >
              <div className="list-row">
                <div className="admin-row-main">
                  <div className="admin-row-title">{addressOf(row.lotId)}</div>
                  <div className="admin-row-sub">
                    {CATEGORY_LABELS[row.category]} · {row.effectiveDay} ·{' '}
                    {STATUS_LABELS[row.status]}
                  </div>
                  <div style={{ marginTop: '6px' }}>{row.summary}</div>
                  {row.internalNote && (
                    <div
                      className="admin-row-sub"
                      style={{
                        marginTop: '8px',
                        paddingLeft: '10px',
                        borderLeft: '3px solid var(--border-soft)',
                      }}
                    >
                      <strong>Board only</strong> — never shown to the
                      homeowner: {row.internalNote}
                    </div>
                  )}
                </div>
                <div className="row-actions">
                  {ACTIONS[row.status].map(({ action, label }) => (
                    <button
                      key={action}
                      type="button"
                      className="row-link"
                      disabled={busy}
                      aria-label={`${label} violation: ${identityOf(row)}`}
                      onClick={() =>
                        void run(
                          () => transitionLotViolation(action, row.id),
                          `Violation marked ${label.toLowerCase()}.`,
                        )
                      }
                    >
                      {label}
                    </button>
                  ))}
                  {row.status !== 'voided' && (
                    <>
                      <button
                        type="button"
                        className="row-link"
                        disabled={busy}
                        aria-label={`Correct violation: ${identityOf(row)}`}
                        onClick={() => startEdit(row)}
                      >
                        Correct
                      </button>
                      <button
                        type="button"
                        className="row-link"
                        disabled={busy}
                        aria-expanded={voidingId === row.id}
                        aria-label={`Void violation: ${identityOf(row)}`}
                        onClick={() => toggleVoid(row)}
                      >
                        Void
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="row-link"
                    disabled={busy}
                    aria-expanded={historyId === row.id}
                    aria-label={`History of violation: ${identityOf(row)}`}
                    onClick={() => toggleHistory(row)}
                  >
                    History
                  </button>
                </div>
              </div>

              {voidingId === row.id && (
                <div className="panel-pad">
                  <p className="muted">
                    Voiding keeps the record here and removes it from the
                    lot&rsquo;s own view. It cannot be undone, and a voided
                    record cannot be corrected — record a new violation instead.
                  </p>
                  <div className="field" style={{ marginBottom: '12px' }}>
                    <label htmlFor={`void-reason-${row.id}`}>Reason</label>
                    <select
                      id={`void-reason-${row.id}`}
                      value={voidReason}
                      disabled={busy}
                      onChange={(e) =>
                        setVoidReason(e.target.value as LotRecordReasonCode)
                      }
                    >
                      {LOT_RECORD_REASON_CODES.map((code) => (
                        <option key={code} value={code}>
                          {REASON_LABELS[code]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn btn--small"
                      disabled={busy}
                      aria-label={`Confirm voiding violation: ${identityOf(row)}`}
                      onClick={() =>
                        void run(async () => {
                          await transitionLotViolation(
                            'void',
                            row.id,
                            voidReason,
                          );
                          setVoidingId(null);
                        }, 'Violation voided.')
                      }
                    >
                      Void this violation
                    </button>
                  </div>
                </div>
              )}

              {historyId === row.id && (
                <ol className="panel-pad">
                  {history.map((event) => (
                    <li key={event.id}>
                      {EVENT_LABELS[event.action]}
                      {event.reasonCode
                        ? ` — ${REASON_LABELS[event.reasonCode]}`
                        : ''}{' '}
                      — {new Date(event.recordedAt).toLocaleString()} — by{' '}
                      {event.actingAccountId}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
