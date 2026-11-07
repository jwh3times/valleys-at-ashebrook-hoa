import { associationDateIso } from '../../lib/format';
import { MAX_ENTRY_CENTS } from '../../lib/money';
import {
  PAYMENT_EVENT_TYPES,
  PAYMENT_EVENT_VIAS,
  type PaymentEventOutcome,
  type PaymentEventType,
  type PaymentExceptionReason,
  type PaymentStatus,
} from '../../lib/types';
import type { NormalizedPaymentEvent } from './provider';

/**
 * The application path (ADR 0025, #539): the ONLY writer of the payment tables
 * and of provider-sourced Dues Ledger entries.
 *
 * Every route to a provider fact — the webhook, the homeowner's refresh, the
 * board's re-sync, the daily reconciliation job — calls this, so they all
 * converge on one entry per real-world effect.
 *
 * Idempotency is enforced twice, because it is needed twice (ADR 0025):
 *
 * 1. **Per event**, by `UNIQUE(provider, provider_event_id)`: a redelivery is
 *    stored once.
 * 2. **Per effect**, by a deterministic `operation_key` on the ledger entry
 *    (`provider:<payment id>:credit`), held by the ledger's `(operation_key,
 *    lot_id)` unique index: one settlement reported by a webhook AND by a pull,
 *    under two event ids, still produces one entry. A later fact whose effect
 *    already exists is stored with `outcome = 'duplicate_effect'`.
 *
 * The decision is made from a read of the current state, and then written as
 * ONE D1 batch — the event, the projection, at most one entry and any
 * exception land together or not at all. The read is a preflight and grants
 * nothing: a concurrent writer that got there first makes the batch fail on
 * one of the unique keys above, and the whole decision is taken again from a
 * fresh read.
 */

export type ApplyResult =
  /** This exact provider event was already stored; nothing was written. */
  | { kind: 'duplicate_event' }
  | {
      kind: 'recorded';
      outcome: PaymentEventOutcome;
      ledgerEntryId: string | null;
    };

interface PaymentState {
  id: string;
  lotId: string;
  amountCents: number;
}

/** What one event does, decided before anything is written. */
interface Plan {
  outcome: PaymentEventOutcome;
  credit: { amountCents: number } | null;
  exceptions: PaymentExceptionReason[];
}

/** A lost race is re-decided this many times before the error surfaces. */
const MAX_ATTEMPTS = 3;

/**
 * The event types this path decides today. Withdrawals, reinstatements and
 * disputes arrive with #540; until then such a fact is refused rather than
 * stored with no effect, because once stored under its event id a redelivery
 * after #540 ships would be a `duplicate_event`, and the fact would be lost.
 * A refused fact is redelivered by the provider and recovered by the daily
 * reconciliation pull.
 */
const HANDLED_TYPES: ReadonlySet<PaymentEventType> = new Set([
  'payment_pending',
  'payment_succeeded',
  'payment_failed',
  'payment_canceled',
]);

/**
 * The exception reasons a payment can raise at most once: each describes the
 * single settlement of one payment (or, unmatched, of one provider reference),
 * so a webhook and a reconciliation pull reporting it under two event ids put
 * ONE row in front of the board. A reason that can recur on one payment (a
 * second withdrawal cycle, #540) must not be listed here.
 */
const ONCE_PER_PAYMENT: ReadonlySet<PaymentExceptionReason> = new Set([
  'amount_mismatch',
  'currency_mismatch',
  'unmatched_payment',
]);

/**
 * A normalized event that no adapter should have produced. Nothing is stored:
 * a fact with an impossible amount cannot be recorded faithfully, and storing
 * it under its event id would make a corrected redelivery look like a
 * duplicate.
 */
export class InvalidPaymentEvent extends Error {
  constructor(problem: string) {
    super(`Invalid payment event: ${problem}`);
    this.name = 'InvalidPaymentEvent';
  }
}

/**
 * A well-formed event of a type this path does not decide yet (see
 * `HANDLED_TYPES`). Nothing is stored, so the fact can be applied once it is.
 */
export class UnhandledPaymentEvent extends Error {
  constructor(type: PaymentEventType) {
    super(`Payment event type not handled yet: ${type}`);
    this.name = 'UnhandledPaymentEvent';
  }
}

/**
 * Integer cents, never negative, and within the ledger's own cap — the same
 * bound the board's entry form and route enforce, so no source can write a
 * figure the board could not have typed. `Number.isSafeInteger` rather than
 * `isInteger`, since `1e21` is an integer to JavaScript and a REAL to SQLite.
 */
function validate(event: NormalizedPaymentEvent): void {
  if (!event.provider.trim()) throw new InvalidPaymentEvent('blank provider');
  if (!event.providerEventId.trim())
    throw new InvalidPaymentEvent('blank event id');
  // An adapter's own mapping can drift from the vocabulary; refusing here
  // names the problem instead of surfacing a CHECK failure from the batch.
  if (!PAYMENT_EVENT_TYPES.includes(event.type))
    throw new InvalidPaymentEvent('unknown event type');
  if (!PAYMENT_EVENT_VIAS.includes(event.via))
    throw new InvalidPaymentEvent('unknown arrival path');
  if (
    !Number.isSafeInteger(event.amountCents) ||
    event.amountCents < 0 ||
    event.amountCents > MAX_ENTRY_CENTS
  )
    throw new InvalidPaymentEvent('amount is not whole cents within range');
  if (!/^[a-z]{3}$/.test(event.currency.toLowerCase()))
    throw new InvalidPaymentEvent('currency is not a three-letter code');
  if (Number.isNaN(event.occurredAt.getTime()))
    throw new InvalidPaymentEvent('invalid occurrence time');
}

export async function applyPaymentEvent(
  env: Env,
  event: NormalizedPaymentEvent,
  receivedAt: Date = new Date(),
): Promise<ApplyResult> {
  validate(event);
  if (!HANDLED_TYPES.has(event.type))
    throw new UnhandledPaymentEvent(event.type);
  const fact: NormalizedPaymentEvent = {
    ...event,
    // A blank reference names nothing: the fact is recorded as carrying none,
    // so it can never match a payment (whose ref is never blank either).
    providerPaymentRef: event.providerPaymentRef?.trim()
      ? event.providerPaymentRef
      : null,
    currency: event.currency.toLowerCase(),
  };
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await applyOnce(env, fact, receivedAt);
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !String(error).includes('UNIQUE'))
        throw error;
    }
  }
}

async function applyOnce(
  env: Env,
  event: NormalizedPaymentEvent,
  receivedAt: Date,
): Promise<ApplyResult> {
  const seen = await env.DATABASE.prepare(
    `SELECT 1 FROM payment_events WHERE provider = ? AND provider_event_id = ?`,
  )
    .bind(event.provider, event.providerEventId)
    .first();
  if (seen) return { kind: 'duplicate_event' };

  const payment = await findPayment(env, event);
  const plan = payment
    ? await planFor(env, event, payment)
    : unmatchedPlan(event);

  const now = receivedAt.getTime();
  const eventId = crypto.randomUUID();
  const entryId = plan.credit ? crypto.randomUUID() : null;
  const statements: D1PreparedStatement[] = [];

  if (plan.credit && payment && entryId)
    statements.push(
      env.DATABASE.prepare(
        `INSERT INTO dues_ledger_entries
           (id, lot_id, kind, amount_cents, effective_day, description,
            category, method, reference, source, payment_id, reverses_entry_id,
            recorded_by, recorded_at, operation_key)
         VALUES (?, ?, 'payment', ?, ?, 'Online payment', NULL, 'online',
                 NULL, 'provider', ?, NULL, NULL, ?, ?)`,
      ).bind(
        entryId,
        payment.lotId,
        -plan.credit.amountCents,
        associationDateIso(event.occurredAt),
        payment.id,
        now,
        creditKey(payment.id),
      ),
    );

  statements.push(
    env.DATABASE.prepare(
      `INSERT INTO payment_events
         (id, provider, provider_event_id, payment_id, provider_payment_ref,
          type, amount_cents, currency, occurred_at, received_at, via, outcome,
          ledger_entry_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      eventId,
      event.provider,
      event.providerEventId,
      payment?.id ?? null,
      event.providerPaymentRef,
      event.type,
      event.amountCents,
      event.currency,
      event.occurredAt.getTime(),
      now,
      event.via,
      plan.outcome,
      entryId,
    ),
  );

  if (payment) {
    const status = STATUS_FOR[event.type] ?? null;
    statements.push(
      env.DATABASE.prepare(
        `UPDATE payments
            SET status = CASE WHEN ?1 IS NOT NULL
                               AND ${statusRank('?1')} > ${statusRank('status')}
                              THEN ?1 ELSE status END,
                ledger_state = COALESCE(?2, ledger_state),
                updated_at = ?3
          WHERE id = ?4`,
      ).bind(status, plan.credit ? 'credited' : null, now, payment.id),
    );
  }

  for (const reason of plan.exceptions)
    statements.push(
      ONCE_PER_PAYMENT.has(reason)
        ? openOnce(env, {
            eventId,
            reason,
            paymentId: payment?.id ?? null,
            provider: event.provider,
            ref: event.providerPaymentRef,
            now,
          })
        : env.DATABASE.prepare(
            `INSERT INTO payment_exceptions
               (id, payment_event_id, payment_id, reason, opened_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).bind(
            crypto.randomUUID(),
            eventId,
            payment?.id ?? null,
            reason,
            now,
          ),
    );

  await env.DATABASE.batch(statements);
  return { kind: 'recorded', outcome: plan.outcome, ledgerEntryId: entryId };
}

/**
 * Every effect key this path writes starts with this; the board's ledger route
 * refuses it, so no board entry can stand in for a provider credit.
 */
export const PROVIDER_KEY_PREFIX = 'provider:';

const creditKey = (paymentId: string) =>
  `${PROVIDER_KEY_PREFIX}${paymentId}:credit`;

/**
 * Opens a once-per-payment exception unless one of that reason already exists
 * for the same subject: the payment, or — unmatched — the same provider
 * reference. The check is in the INSERT itself, so it holds inside the batch
 * against a concurrent writer, not just against the preflight read. Resolved
 * exceptions count too: the settlement they described has not recurred.
 */
function openOnce(
  env: Env,
  x: {
    eventId: string;
    reason: PaymentExceptionReason;
    paymentId: string | null;
    provider: string;
    ref: string | null;
    now: number;
  },
): D1PreparedStatement {
  return env.DATABASE.prepare(
    `INSERT INTO payment_exceptions
       (id, payment_event_id, payment_id, reason, opened_at)
     SELECT ?1, ?2, ?3, ?4, ?5
      WHERE NOT EXISTS (
        SELECT 1 FROM payment_exceptions x
          LEFT JOIN payment_events e ON e.id = x.payment_event_id
         WHERE x.reason = ?4
           AND (    (?3 IS NOT NULL AND x.payment_id = ?3)
                 OR (?3 IS NULL AND ?7 IS NOT NULL AND x.payment_id IS NULL
                     AND e.provider = ?6 AND e.provider_payment_ref = ?7)))`,
  ).bind(
    crypto.randomUUID(),
    x.eventId,
    x.paymentId,
    x.reason,
    x.now,
    x.provider,
    x.ref,
  );
}

/**
 * The `payments.status` each event type moves toward. The withdrawal and
 * dispute types move money or open exceptions but say nothing new about
 * whether the payment itself went through, so they leave the status alone.
 */
const STATUS_FOR: Partial<Record<PaymentEventType, PaymentStatus>> = {
  payment_pending: 'pending',
  payment_succeeded: 'succeeded',
  payment_failed: 'failed',
  payment_canceled: 'canceled',
};

/**
 * The precedence ADR 0025's order tolerance needs, as SQL so the write itself
 * enforces it rather than the read that preceded it: a status only ever moves
 * up. A terminal state is never overwritten by an earlier-stage event, so a
 * `payment_pending` arriving after the payment settled changes nothing.
 *
 * `succeeded` ranks above the other terminal states because it is the one
 * that says money moved: a provider that reported a failure and then confirmed
 * the funds has credited the Lot, and the status must agree with the ledger.
 */
function statusRank(expression: string): string {
  return `(CASE ${expression}
             WHEN 'created' THEN 0
             WHEN 'pending' THEN 1
             WHEN 'failed' THEN 2
             WHEN 'canceled' THEN 2
             WHEN 'expired' THEN 2
             WHEN 'succeeded' THEN 3
           END)`;
}

async function findPayment(
  env: Env,
  event: NormalizedPaymentEvent,
): Promise<PaymentState | null> {
  if (event.providerPaymentRef === null) return null;
  const row = await env.DATABASE.prepare(
    `SELECT id, lot_id, amount_cents FROM payments
      WHERE provider = ? AND provider_payment_ref = ?`,
  )
    .bind(event.provider, event.providerPaymentRef)
    .first<{ id: string; lot_id: string; amount_cents: number }>();
  return row
    ? { id: row.id, lotId: row.lot_id, amountCents: row.amount_cents }
    : null;
}

/** A fact that moves the status, if anything, and never the ledger. */
const NO_LEDGER_EFFECT: Plan = {
  outcome: 'applied',
  credit: null,
  exceptions: [],
};

const DUPLICATE_EFFECT: Plan = {
  outcome: 'duplicate_effect',
  credit: null,
  exceptions: [],
};

/**
 * A fact no `payments` row claims — typically a payment taken in the
 * provider's own dashboard. It is stored with no ledger effect, since nothing
 * says which Lot it was for. Only money that moved troubles the board: the
 * board can apply it to a Lot from the exception (#545).
 */
function unmatchedPlan(event: NormalizedPaymentEvent): Plan {
  return {
    outcome: 'unmatched',
    credit: null,
    exceptions: event.type === 'payment_succeeded' ? ['unmatched_payment'] : [],
  };
}

/**
 * Mismatches become exceptions, not guesses (ADR 0025). Money that actually
 * moved is recorded at the amount the provider CONFIRMS, and the board is told
 * it differed; money in another currency cannot be recorded in a USD ledger at
 * all, so it is not credited and the board decides.
 */
async function planFor(
  env: Env,
  event: NormalizedPaymentEvent,
  payment: PaymentState,
): Promise<Plan> {
  if (event.type !== 'payment_succeeded') return NO_LEDGER_EFFECT;

  const credited = await env.DATABASE.prepare(
    `SELECT 1 FROM dues_ledger_entries WHERE operation_key = ? AND lot_id = ?`,
  )
    .bind(creditKey(payment.id), payment.lotId)
    .first();
  if (credited) return DUPLICATE_EFFECT;

  const plan = settlementPlan(event, payment);
  // A mismatch that credited nothing has the exception as its whole effect;
  // a second report of it is a duplicate, not a second problem.
  if (
    !plan.credit &&
    plan.exceptions.length > 0 &&
    (await alreadyRaised(env, payment.id, plan.exceptions))
  )
    return DUPLICATE_EFFECT;
  return plan;
}

function settlementPlan(
  event: NormalizedPaymentEvent,
  payment: PaymentState,
): Plan {
  if (event.currency !== 'usd')
    return {
      outcome: 'exception',
      credit: null,
      exceptions: ['currency_mismatch'],
    };

  // A confirmed amount of zero moved no money and cannot be a `payment`
  // entry (its sign CHECK), but it still disagrees with what was asked.
  if (event.amountCents !== payment.amountCents)
    return {
      outcome: 'exception',
      credit: event.amountCents > 0 ? { amountCents: event.amountCents } : null,
      exceptions: ['amount_mismatch'],
    };

  return {
    outcome: 'applied',
    credit: { amountCents: event.amountCents },
    exceptions: [],
  };
}

async function alreadyRaised(
  env: Env,
  paymentId: string,
  reasons: readonly PaymentExceptionReason[],
): Promise<boolean> {
  const { results } = await env.DATABASE.prepare(
    `SELECT DISTINCT reason FROM payment_exceptions WHERE payment_id = ?`,
  )
    .bind(paymentId)
    .all<{ reason: PaymentExceptionReason }>();
  const raised = new Set(results.map((r) => r.reason));
  return reasons.every((reason) => raised.has(reason));
}
