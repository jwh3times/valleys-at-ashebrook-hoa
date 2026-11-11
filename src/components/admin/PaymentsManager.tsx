import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyUnmatchedPayment,
  exportProviderEntries,
  fetchBoardPayment,
  fetchBoardPayments,
  fetchLots,
  newOperationKey,
  resolvePaymentException,
  resyncBoardPayment,
} from '../../lib/admin';
import { formatCents } from '../../lib/money';
import { associationDateIso, formatDate } from '../../lib/format';
import { DUES_LEDGER_KIND_LABELS } from '../../lib/lot-records';
import {
  PAYMENT_EVENT_OUTCOME_LABELS,
  PAYMENT_EVENT_TYPE_LABELS,
  PAYMENT_EVENT_VIA_LABELS,
  PAYMENT_EXCEPTION_REASON_LABELS,
  PAYMENT_RESOLUTION_LABELS,
  PAYMENT_STATUS_LABELS,
  paymentReference,
  paymentStatusLabel,
} from '../../lib/payments';
import {
  BOARD_PAYMENT_RESOLUTIONS,
  MAX_RESOLUTION_NOTE_LENGTH,
  PAYMENT_STATUSES,
  type AdminOpenPaymentException,
  type AdminPaymentDetail,
  type AdminPaymentSummary,
  type BoardPaymentResolution,
  type LotSummary,
  type PaymentStatus,
} from '../../lib/types';

/**
 * The board's Payments panel (ADR 0025, #545), beside Dues ledger.
 *
 * It exists to answer "I paid, and the ledger says I didn't": a payment's
 * detail puts every fact the provider reported beside the ledger entries
 * those facts wrote and the exceptions they opened. From there the board can
 * ask the provider again (re-sync), close an exception with a reason, and
 * apply a payment taken outside the site to the Lot it was for.
 *
 * Nothing here edits a record. A resolution is an appended row, and applying
 * a payment writes the credit through the same path as every provider fact,
 * so it can only ever credit once.
 *
 * Each write form takes an operation key when it OPENS, kept while it is open
 * so a retry after a failure is the same submission, and replaced after a
 * success.
 */

/** The Association Day an instant fell on, as a date: never the UTC day. */
const onDay = (iso: string) => formatDate(associationDateIso(new Date(iso)));

const errorText = (err: unknown, fallback: string) =>
  (err as { message?: string } | null)?.message ?? fallback;

export default function PaymentsManager() {
  const [payments, setPayments] = useState<AdminPaymentSummary[]>([]);
  const [exceptions, setExceptions] = useState<AdminOpenPaymentException[]>([]);
  const [lots, setLots] = useState<LotSummary[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const [filterLotId, setFilterLotId] = useState('');
  const [filterStatus, setFilterStatus] = useState<PaymentStatus | ''>('');

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminPaymentDetail | null>(null);

  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolution, setResolution] =
    useState<BoardPaymentResolution>('reviewed_no_action');
  const [note, setNote] = useState('');
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [applyLotId, setApplyLotId] = useState('');
  const [exportFrom, setExportFrom] = useState('');
  const [exportTo, setExportTo] = useState('');

  /**
   * The open form's key, minted when it opens. A ref, so a re-render cannot
   * replace it mid-submission and turn a retry into a second write.
   */
  const resolveKey = useRef('');
  const applyKey = useRef('');

  /** Only the newest read may write; a row action's reload races the filter. */
  const latestRead = useRef(0);
  /** The same for a payment's detail: the last Details clicked wins. */
  const latestDetail = useRef(0);

  const refresh = useCallback(
    async (isStale: () => boolean = () => false) => {
      const seq = ++latestRead.current;
      const superseded = () => isStale() || seq !== latestRead.current;
      try {
        const answer = await fetchBoardPayments({
          lotId: filterLotId || undefined,
          status: filterStatus || undefined,
        });
        if (superseded()) return;
        setConfigured(answer.enabled);
        setPayments(answer.payments);
        setExceptions(answer.exceptions);
        setLoadError('');
      } catch (err: unknown) {
        if (superseded()) return;
        setLoadError(errorText(err, 'Could not load the payments.'));
      }
    },
    [filterLotId, filterStatus],
  );

  const loadLots = useCallback(async (isStale: () => boolean) => {
    const properties = await fetchLots().catch(() => [] as LotSummary[]);
    if (!isStale()) setLots(properties);
  }, []);

  useEffect(() => {
    let ignore = false;
    async function loadOnMount() {
      await loadLots(() => ignore);
    }
    void loadOnMount();
    return () => {
      ignore = true;
    };
  }, [loadLots]);

  useEffect(() => {
    let ignore = false;
    async function loadPayments() {
      await refresh(() => ignore);
      if (!ignore) setLoading(false);
    }
    void loadPayments();
    return () => {
      ignore = true;
    };
  }, [refresh]);

  async function showDetail(paymentId: string) {
    const seq = ++latestDetail.current;
    const read = await fetchBoardPayment(paymentId);
    if (seq !== latestDetail.current) return;
    setDetail(read);
    setDetailId(paymentId);
  }

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setMsg('');
    try {
      const done = await action();
      await refresh();
      // The write succeeded whatever happens here: a detail that cannot be
      // read again is closed rather than reported as the action failing.
      if (detailId)
        await showDetail(detailId).catch(() => {
          setDetailId(null);
          setDetail(null);
        });
      setMsg(done);
    } catch (err: unknown) {
      setMsg(`Error: ${errorText(err, 'action failed.')}`);
    } finally {
      setBusy(false);
    }
  }

  const addressOf = (lotId: string | null) =>
    lotId === null
      ? 'no lot'
      : (lots.find((l) => l.id === lotId)?.address ?? lotId);

  /**
   * What a payment row's controls say they act on, from what the row shows:
   * its Payment Reference (#562), which every payment has.
   */
  const paymentIdentity = (p: AdminPaymentSummary) => paymentReference(p.id);
  /**
   * What an exception's controls say they act on, likewise: its payment's
   * Payment Reference, or with no payment the provider's reference, or with
   * neither its Lot and the day it opened.
   */
  const exceptionIdentity = (x: AdminOpenPaymentException) =>
    `${PAYMENT_EXCEPTION_REASON_LABELS[x.reason]}, ${
      x.paymentId !== null
        ? paymentReference(x.paymentId)
        : (x.providerPaymentRef ??
          `${addressOf(x.lotId)}, opened ${onDay(x.openedAt)}`)
    }`;

  function toggleDetail(p: AdminPaymentSummary) {
    if (detailId === p.id) {
      // A read still in flight must not reopen what was just closed.
      latestDetail.current += 1;
      setDetailId(null);
      setDetail(null);
      return;
    }
    void (async () => {
      try {
        await showDetail(p.id);
      } catch (err: unknown) {
        setMsg(`Error: ${errorText(err, 'could not load the payment.')}`);
      }
    })();
  }

  function resync(p: AdminPaymentSummary) {
    void run(async () => {
      const { recorded } = await resyncBoardPayment(p.id);
      return recorded === 0
        ? 'Nothing new from the provider for this payment.'
        : `${recorded} new fact${recorded === 1 ? '' : 's'} recorded from the provider.`;
    });
  }

  function openResolve(x: AdminOpenPaymentException) {
    if (resolvingId === x.id) {
      setResolvingId(null);
      return;
    }
    resolveKey.current = newOperationKey();
    setResolution('reviewed_no_action');
    setNote('');
    setApplyingId(null);
    setResolvingId(x.id);
  }

  function submitResolve(x: AdminOpenPaymentException) {
    const trimmed = note.trim();
    if (resolution === 'other' && !trimmed) {
      setMsg('Error: say what was decided, in the board-only note.');
      return;
    }
    void run(async () => {
      await resolvePaymentException({
        exceptionId: x.id,
        resolution,
        ...(trimmed ? { note: trimmed } : {}),
        operationKey: resolveKey.current,
      });
      resolveKey.current = '';
      setResolvingId(null);
      return 'Exception resolved.';
    });
  }

  function openApply(x: AdminOpenPaymentException) {
    if (applyingId === x.id) {
      setApplyingId(null);
      return;
    }
    applyKey.current = newOperationKey();
    setApplyLotId('');
    setResolvingId(null);
    setApplyingId(x.id);
  }

  function submitApply(x: AdminOpenPaymentException) {
    if (!applyLotId) {
      setMsg('Error: choose the lot this payment was for.');
      return;
    }
    const lotId = applyLotId;
    void run(async () => {
      await applyUnmatchedPayment({
        exceptionId: x.id,
        lotId,
        operationKey: applyKey.current,
      });
      applyKey.current = '';
      setApplyingId(null);
      return `Payment applied to ${addressOf(lotId)}.`;
    });
  }

  /**
   * Reads, so it writes nothing, takes no key and reloads nothing: the file
   * is the whole answer.
   */
  function submitExport() {
    if (!exportFrom || !exportTo) {
      setMsg('Error: choose the first and last day to export.');
      return;
    }
    if (exportTo < exportFrom) {
      setMsg('Error: the last day must not be before the first.');
      return;
    }
    const range = { from: exportFrom, to: exportTo };
    setBusy(true);
    setMsg('');
    void (async () => {
      try {
        downloadCsv(
          await exportProviderEntries(range),
          `provider-entries-${range.from}-to-${range.to}.csv`,
        );
        setMsg(
          `Exported the provider's entries from ${formatDate(range.from)} through ${formatDate(range.to)}.`,
        );
      } catch (err: unknown) {
        setMsg(`Error: ${errorText(err, 'the export failed.')}`);
      } finally {
        setBusy(false);
      }
    })();
  }

  if (loading)
    return (
      <div className="admin-panel">
        <p className="loading panel-pad">Loading…</p>
      </div>
    );

  if (!configured)
    return (
      <div className="admin-panel">
        <div className="admin-bar">
          <h1>Payments</h1>
        </div>
        <p className="admin-panel__intro">
          No payment provider is configured, so there are no online payments to
          show. This panel lists them, and the questions they raise for the
          board, once one is.
        </p>
      </div>
    );

  const banner = loadError ? `Error: ${loadError}` : msg;

  return (
    <div className="admin-panel">
      <div className="admin-bar">
        <h1>Payments</h1>
      </div>
      <p className="admin-panel__intro">
        Payments made online, everything the payment provider reported about
        each, and the questions it left for the board. Nothing here edits a
        record: resolving an exception adds a note of what was decided.
      </p>

      {banner && (
        <div
          className={
            banner.startsWith('Error:')
              ? 'form-message form-message--error'
              : 'form-message form-message--success'
          }
          role="status"
        >
          {banner}
        </div>
      )}

      <h2 className="panel-editor__title">Exceptions to review</h2>
      <div className="panel-list" style={{ marginBottom: '26px' }}>
        {loadError ? null : exceptions.length === 0 ? (
          <p className="muted panel-pad">Nothing waiting for the board.</p>
        ) : (
          exceptions.map((x) => (
            <div
              key={x.id}
              className="panel-card"
              style={{ marginBottom: '14px' }}
            >
              <div className="list-row">
                <div className="admin-row-main">
                  <div className="admin-row-title">
                    {PAYMENT_EXCEPTION_REASON_LABELS[x.reason]}
                  </div>
                  <div className="muted">
                    {x.fact
                      ? `${formatCents(x.fact.amountCents)}${x.fact.currency === 'usd' ? '' : ` ${x.fact.currency.toUpperCase()}`} · `
                      : ''}
                    {`${addressOf(x.lotId)} · ${
                      x.paymentId !== null
                        ? `Payment Reference ${paymentReference(x.paymentId)} · `
                        : ''
                    }provider reference ${x.providerPaymentRef ?? 'none'} · opened ${onDay(x.openedAt)}`}
                  </div>
                </div>
                <div className="row-actions">
                  {x.applicable && (
                    <button
                      type="button"
                      className="row-link"
                      disabled={busy}
                      aria-expanded={applyingId === x.id}
                      aria-label={`Apply payment to a lot: ${x.providerPaymentRef}`}
                      onClick={() => openApply(x)}
                    >
                      Apply to a lot
                    </button>
                  )}
                  <button
                    type="button"
                    className="row-link"
                    disabled={busy}
                    aria-expanded={resolvingId === x.id}
                    aria-label={`Resolve exception: ${exceptionIdentity(x)}`}
                    onClick={() => openResolve(x)}
                  >
                    Resolve
                  </button>
                </div>
              </div>

              {applyingId === x.id && (
                <div className="panel-pad">
                  <p className="muted">
                    This credits the lot you choose with{' '}
                    {x.fact ? formatCents(x.fact.amountCents) : 'the payment'},
                    once, and closes this exception. Later news about the same
                    payment, such as a refund, then lands on that lot.
                  </p>
                  <div className="field" style={{ marginBottom: '12px' }}>
                    <label htmlFor={`apply-lot-${x.id}`}>Apply to lot</label>
                    <select
                      id={`apply-lot-${x.id}`}
                      value={applyLotId}
                      disabled={busy}
                      onChange={(e) => setApplyLotId(e.target.value)}
                    >
                      <option value="">— choose a lot —</option>
                      {lots.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.address}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={busy}
                    aria-label={`Confirm applying payment to a lot: ${x.providerPaymentRef}`}
                    onClick={() => submitApply(x)}
                  >
                    Apply this payment
                  </button>
                </div>
              )}

              {resolvingId === x.id && (
                <div className="panel-pad">
                  <div className="field" style={{ marginBottom: '12px' }}>
                    <label htmlFor={`resolution-${x.id}`}>Resolution</label>
                    <select
                      id={`resolution-${x.id}`}
                      value={resolution}
                      disabled={busy}
                      onChange={(e) =>
                        setResolution(e.target.value as BoardPaymentResolution)
                      }
                    >
                      {BOARD_PAYMENT_RESOLUTIONS.map((r) => (
                        <option key={r} value={r}>
                          {PAYMENT_RESOLUTION_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field" style={{ marginBottom: '12px' }}>
                    <label htmlFor={`resolution-note-${x.id}`}>
                      Board-only note
                      {resolution === 'other' ? ' (required)' : ' (optional)'}
                    </label>
                    <textarea
                      id={`resolution-note-${x.id}`}
                      value={note}
                      maxLength={MAX_RESOLUTION_NOTE_LENGTH}
                      disabled={busy}
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn--small"
                    disabled={busy}
                    aria-label={`Confirm resolving exception: ${exceptionIdentity(x)}`}
                    onClick={() => submitResolve(x)}
                  >
                    Resolve this exception
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <h2 className="panel-editor__title">Payments</h2>
      <div className="field-grid" style={{ marginBottom: '16px' }}>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="payments-lot-filter">Show payments for</label>
          <select
            id="payments-lot-filter"
            value={filterLotId}
            onChange={(e) => setFilterLotId(e.target.value)}
          >
            <option value="">Every lot</option>
            {lots.map((l) => (
              <option key={l.id} value={l.id}>
                {l.address}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="payments-status-filter">Status</label>
          <select
            id="payments-status-filter"
            value={filterStatus}
            onChange={(e) =>
              setFilterStatus(e.target.value as PaymentStatus | '')
            }
          >
            <option value="">Any status</option>
            {PAYMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s === 'expired' ? 'Expired' : PAYMENT_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loadError && (
        <div className="panel-card" style={{ marginBottom: '26px' }}>
          <p className="muted" style={{ margin: 0 }}>
            The payments could not be read, so nothing is shown. This is not the
            same as there being none.
          </p>
        </div>
      )}

      <div className="panel-list">
        {loadError ? null : payments.length === 0 ? (
          <p className="muted panel-pad">No payments to show.</p>
        ) : (
          payments.map((p) => (
            <div
              key={p.id}
              className="panel-card"
              style={{ marginBottom: '14px' }}
            >
              <div className="list-row">
                <div className="admin-row-main">
                  <div className="admin-row-title">
                    {formatCents(p.amountCents)} —{' '}
                    {paymentStatusLabel(p.status, p.ledgerState)}
                    {p.openExceptions > 0
                      ? ` · ${p.openExceptions} open exception${p.openExceptions === 1 ? '' : 's'}`
                      : ''}
                  </div>
                  <div className="admin-row-sub">
                    {addressOf(p.lotId)} · started {onDay(p.createdAt)}
                    {p.origin === 'board_applied'
                      ? ' · applied by the board'
                      : ''}
                    {` · Payment Reference ${paymentReference(p.id)} · provider reference ${p.providerPaymentRef ?? 'none yet'}`}
                  </div>
                </div>
                <div className="row-actions">
                  <button
                    type="button"
                    className="row-link"
                    disabled={busy}
                    aria-expanded={detailId === p.id}
                    aria-label={`Details of payment: ${paymentIdentity(p)}`}
                    onClick={() => toggleDetail(p)}
                  >
                    Details
                  </button>
                  {p.providerPaymentRef !== null && (
                    <button
                      type="button"
                      className="row-link"
                      disabled={busy}
                      aria-label={`Re-sync payment: ${paymentIdentity(p)}`}
                      onClick={() => resync(p)}
                    >
                      Re-sync
                    </button>
                  )}
                </div>
              </div>

              {detailId === p.id && detail?.id === p.id && (
                <PaymentDetail detail={detail} />
              )}
            </div>
          ))
        )}
      </div>

      <h2 className="panel-editor__title">Export for bank reconciliation</h2>
      <p className="muted">
        Every ledger entry the payment provider wrote, with an effective day
        from the first day through the last, as a CSV file to lay beside the
        association&apos;s bank statement. Entries the board recorded by hand
        are not included. Amounts carry the ledger&apos;s sign: a payment is
        negative.
      </p>
      <div className="field-grid">
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="payments-export-from">First day</label>
          <input
            id="payments-export-from"
            type="date"
            value={exportFrom}
            onChange={(e) => setExportFrom(e.target.value)}
          />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="payments-export-to">Last day</label>
          <input
            id="payments-export-to"
            type="date"
            value={exportTo}
            onChange={(e) => setExportTo(e.target.value)}
          />
        </div>
      </div>
      <div className="btn-row" style={{ marginTop: '12px' }}>
        <button
          type="button"
          className="btn btn--small"
          disabled={busy}
          onClick={submitExport}
        >
          Export CSV
        </button>
      </div>
    </div>
  );
}

/** Hands the browser `csv` to save as `fileName`. */
function downloadCsv(csv: string, fileName: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Everything that happened to one payment, in the order it was recorded. */
function PaymentDetail({ detail }: { detail: AdminPaymentDetail }) {
  return (
    <div className="panel-pad">
      <h3 className="panel-editor__title">What the provider reported</h3>
      {detail.events.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <ol>
          {detail.events.map((e) => (
            <li key={e.id}>
              {PAYMENT_EVENT_TYPE_LABELS[e.type]} · {formatCents(e.amountCents)}
              {e.currency === 'usd'
                ? ''
                : ` ${e.currency.toUpperCase()}`} ·{' '}
              {PAYMENT_EVENT_VIA_LABELS[e.via]} ·{' '}
              {PAYMENT_EVENT_OUTCOME_LABELS[e.outcome]} · happened{' '}
              {onDay(e.occurredAt)}
            </li>
          ))}
        </ol>
      )}

      <h3 className="panel-editor__title">Ledger entries it wrote</h3>
      {detail.entries.length === 0 ? (
        <p className="muted">
          None — nothing from this payment is on the ledger.
        </p>
      ) : (
        <ul>
          {detail.entries.map((l) => (
            <li key={l.id}>
              {DUES_LEDGER_KIND_LABELS[l.kind]} · {formatCents(l.amountCents)} ·{' '}
              {l.effectiveDay} · {l.description}
            </li>
          ))}
        </ul>
      )}

      <h3 className="panel-editor__title">Exceptions</h3>
      {detail.exceptions.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <ul>
          {detail.exceptions.map((x) => (
            <li key={x.id}>
              {PAYMENT_EXCEPTION_REASON_LABELS[x.reason]} —{' '}
              {x.resolution
                ? `${PAYMENT_RESOLUTION_LABELS[x.resolution.resolution]}, by ${x.resolution.actingAccountId ?? 'the site'} on ${onDay(x.resolution.resolvedAt)}${x.resolution.note ? ` — ${x.resolution.note}` : ''}`
                : 'open'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
