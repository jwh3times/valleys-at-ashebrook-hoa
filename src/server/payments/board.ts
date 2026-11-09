import type {
  AdminOpenPaymentException,
  AdminPaymentDetail,
  AdminPaymentEntry,
  AdminPaymentEvent,
  AdminPaymentException,
  AdminPaymentSummary,
  DuesLedgerKind,
  PaymentEventOutcome,
  PaymentEventType,
  PaymentEventVia,
  PaymentExceptionReason,
  PaymentLedgerState,
  PaymentOrigin,
  PaymentResolution,
  PaymentStatus,
} from '../../lib/types';
import { UNMATCHED_SALE_SQL, applyPaymentEvent } from './apply';
import type { PaymentProvider } from './provider';

/**
 * WHAT THE BOARD READS ABOUT ONLINE PAYMENTS (ADR 0025, #545).
 *
 * The board's question is "I paid, and the ledger says I didn't", so these
 * reads put a payment beside everything that happened to it: every provider
 * fact stored for it (not only the ones that opened an exception — two equal
 * partial refunds raise one exception and two facts), the ledger entries
 * those facts wrote, and every exception with how it closed.
 *
 * Board-wide and unscoped by Lot Authority: the caller has passed
 * `requireBoard`. Nothing here writes a table itself: a re-sync records what
 * the provider reports through `applyPaymentEvent`, and the board's own
 * writes are in `apply.ts`.
 */

const SUMMARY_COLUMNS = `
  p.id, p.lot_id, p.amount_cents, p.origin, p.status, p.ledger_state,
  p.provider_payment_ref, p.created_at,
  (SELECT COUNT(*) FROM payment_exceptions x
    WHERE x.payment_id = p.id
      AND NOT EXISTS (SELECT 1 FROM payment_exception_resolutions r
                       WHERE r.exception_id = x.id)) AS open_exceptions`;

interface SummaryRow {
  id: string;
  lot_id: string;
  amount_cents: number;
  origin: PaymentOrigin;
  status: PaymentStatus;
  ledger_state: PaymentLedgerState;
  provider_payment_ref: string | null;
  created_at: number;
  open_exceptions: number;
}

const toSummary = (r: SummaryRow): AdminPaymentSummary => ({
  id: r.id,
  lotId: r.lot_id,
  amountCents: r.amount_cents,
  origin: r.origin,
  status: r.status,
  ledgerState: r.ledger_state,
  providerPaymentRef: r.provider_payment_ref,
  createdAt: new Date(r.created_at).toISOString(),
  openExceptions: r.open_exceptions,
});

/** Every payment, newest first, optionally narrowed to one Lot and one status. */
export async function listBoardPayments(
  env: Env,
  filter: { lotId?: string; status?: PaymentStatus },
): Promise<AdminPaymentSummary[]> {
  const where: string[] = [];
  const binds: string[] = [];
  if (filter.lotId !== undefined) {
    where.push('p.lot_id = ?');
    binds.push(filter.lotId);
  }
  if (filter.status !== undefined) {
    where.push('p.status = ?');
    binds.push(filter.status);
  }
  const { results } = await env.DATABASE.prepare(
    `SELECT ${SUMMARY_COLUMNS}
       FROM payments p
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY p.created_at DESC, p.id DESC`,
  )
    .bind(...binds)
    .all<SummaryRow>();
  return results.map(toSummary);
}

/**
 * Every exception with no resolution yet, oldest first: the board's queue.
 * An unmatched exception cites no payment, so it carries the fact that opened
 * it, and whether that fact is one the board can apply to a Lot.
 */
export async function listOpenPaymentExceptions(
  env: Env,
): Promise<AdminOpenPaymentException[]> {
  const { results } = await env.DATABASE.prepare(
    `SELECT x.id, x.reason, x.opened_at, x.payment_id, p.lot_id,
            COALESCE(p.provider_payment_ref, e.provider_payment_ref) AS ref,
            e.type, e.amount_cents, e.currency, e.occurred_at,
            ${UNMATCHED_SALE_SQL} AS applicable
       FROM payment_exceptions x
       LEFT JOIN payments p ON p.id = x.payment_id
       LEFT JOIN payment_events e ON e.id = x.payment_event_id
      WHERE NOT EXISTS (SELECT 1 FROM payment_exception_resolutions r
                         WHERE r.exception_id = x.id)
      ORDER BY x.opened_at, x.rowid`,
  ).all<{
    id: string;
    reason: PaymentExceptionReason;
    opened_at: number;
    payment_id: string | null;
    lot_id: string | null;
    ref: string | null;
    type: PaymentEventType | null;
    amount_cents: number | null;
    currency: string | null;
    occurred_at: number | null;
    applicable: number;
  }>();
  return results.map((r) => ({
    id: r.id,
    reason: r.reason,
    openedAt: new Date(r.opened_at).toISOString(),
    paymentId: r.payment_id,
    lotId: r.lot_id,
    providerPaymentRef: r.ref,
    fact:
      r.type === null
        ? null
        : {
            type: r.type,
            amountCents: r.amount_cents ?? 0,
            currency: r.currency ?? '',
            occurredAt: new Date(r.occurred_at ?? 0).toISOString(),
          },
    applicable: r.applicable === 1,
  }));
}

/** One payment and everything that happened to it, or `null`. */
export async function fetchBoardPaymentDetail(
  env: Env,
  paymentId: string,
): Promise<AdminPaymentDetail | null> {
  const summary = await env.DATABASE.prepare(
    `SELECT ${SUMMARY_COLUMNS} FROM payments p WHERE p.id = ?`,
  )
    .bind(paymentId)
    .first<SummaryRow>();
  if (!summary) return null;

  const [events, entries, exceptions] = await env.DATABASE.batch([
    // Insertion order, as the application path decided them.
    env.DATABASE.prepare(
      `SELECT id, provider_event_id, type, amount_cents, currency, occurred_at,
              received_at, via, outcome, ledger_entry_id
         FROM payment_events WHERE payment_id = ? ORDER BY rowid`,
    ).bind(paymentId),
    env.DATABASE.prepare(
      `SELECT id, kind, amount_cents, effective_day, description,
              reverses_entry_id
         FROM dues_ledger_entries WHERE payment_id = ?
        ORDER BY effective_day, recorded_at, rowid`,
    ).bind(paymentId),
    env.DATABASE.prepare(
      `SELECT x.id, x.reason, x.opened_at, r.resolution, r.note,
              r.acting_account_id, r.resolved_at
         FROM payment_exceptions x
         LEFT JOIN payment_exception_resolutions r ON r.exception_id = x.id
        WHERE x.payment_id = ?
        ORDER BY x.opened_at, x.rowid`,
    ).bind(paymentId),
  ]);

  return {
    ...toSummary(summary),
    events: (
      events.results as {
        id: string;
        provider_event_id: string;
        type: PaymentEventType;
        amount_cents: number;
        currency: string;
        occurred_at: number;
        received_at: number;
        via: PaymentEventVia;
        outcome: PaymentEventOutcome;
        ledger_entry_id: string | null;
      }[]
    ).map((e): AdminPaymentEvent => ({
      id: e.id,
      providerEventId: e.provider_event_id,
      type: e.type,
      amountCents: e.amount_cents,
      currency: e.currency,
      occurredAt: new Date(e.occurred_at).toISOString(),
      receivedAt: new Date(e.received_at).toISOString(),
      via: e.via,
      outcome: e.outcome,
      ledgerEntryId: e.ledger_entry_id,
    })),
    entries: (
      entries.results as {
        id: string;
        kind: DuesLedgerKind;
        amount_cents: number;
        effective_day: string;
        description: string;
        reverses_entry_id: string | null;
      }[]
    ).map((l): AdminPaymentEntry => ({
      id: l.id,
      kind: l.kind,
      amountCents: l.amount_cents,
      effectiveDay: l.effective_day,
      description: l.description,
      reversesEntryId: l.reverses_entry_id,
    })),
    exceptions: (
      exceptions.results as {
        id: string;
        reason: PaymentExceptionReason;
        opened_at: number;
        resolution: PaymentResolution | null;
        note: string | null;
        acting_account_id: string | null;
        resolved_at: number | null;
      }[]
    ).map((x): AdminPaymentException => ({
      id: x.id,
      reason: x.reason,
      openedAt: new Date(x.opened_at).toISOString(),
      resolution:
        x.resolution === null
          ? null
          : {
              resolution: x.resolution,
              note: x.note,
              actingAccountId: x.acting_account_id,
              resolvedAt: new Date(x.resolved_at ?? 0).toISOString(),
            },
    })),
  };
}

/** What re-syncing one payment came to. */
export type ResyncOutcome =
  | { kind: 'not_found' }
  /** The payment has no provider reference to ask about. */
  | { kind: 'no_reference' }
  /** It belongs to a provider other than the one configured now. */
  | { kind: 'other_provider' }
  /** The provider answered; `recorded` facts were new to the site. */
  | { kind: 'pulled'; recorded: number };

/**
 * The board re-syncs one payment from the provider on demand (ADR 0025: "the
 * reconciliation pull on demand"), so a missed webhook is closed while the
 * homeowner is still on the phone.
 *
 * Unlike the homeowner's refresh it has no rate limit and pulls a payment in
 * any status: the board asks deliberately, one payment at a time. The facts go
 * through the application path like every other pull, so a fact already
 * stored is stored once. A provider error propagates to the route.
 */
export async function resyncBoardPayment(
  env: Env,
  provider: PaymentProvider,
  paymentId: string,
  now: Date,
): Promise<ResyncOutcome> {
  const payment = await env.DATABASE.prepare(
    `SELECT provider, provider_payment_ref FROM payments WHERE id = ?`,
  )
    .bind(paymentId)
    .first<{ provider: string; provider_payment_ref: string | null }>();
  if (!payment) return { kind: 'not_found' };
  if (payment.provider !== provider.id) return { kind: 'other_provider' };
  if (payment.provider_payment_ref === null) return { kind: 'no_reference' };

  let recorded = 0;
  for (const fact of await provider.retrievePayment(
    payment.provider_payment_ref,
  )) {
    const result = await applyPaymentEvent(env, fact, now);
    if (result.kind === 'recorded') recorded += 1;
  }
  return { kind: 'pulled', recorded };
}
