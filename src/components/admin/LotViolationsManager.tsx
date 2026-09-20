import { useCallback, useEffect, useState } from 'react';
import {
  fetchLotViolations,
  fetchLotRecordEvents,
  createLotViolation,
  transitionLotViolation,
  editLotViolation,
  fetchProperties,
} from '../../lib/admin';
import {
  LOT_RECORD_REASON_CODES,
  LOT_VIOLATION_CATEGORIES,
  type LotRecordEventDetail,
  type LotRecordReasonCode,
  type LotViolationCategory,
  type LotViolationDetail,
  type PropertyWithOwners,
} from '../../lib/types';

/**
 * The board's Lot Record surface (ADR 0024, #291 slice 3).
 *
 * Two things shape this panel more than the CRUD does.
 *
 * **What it shows belongs to one Lot, not to the association.** Every row is
 * headed by its Lot, and the create form asks for the Lot first, because
 * recording a violation against the wrong Lot publishes it to the wrong
 * people. There is no "all lots" editing mode — the filter narrows a list, it
 * never becomes a bulk action.
 *
 * **Status is not a field.** It moves only through the named actions, which is
 * what lets the record's history describe its lifecycle, so the row offers
 * buttons rather than a dropdown. Voiding is the one that asks a question
 * first: it is the correction path, it is terminal, and the reason is recorded.
 */

const CATEGORY_LABELS: Record<LotViolationCategory, string> = {
  architectural: 'Architectural',
  maintenance: 'Maintenance',
  landscaping: 'Landscaping',
  parking: 'Parking',
  trash: 'Trash',
  pets: 'Pets',
  noise: 'Noise',
  other: 'Other',
};

const REASON_LABELS: Record<LotRecordReasonCode, string> = {
  entered_in_error: 'Entered in error',
  duplicate: 'Duplicate of another record',
  superseded: 'Superseded by a later record',
  homeowner_corrected: 'Homeowner corrected the record',
  board_decision: 'Board decision',
  other: 'Other',
};

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

const STATUS_LABELS: Record<LotViolationDetail['status'], string> = {
  open: 'Open',
  cured: 'Cured',
  closed: 'Closed',
  voided: 'Voided',
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
  const [lots, setLots] = useState<PropertyWithOwners[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
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

  const load = useCallback(async () => {
    const [violations, properties] = await Promise.all([
      fetchLotViolations(filterLotId || undefined),
      fetchProperties(),
    ]);
    return { violations, properties };
  }, [filterLotId]);

  useEffect(() => {
    // The documented mount-fetch shape: a memoized loader as the effect's
    // dependency, started from a function declared inside the callback, with
    // an unmount flag guarding the eventual write.
    let live = true;
    async function loadOnMount() {
      setLoading(true);
      try {
        const { violations, properties } = await load();
        if (!live) return;
        setEnabled(violations.enabled);
        setRows(violations.rows);
        setLots(properties);
      } catch (err: unknown) {
        if (!live) return;
        setMsg(
          'Error: ' +
            ((err as { message?: string } | null)?.message ??
              'could not load lot records.'),
        );
      } finally {
        if (live) setLoading(false);
      }
    }
    void loadOnMount();
    return () => {
      live = false;
    };
  }, [load]);

  async function run(action: () => Promise<void>, successMsg: string) {
    setBusy(true);
    setMsg('');
    try {
      await action();
      const { violations } = await load();
      setEnabled(violations.enabled);
      setRows(violations.rows);
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

  function showHistory(row: LotViolationDetail) {
    if (historyId === row.id) {
      setHistoryId(null);
      return;
    }
    void run(async () => {
      setHistory(await fetchLotRecordEvents(row.id));
      setHistoryId(row.id);
    }, '');
  }

  if (loading)
    return (
      <div className="admin-panel">
        <p className="loading">Loading…</p>
      </div>
    );

  if (!enabled)
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

      <form className="admin-form" onSubmit={submitForm}>
        <h2>{editingId ? 'Correct this violation' : 'Record a violation'}</h2>
        <label>
          Lot
          <select
            value={form.lotId}
            disabled={editingId !== null}
            onChange={(e) => setForm({ ...form, lotId: e.target.value })}
          >
            <option value="">Choose a lot…</option>
            {lots.map((lot) => (
              <option key={lot.id} value={lot.id}>
                {lot.address}
              </option>
            ))}
          </select>
        </label>
        <label>
          Category
          <select
            value={form.category}
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
        </label>
        <label>
          Date observed
          <input
            type="date"
            value={form.effectiveDay}
            onChange={(e) => setForm({ ...form, effectiveDay: e.target.value })}
          />
        </label>
        <label>
          Summary (the homeowner sees this)
          <input
            type="text"
            value={form.summary}
            onChange={(e) => setForm({ ...form, summary: e.target.value })}
          />
        </label>
        <label>
          Board note (never shown to the homeowner)
          <textarea
            value={form.internalNote}
            rows={2}
            onChange={(e) => setForm({ ...form, internalNote: e.target.value })}
          />
        </label>
        <div className="admin-form__actions">
          <button type="submit" disabled={busy}>
            {editingId ? 'Save correction' : 'Record violation'}
          </button>
          {editingId && (
            <button
              type="button"
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

      <label>
        Show violations for
        <select
          value={filterLotId}
          onChange={(e) => setFilterLotId(e.target.value)}
        >
          <option value="">Every lot</option>
          {lots.map((lot) => (
            <option key={lot.id} value={lot.id}>
              {lot.address}
            </option>
          ))}
        </select>
      </label>

      {rows.length === 0 ? (
        <p className="admin-empty">No violations recorded.</p>
      ) : (
        <ul className="admin-list">
          {rows.map((row) => (
            <li key={row.id} className="admin-list__item">
              <div>
                <strong>{addressOf(row.lotId)}</strong> —{' '}
                {CATEGORY_LABELS[row.category]}, {row.effectiveDay} —{' '}
                {STATUS_LABELS[row.status]}
              </div>
              <div>{row.summary}</div>
              {row.internalNote && (
                <div className="admin-list__note">
                  Board note: {row.internalNote}
                </div>
              )}

              <div className="admin-list__actions">
                {ACTIONS[row.status].map(({ action, label }) => (
                  <button
                    key={action}
                    type="button"
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
                      disabled={busy}
                      aria-label={`Correct violation: ${identityOf(row)}`}
                      onClick={() => startEdit(row)}
                    >
                      Correct
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Void violation: ${identityOf(row)}`}
                      onClick={() =>
                        setVoidingId(voidingId === row.id ? null : row.id)
                      }
                    >
                      Void
                    </button>
                  </>
                )}
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`History of violation: ${identityOf(row)}`}
                  onClick={() => showHistory(row)}
                >
                  History
                </button>
              </div>

              {voidingId === row.id && (
                <div className="admin-list__form">
                  <p>
                    Voiding keeps the record here and removes it from the
                    lot&rsquo;s own view. It cannot be undone, and a voided
                    record cannot be corrected — record a new violation instead.
                  </p>
                  <label>
                    Reason
                    <select
                      value={voidReason}
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
                  </label>
                  <button
                    type="button"
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
              )}

              {historyId === row.id && (
                <ol className="admin-list__history">
                  {history.map((event) => (
                    <li key={event.id}>
                      {event.action}
                      {event.reasonCode
                        ? ` — ${REASON_LABELS[event.reasonCode]}`
                        : ''}{' '}
                      — {new Date(event.recordedAt).toLocaleString()}
                    </li>
                  ))}
                </ol>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
