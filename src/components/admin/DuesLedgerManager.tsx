import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchDuesLedger,
  fetchDuesEntryEvents,
  postDuesCharge,
  postDuesPayment,
  postDuesAdjustment,
  reverseDuesEntry,
  postBulkAssessment,
  newOperationKey,
  fetchProperties,
} from '../../lib/admin';
import { fetchSiteSettings } from '../../lib/content';
import {
  parseDollarsToCents,
  formatCents,
  describeBalance,
} from '../../lib/money';
import {
  DUES_CHARGE_CATEGORIES,
  DUES_PAYMENT_METHODS,
  type AdminDuesEntryDetail,
  type DuesChargeCategory,
  type DuesPaymentMethod,
  type LotRecordEventDetail,
  type PropertyWithOwners,
} from '../../lib/types';

/**
 * The board's dues ledger (ADR 0025, #295 slice 3).
 *
 * What shapes this panel is that the ledger cannot be edited. Every other
 * admin surface here has an Edit button; this one has "Reverse", which appends
 * the opposite entry and leaves both visible. So the panel has to make the
 * consequences legible BEFORE the click rather than offer an undo after it,
 * and it has to show a running balance, because a list of entries without one
 * is not something a board member can check against anything.
 *
 * Amounts are typed in dollars and sent in whole cents. That conversion lives
 * in `src/lib/money.ts` and is exact by construction, never
 * `parseFloat(x) * 100`.
 *
 * Every write carries an operation key, taken once per form instance and
 * refreshed after a success: a double click sends the same key and posts
 * nothing twice, while a genuine second entry gets a new one.
 */

const CATEGORY_LABELS: Record<DuesChargeCategory, string> = {
  assessment: 'Assessment',
  special_assessment: 'Special assessment',
  late_fee: 'Late fee',
  fine: 'Fine',
  other: 'Other',
};

const METHOD_LABELS: Record<DuesPaymentMethod, string> = {
  online: 'Online',
  check: 'Check',
  cash: 'Cash',
  other: 'Other',
};

/** The methods a board member may record by hand. */
const OFFLINE_METHODS = DUES_PAYMENT_METHODS.filter(
  (m): m is Exclude<DuesPaymentMethod, 'online'> => m !== 'online',
);

const KIND_LABELS: Record<AdminDuesEntryDetail['kind'], string> = {
  charge: 'Charge',
  payment: 'Payment',
  adjustment: 'Adjustment',
  reversal: 'Reversal',
};

type EntryForm = {
  kind: 'charge' | 'payment' | 'adjustment';
  lotId: string;
  category: DuesChargeCategory;
  method: Exclude<DuesPaymentMethod, 'online'>;
  amount: string;
  effectiveDay: string;
  description: string;
  reference: string;
};

const emptyEntry: EntryForm = {
  kind: 'charge',
  lotId: '',
  category: 'assessment',
  method: 'check',
  amount: '',
  effectiveDay: '',
  description: '',
  reference: '',
};

const emptyBulk = {
  category: 'assessment' as DuesChargeCategory,
  amount: '',
  effectiveDay: '',
  description: '',
};

export default function DuesLedgerManager() {
  const [rows, setRows] = useState<AdminDuesEntryDetail[]>([]);
  const [lots, setLots] = useState<PropertyWithOwners[]>([]);
  const [gateOff, setGateOff] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const [filterLotId, setFilterLotId] = useState('');
  const [entry, setEntry] = useState<EntryForm>(emptyEntry);
  const [bulk, setBulk] = useState(emptyBulk);
  const [showBulk, setShowBulk] = useState(false);

  const [reversingId, setReversingId] = useState<string | null>(null);
  const [reverseReason, setReverseReason] = useState('');

  const [historyId, setHistoryId] = useState<string | null>(null);
  const [history, setHistory] = useState<LotRecordEventDetail[]>([]);

  /**
   * One key per form instance. Taken in a ref rather than state so a re-render
   * cannot mint a new one mid-submission — which would turn a retry into a
   * second entry, the exact thing the key exists to prevent.
   */
  const entryKey = useRef(newOperationKey());
  const bulkKey = useRef(newOperationKey());
  const reverseKey = useRef(newOperationKey());

  /** Only the newest read may write; a row action's reload races the filter. */
  const latestRead = useRef(0);

  const refresh = useCallback(
    async (isStale: () => boolean = () => false) => {
      const seq = ++latestRead.current;
      const superseded = () => isStale() || seq !== latestRead.current;
      try {
        const ledger = await fetchDuesLedger(filterLotId || undefined);
        if (superseded()) return;
        setGateOff(!ledger.enabled);
        setRows(ledger.rows);
        setLoadError('');
      } catch (err: unknown) {
        if (superseded()) return;
        setLoadError(
          (err as { message?: string } | null)?.message ??
            'Could not load the ledger.',
        );
      }
    },
    [filterLotId],
  );

  const loadContext = useCallback(async (isStale: () => boolean) => {
    const [site, properties] = await Promise.all([
      fetchSiteSettings().catch(() => null),
      fetchProperties().catch(() => [] as PropertyWithOwners[]),
    ]);
    if (isStale()) return;
    if (site) setGateOff(!(site.officialMode && site.lotRecordsEnabled));
    setLots(properties);
  }, []);

  useEffect(() => {
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
    let ignore = false;
    async function loadLedger() {
      await refresh(() => ignore);
      if (!ignore) setLoading(false);
    }
    void loadLedger();
    return () => {
      ignore = true;
    };
  }, [refresh]);

  async function run(action: () => Promise<void>, successMsg: string) {
    setBusy(true);
    setMsg('');
    try {
      await action();
      await refresh();
      // An empty `successMsg` means the action set its own — the bulk post
      // reports how many lots it reached, which is the whole answer — so it
      // must not be overwritten with nothing here.
      if (successMsg) setMsg(successMsg);
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

  /** What a row control's accessible name says it acts on. */
  const identityOf = (row: AdminDuesEntryDetail) =>
    `${addressOf(row.lotId)}, ${row.effectiveDay}, ${formatCents(row.amountCents)}`;

  /**
   * The balance of whatever is on screen. When the list is filtered to one
   * lot this is that lot's balance; unfiltered it is the association's total,
   * which is labelled as such rather than left to be mistaken for one home's.
   */
  const shownBalance = rows.reduce((sum, r) => sum + r.amountCents, 0);

  function submitEntry(e: React.FormEvent) {
    e.preventDefault();
    const amount = parseDollarsToCents(entry.amount);
    if (!amount.ok) {
      setMsg(`Error: ${amount.error}`);
      return;
    }
    if (!entry.lotId || !entry.effectiveDay || !entry.description.trim()) {
      setMsg('Error: lot, date, and description are all required.');
      return;
    }
    if (entry.kind !== 'adjustment' && amount.cents < 0) {
      setMsg(
        `Error: enter a ${entry.kind} as a positive amount — a credit is an adjustment.`,
      );
      return;
    }

    const common = {
      lotId: entry.lotId,
      amountCents: amount.cents,
      effectiveDay: entry.effectiveDay,
      description: entry.description.trim(),
      ...(entry.reference.trim() ? { reference: entry.reference.trim() } : {}),
      operationKey: entryKey.current,
    };

    void run(async () => {
      if (entry.kind === 'charge')
        await postDuesCharge({ ...common, category: entry.category });
      else if (entry.kind === 'payment')
        await postDuesPayment({ ...common, method: entry.method });
      else await postDuesAdjustment(common);
      // A fresh key only after the post succeeded: a failed attempt must be
      // retryable under the SAME key, or the retry becomes a second entry.
      entryKey.current = newOperationKey();
      setEntry({ ...emptyEntry, lotId: entry.lotId });
    }, 'Entry posted.');
  }

  function submitBulk(e: React.FormEvent) {
    e.preventDefault();
    const amount = parseDollarsToCents(bulk.amount);
    if (!amount.ok) {
      setMsg(`Error: ${amount.error}`);
      return;
    }
    if (!bulk.effectiveDay || !bulk.description.trim()) {
      setMsg('Error: date and description are both required.');
      return;
    }
    void run(async () => {
      const { posted } = await postBulkAssessment({
        category: bulk.category,
        amountCents: amount.cents,
        effectiveDay: bulk.effectiveDay,
        description: bulk.description.trim(),
        operationKey: bulkKey.current,
      });
      bulkKey.current = newOperationKey();
      setBulk(emptyBulk);
      setShowBulk(false);
      setMsg(`Assessment posted to ${posted} lot${posted === 1 ? '' : 's'}.`);
    }, '');
  }

  function toggleHistory(row: AdminDuesEntryDetail) {
    if (historyId === row.id) {
      setHistoryId(null);
      return;
    }
    void (async () => {
      try {
        setHistory(await fetchDuesEntryEvents(row.id));
        setHistoryId(row.id);
      } catch (err: unknown) {
        setMsg(
          'Error: ' +
            ((err as { message?: string } | null)?.message ??
              'could not load the entry history.'),
        );
      }
    })();
  }

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
          <h1>Dues Ledger</h1>
        </div>
        <p className="admin-panel__intro">
          The dues ledger is switched off. It records what each lot owes and has
          paid, and it needs both <strong>Official mode</strong> and{' '}
          <strong>Lot records</strong> turned on in Site Settings. Turn them on
          only once the balances are loaded and checked — a homeowner reading
          their own balance is the point, and a wrong one is worse than none.
        </p>
      </div>
    );

  const banner = loadError ? `Error: ${loadError}` : msg;

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Dues Ledger</h1>
      </div>
      <p className="admin-panel__intro">
        What each lot owes and has paid. Entries are never edited or deleted — a
        mistake is corrected by reversing it, which leaves both the original and
        the correction on the record.
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
            The ledger could not be read, so nothing is shown and nothing can be
            posted. This is not the same as a lot owing nothing.
          </p>
        </div>
      ) : (
        <>
          <form
            className="panel-card"
            onSubmit={submitEntry}
            style={{ marginBottom: '26px' }}
          >
            <div className="panel-editor__title">Post an entry</div>
            <div className="field-grid" style={{ marginBottom: '16px' }}>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="entry-kind">Kind</label>
                <select
                  id="entry-kind"
                  value={entry.kind}
                  disabled={busy}
                  onChange={(e) =>
                    setEntry({
                      ...entry,
                      kind: e.target.value as EntryForm['kind'],
                    })
                  }
                >
                  <option value="charge">Charge — the lot owes this</option>
                  <option value="payment">Payment — the lot paid this</option>
                  <option value="adjustment">
                    Adjustment — a waiver or correction
                  </option>
                </select>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="entry-lot">Lot</label>
                <select
                  id="entry-lot"
                  value={entry.lotId}
                  disabled={busy}
                  onChange={(e) =>
                    setEntry({ ...entry, lotId: e.target.value })
                  }
                >
                  <option value="">— choose a lot —</option>
                  {lots.map((lot) => (
                    <option key={lot.id} value={lot.id}>
                      {lot.address}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="field-grid" style={{ marginBottom: '16px' }}>
              {entry.kind === 'charge' && (
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="entry-category">Category</label>
                  <select
                    id="entry-category"
                    value={entry.category}
                    disabled={busy}
                    onChange={(e) =>
                      setEntry({
                        ...entry,
                        category: e.target.value as DuesChargeCategory,
                      })
                    }
                  >
                    {DUES_CHARGE_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {entry.kind === 'payment' && (
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="entry-method">How it was paid</label>
                  <select
                    id="entry-method"
                    value={entry.method}
                    disabled={busy}
                    onChange={(e) =>
                      setEntry({
                        ...entry,
                        method: e.target.value as EntryForm['method'],
                      })
                    }
                  >
                    {OFFLINE_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {METHOD_LABELS[m]}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="entry-amount">
                  Amount
                  {entry.kind === 'adjustment'
                    ? ' (a minus sign credits the lot)'
                    : ''}
                </label>
                <input
                  id="entry-amount"
                  type="text"
                  inputMode="decimal"
                  placeholder="450.00"
                  value={entry.amount}
                  disabled={busy}
                  onChange={(e) =>
                    setEntry({ ...entry, amount: e.target.value })
                  }
                />
              </div>
            </div>

            <div className="field-grid" style={{ marginBottom: '16px' }}>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="entry-day">Date</label>
                <input
                  id="entry-day"
                  type="date"
                  value={entry.effectiveDay}
                  disabled={busy}
                  onChange={(e) =>
                    setEntry({ ...entry, effectiveDay: e.target.value })
                  }
                />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="entry-description">
                  Description (the homeowner sees this)
                </label>
                <input
                  id="entry-description"
                  type="text"
                  value={entry.description}
                  disabled={busy}
                  onChange={(e) =>
                    setEntry({ ...entry, description: e.target.value })
                  }
                />
              </div>
            </div>

            <div className="field" style={{ marginBottom: '16px' }}>
              <label htmlFor="entry-reference">
                Board reference (never shown to the homeowner) — a check number,
                say
              </label>
              <input
                id="entry-reference"
                type="text"
                value={entry.reference}
                disabled={busy}
                onChange={(e) =>
                  setEntry({ ...entry, reference: e.target.value })
                }
              />
            </div>

            <div className="btn-row">
              <button className="btn btn--small" type="submit" disabled={busy}>
                {busy ? 'Posting…' : 'Post entry'}
              </button>
              <button
                type="button"
                className="btn btn--outline btn--small"
                disabled={busy}
                onClick={() => setShowBulk(!showBulk)}
                aria-expanded={showBulk}
              >
                Post an assessment to every lot
              </button>
            </div>
          </form>

          {showBulk && (
            <form
              className="panel-card"
              onSubmit={submitBulk}
              style={{ marginBottom: '26px' }}
            >
              <div className="panel-editor__title">
                Assessment for every active lot
              </div>
              <p className="muted">
                This posts one charge to every lot that has not been retired.
                Re-running it is safe: a lot that already has this assessment is
                left alone, and a lot added since will receive it.
              </p>
              <div className="field-grid" style={{ marginBottom: '16px' }}>
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="bulk-category">Category</label>
                  <select
                    id="bulk-category"
                    value={bulk.category}
                    disabled={busy}
                    onChange={(e) =>
                      setBulk({
                        ...bulk,
                        category: e.target.value as DuesChargeCategory,
                      })
                    }
                  >
                    {DUES_CHARGE_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="bulk-amount">Amount per lot</label>
                  <input
                    id="bulk-amount"
                    type="text"
                    inputMode="decimal"
                    placeholder="450.00"
                    value={bulk.amount}
                    disabled={busy}
                    onChange={(e) =>
                      setBulk({ ...bulk, amount: e.target.value })
                    }
                  />
                </div>
              </div>
              <div className="field-grid" style={{ marginBottom: '16px' }}>
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="bulk-day">Date</label>
                  <input
                    id="bulk-day"
                    type="date"
                    value={bulk.effectiveDay}
                    disabled={busy}
                    onChange={(e) =>
                      setBulk({ ...bulk, effectiveDay: e.target.value })
                    }
                  />
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="bulk-description">
                    Description (every homeowner sees this)
                  </label>
                  <input
                    id="bulk-description"
                    type="text"
                    value={bulk.description}
                    disabled={busy}
                    onChange={(e) =>
                      setBulk({ ...bulk, description: e.target.value })
                    }
                  />
                </div>
              </div>
              <div className="btn-row">
                <button
                  className="btn btn--small"
                  type="submit"
                  disabled={busy}
                >
                  {busy ? 'Posting…' : 'Post to every active lot'}
                </button>
                <button
                  type="button"
                  className="btn btn--outline btn--small"
                  disabled={busy}
                  onClick={() => setShowBulk(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      )}

      <div className="field" style={{ marginBottom: '16px' }}>
        <label htmlFor="ledger-filter">Show entries for</label>
        <select
          id="ledger-filter"
          value={filterLotId}
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

      {!loadError && rows.length > 0 && (
        <p className="attendance-line">
          {filterLotId
            ? `${addressOf(filterLotId)}: ${describeBalance(shownBalance)}`
            : `All lots together: ${describeBalance(shownBalance)}`}
        </p>
      )}

      <div className="panel-list">
        {loadError ? null : rows.length === 0 ? (
          <p className="muted panel-pad">No entries yet.</p>
        ) : (
          rows.map((row) => (
            <div
              key={row.id}
              className="panel-card"
              style={{ marginBottom: '14px' }}
            >
              <div className="list-row">
                <div className="admin-row-main">
                  <div className="admin-row-title">
                    {formatCents(row.amountCents)} — {KIND_LABELS[row.kind]}
                    {row.category ? ` (${CATEGORY_LABELS[row.category]})` : ''}
                    {row.method ? ` (${METHOD_LABELS[row.method]})` : ''}
                  </div>
                  <div className="admin-row-sub">
                    {addressOf(row.lotId)} · {row.effectiveDay}
                    {row.source === 'provider'
                      ? ' · from the payment provider'
                      : ''}
                  </div>
                  <div style={{ marginTop: '6px' }}>{row.description}</div>
                  {row.reference && (
                    <div
                      className="admin-row-sub"
                      style={{
                        marginTop: '8px',
                        paddingLeft: '10px',
                        borderLeft: '3px solid var(--border-soft)',
                      }}
                    >
                      <strong>Board only</strong> — never shown to the
                      homeowner: {row.reference}
                    </div>
                  )}
                </div>
                <div className="row-actions">
                  {row.kind !== 'reversal' && row.source === 'board' && (
                    <button
                      type="button"
                      className="row-link"
                      disabled={busy}
                      aria-expanded={reversingId === row.id}
                      aria-label={`Reverse entry: ${identityOf(row)}`}
                      onClick={() => {
                        setReverseReason('');
                        setReversingId(reversingId === row.id ? null : row.id);
                      }}
                    >
                      Reverse
                    </button>
                  )}
                  <button
                    type="button"
                    className="row-link"
                    disabled={busy}
                    aria-expanded={historyId === row.id}
                    aria-label={`History of entry: ${identityOf(row)}`}
                    onClick={() => toggleHistory(row)}
                  >
                    History
                  </button>
                </div>
              </div>

              {reversingId === row.id && (
                <div className="panel-pad">
                  <p className="muted">
                    Reversing posts the opposite entry —{' '}
                    {formatCents(-row.amountCents)} — dated today. Both stay on
                    the record and the homeowner sees both. It cannot be undone,
                    and an entry can only be reversed once.
                  </p>
                  <div className="field" style={{ marginBottom: '12px' }}>
                    <label htmlFor={`reverse-why-${row.id}`}>
                      Description for the reversal (the homeowner sees this)
                    </label>
                    <input
                      id={`reverse-why-${row.id}`}
                      type="text"
                      value={reverseReason}
                      disabled={busy}
                      onChange={(e) => setReverseReason(e.target.value)}
                    />
                  </div>
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn btn--small"
                      disabled={busy}
                      aria-label={`Confirm reversing entry: ${identityOf(row)}`}
                      onClick={() => {
                        if (!reverseReason.trim()) {
                          setMsg(
                            'Error: say why, in a line the homeowner will read.',
                          );
                          return;
                        }
                        void run(async () => {
                          await reverseDuesEntry({
                            entryId: row.id,
                            effectiveDay: new Date().toISOString().slice(0, 10),
                            description: reverseReason.trim(),
                            operationKey: reverseKey.current,
                          });
                          reverseKey.current = newOperationKey();
                          setReversingId(null);
                          setReverseReason('');
                        }, 'Entry reversed.');
                      }}
                    >
                      Reverse this entry
                    </button>
                  </div>
                </div>
              )}

              {historyId === row.id && (
                <ol className="panel-pad">
                  {history.map((event) => (
                    <li key={event.id}>
                      Recorded — {new Date(event.recordedAt).toLocaleString()} —
                      by {event.actingAccountId}
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
