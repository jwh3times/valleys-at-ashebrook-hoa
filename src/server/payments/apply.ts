import { associationDateIso } from '../../lib/format';
import { MAX_ENTRY_CENTS } from '../../lib/money';
import {
  PAYMENT_EVENT_TYPES,
  PAYMENT_EVENT_VIAS,
  type PaymentEventOutcome,
  type PaymentEventType,
  type PaymentExceptionReason,
  type PaymentResolution,
  type PaymentStatus,
} from '../../lib/types';
import { LOT_RECORDS_ENABLED_SQL } from '../lot-records/gate';
import type { NormalizedPaymentEvent } from './provider';

/**
 * The application path (ADR 0025, #539, #540): the ONLY writer of the payment
 * tables and of provider-sourced Dues Ledger entries.
 *
 * Every route to a provider fact — the webhook, the homeowner's refresh, the
 * board's re-sync, the daily reconciliation job — calls this, so they all
 * converge on one entry per real-world effect.
 *
 * Idempotency is enforced twice, because it is needed twice (ADR 0025):
 *
 * 1. **Per event**, by `UNIQUE(provider, provider_event_id)`: a redelivery is
 *    stored once.
 * 2. **Per effect**, by a deterministic `operation_key` on the ledger entry —
 *    `provider:<payment id>:credit`, `…:withdraw:<reversed entry id>` and
 *    `…:reinstate:<withdrawal entry id>` — held by the ledger's
 *    `(operation_key, lot_id)` unique index: one settlement, withdrawal or
 *    reinstatement reported by a webhook AND by a pull, under two event ids,
 *    still produces one entry. A later fact whose effect already exists is
 *    stored with `outcome = 'duplicate_effect'`.
 *
 * A payment can be withdrawn and reinstated more than once, so a withdrawal
 * always concerns the payment's CURRENT credit and a reinstatement its latest
 * unanswered withdrawal. A fact that happened, by the provider's clock, before
 * the entry it would act on is a late report of an earlier cycle and changes
 * nothing.
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

/** A provider-sourced ledger entry of one payment, with when its fact occurred. */
interface ProviderEntry {
  id: string;
  kind: 'payment' | 'reversal';
  /** Signed, as the ledger stores it: a payment negative, a reversal positive. */
  amountCents: number;
  reversesEntryId: string | null;
  operationKey: string;
  /** The provider's time for the fact that produced the entry. */
  occurredAt: number;
}

/**
 * The one ledger entry a fact writes, if any. Each has its own deterministic
 * effect key, so a second report of the same effect under another event id
 * collides with the first instead of writing it twice.
 */
type Effect =
  /** The settlement: a `payment` entry at the confirmed amount. */
  | { kind: 'credit'; amountCents: number }
  /** An exact negation of the payment's current credit. */
  | { kind: 'withdraw'; reverses: ProviderEntry }
  /** A NEW `payment` entry answering a withdrawal — never an un-reversal. */
  | { kind: 'reinstate'; answers: ProviderEntry };

/** What one event does, decided before anything is written. */
interface Plan {
  outcome: PaymentEventOutcome;
  effect: Effect | null;
  exceptions: PaymentExceptionReason[];
}

/** A lost race is re-decided this many times before the error surfaces. */
const MAX_ATTEMPTS = 3;

/**
 * How a second report of an exception-raising fact is told from a new one.
 * The webhook and the reconciliation pull report one fact under two event ids,
 * and each should put ONE row in front of the board.
 *
 * - `once` — the reason, raised by one type of fact, describes something that
 *   happens to a payment (or, unmatched, to one provider reference) at most
 *   once: its single settlement, its dispute (a payment is one charge, and a
 *   charge is disputed once), or the money it moved without a payment row.
 * - `per-state` — a fact that can genuinely recur (two partial refunds) is a
 *   repeat only when it is the same fact against the same ledger: same type,
 *   same amount, and no fact for the payment has written an entry since.
 *
 * A reason with no rule here never needs one: `funds_withdrawn` opens beside a
 * reversal whose effect key already dedupes it, `possible_duplicate` beside
 * the one credit, and `stale_pending` has its own unique index.
 */
const DEDUPE: Partial<Record<PaymentExceptionReason, 'once' | 'per-state'>> = {
  amount_mismatch: 'once',
  currency_mismatch: 'once',
  unmatched_payment: 'once',
  dispute_opened: 'once',
  partial_withdrawal: 'per-state',
  withdrawal_without_credit: 'per-state',
};

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
  const shape =
    plan.effect && payment ? entryShape(plan.effect, payment.id) : null;
  const entryId = shape ? crypto.randomUUID() : null;
  const statements: D1PreparedStatement[] = [];

  if (shape && payment && entryId)
    statements.push(
      entryStatement(env, shape, {
        entryId,
        lotId: payment.lotId,
        paymentId: payment.id,
        effectiveDay: associationDateIso(event.occurredAt),
        now,
      }),
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
      ).bind(status, shape?.ledgerStateAfter ?? null, now, payment.id),
    );
  }

  for (const reason of plan.exceptions) {
    const subject = exceptionSubject(event, reason, payment);
    statements.push(
      env.DATABASE.prepare(
        `INSERT INTO payment_exceptions
           (id, payment_event_id, payment_id, reason, opened_at)
         SELECT ?7, ?8, ?1, ?2, ?9
          WHERE NOT ${alreadyOpenSql(reason).sql}`,
      ).bind(...subject, crypto.randomUUID(), eventId, now),
    );
  }

  // Reinstated funds answer the withdrawal's exception, and the system closes
  // it — the one resolution no board account makes. One the board already
  // resolved stays as the board left it.
  if (plan.effect?.kind === 'reinstate')
    statements.push(
      env.DATABASE.prepare(
        `INSERT INTO payment_exception_resolutions
           (id, exception_id, resolution, note, acting_account_id, resolved_at)
         SELECT ?, x.id, 'funds_reinstated', NULL, NULL, ?
           FROM payment_exceptions x
           JOIN payment_events e ON e.id = x.payment_event_id
          WHERE e.ledger_entry_id = ?
            AND x.reason = 'funds_withdrawn'
            AND NOT EXISTS (SELECT 1 FROM payment_exception_resolutions r
                             WHERE r.exception_id = x.id)`,
      ).bind(crypto.randomUUID(), now, plan.effect.answers.id),
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
const withdrawKey = (paymentId: string, reversedEntryId: string) =>
  `${PROVIDER_KEY_PREFIX}${paymentId}:withdraw:${reversedEntryId}`;
const reinstateKey = (paymentId: string, withdrawalEntryId: string) =>
  `${PROVIDER_KEY_PREFIX}${paymentId}:reinstate:${withdrawalEntryId}`;

/**
 * The entry an effect writes. Every one is provider-sourced, carries its
 * payment id (so the trail runs from entry to payment), names no recording
 * account, and is dated by the Association Day the provider says it happened.
 * The homeowner reads the description.
 */
function entryStatement(
  env: Env,
  shape: EntryShape,
  row: {
    entryId: string;
    lotId: string;
    paymentId: string;
    effectiveDay: string;
    now: number;
  },
): D1PreparedStatement {
  return env.DATABASE.prepare(
    `INSERT INTO dues_ledger_entries
       (id, lot_id, kind, amount_cents, effective_day, description,
        category, method, reference, source, payment_id, reverses_entry_id,
        recorded_by, recorded_at, operation_key)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, 'provider', ?, ?, NULL, ?, ?)`,
  ).bind(
    row.entryId,
    row.lotId,
    shape.kind,
    shape.amountCents,
    row.effectiveDay,
    shape.description,
    shape.method,
    row.paymentId,
    shape.reverses,
    row.now,
    shape.key,
  );
}

interface EntryShape {
  kind: 'payment' | 'reversal';
  /** Signed, as the ledger stores it. */
  amountCents: number;
  description: string;
  method: 'online' | null;
  reverses: string | null;
  key: string;
  /** The payment's `ledger_state` once the entry exists. */
  ledgerStateAfter: 'credited' | 'withdrawn';
}

/** Everything that differs between the three effects, in one place. */
function entryShape(effect: Effect, paymentId: string): EntryShape {
  switch (effect.kind) {
    case 'credit':
      return {
        kind: 'payment',
        amountCents: -effect.amountCents,
        description: 'Online payment',
        method: 'online',
        reverses: null,
        key: creditKey(paymentId),
        ledgerStateAfter: 'credited',
      };
    case 'withdraw':
      return {
        kind: 'reversal',
        amountCents: -effect.reverses.amountCents,
        description: 'Online payment withdrawn',
        method: null,
        reverses: effect.reverses.id,
        key: withdrawKey(paymentId, effect.reverses.id),
        ledgerStateAfter: 'withdrawn',
      };
    case 'reinstate':
      return {
        kind: 'payment',
        amountCents: -effect.answers.amountCents,
        description: 'Online payment reinstated',
        method: 'online',
        reverses: null,
        key: reinstateKey(paymentId, effect.answers.id),
        ledgerStateAfter: 'credited',
      };
  }
}

/**
 * The parameters `alreadyOpenSql` reads, in order: ?1 payment id, ?2 reason,
 * ?3 provider, ?4 provider reference, ?5 event type, ?6 event amount. Binding
 * the same tuple everywhere lets the preflight and the batch ask the SAME
 * question.
 */
type ExceptionSubject = readonly [
  string | null,
  PaymentExceptionReason,
  string,
  string | null,
  PaymentEventType,
  number,
];

function exceptionSubject(
  event: NormalizedPaymentEvent,
  reason: PaymentExceptionReason,
  payment: PaymentState | null,
): ExceptionSubject {
  return [
    payment?.id ?? null,
    reason,
    event.provider,
    event.providerPaymentRef,
    event.type,
    event.amountCents,
  ];
}

/**
 * Whether the board already has this question, per the reason's `DEDUPE`
 * rule, as an SQL boolean over `ExceptionSubject`'s parameters. The batch
 * carries it inside the INSERT, so it holds against a concurrent writer and
 * not just against the preflight read. Resolved exceptions count too: the fact
 * they described has not recurred.
 */
function alreadyOpenSql(reason: PaymentExceptionReason): {
  sql: string;
  /** The highest `ExceptionSubject` parameter it reads; D1 binds exactly that many. */
  arity: number;
} {
  const sql = DEDUPE_SQL[DEDUPE[reason] ?? 'never'];
  const used = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
  return { sql, arity: Math.max(0, ...used) };
}

const DEDUPE_SQL = {
  // The same reason, raised by the same type of fact, for the same payment —
  // or, unmatched, for the same provider reference.
  once: `EXISTS (
    SELECT 1 FROM payment_exceptions x
      JOIN payment_events e ON e.id = x.payment_event_id
     WHERE x.reason = ?2 AND e.type = ?5
       AND (    (?1 IS NOT NULL AND x.payment_id = ?1)
             OR (?1 IS NULL AND ?4 IS NOT NULL AND x.payment_id IS NULL
                 AND e.provider = ?3 AND e.provider_payment_ref = ?4)))`,
  // The same fact against the same ledger: no fact for the payment has written
  // an entry since. Insertion order (`rowid`, on an append-only table), not a
  // clock, so facts applied in one millisecond are still told apart.
  'per-state': `EXISTS (
    SELECT 1 FROM payment_exceptions x
      JOIN payment_events e ON e.id = x.payment_event_id
     WHERE x.reason = ?2 AND x.payment_id = ?1
       AND e.type = ?5 AND e.amount_cents = ?6
       AND NOT EXISTS (SELECT 1 FROM payment_events later
                        WHERE later.payment_id = ?1
                          AND later.ledger_entry_id IS NOT NULL
                          AND later.rowid > e.rowid))`,
  never: '(FALSE)',
} as const;

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
  effect: null,
  exceptions: [],
};

const DUPLICATE_EFFECT: Plan = {
  outcome: 'duplicate_effect',
  effect: null,
  exceptions: [],
};

/** A fact whose whole effect is putting one question in front of the board. */
const exceptionOnly = (reason: PaymentExceptionReason): Plan => ({
  outcome: 'exception',
  effect: null,
  exceptions: [reason],
});

/**
 * A fact no `payments` row claims — typically a payment taken in the
 * provider's own dashboard. It is stored with no ledger effect, since nothing
 * says which Lot it was for. Only money that moved troubles the board: the
 * board can apply it to a Lot from the exception (#545).
 */
const MOVES_MONEY: ReadonlySet<PaymentEventType> = new Set([
  'payment_succeeded',
  'funds_withdrawn',
  'funds_reinstated',
  'dispute_opened',
]);

function unmatchedPlan(event: NormalizedPaymentEvent): Plan {
  return {
    outcome: 'unmatched',
    effect: null,
    exceptions: MOVES_MONEY.has(event.type) ? ['unmatched_payment'] : [],
  };
}

async function planFor(
  env: Env,
  event: NormalizedPaymentEvent,
  payment: PaymentState,
): Promise<Plan> {
  const plan = await effectPlan(env, event, payment);
  // A fact whose whole effect is an exception the board already has is
  // another report of it, not a second problem.
  if (
    !plan.effect &&
    plan.exceptions.length > 0 &&
    (await allAlreadyOpen(env, event, payment, plan.exceptions))
  )
    return DUPLICATE_EFFECT;
  return plan;
}

async function effectPlan(
  env: Env,
  event: NormalizedPaymentEvent,
  payment: PaymentState,
): Promise<Plan> {
  switch (event.type) {
    case 'payment_succeeded':
      return settlementPlan(env, event, payment);
    case 'funds_withdrawn':
      return withdrawalPlan(event, await providerEntries(env, payment.id));
    case 'funds_reinstated':
      return reinstatementPlan(
        event,
        payment,
        await providerEntries(env, payment.id),
      );
    case 'dispute_opened':
      return exceptionOnly('dispute_opened');
    case 'payment_pending':
    case 'payment_failed':
    case 'payment_canceled':
      return NO_LEDGER_EFFECT;
  }
}

/**
 * Mismatches become exceptions, not guesses (ADR 0025). Money that actually
 * moved is recorded at the amount the provider CONFIRMS, and the board is told
 * it differed; money in another currency cannot be recorded in a USD ledger at
 * all, so it is not credited and the board decides.
 */
async function settlementPlan(
  env: Env,
  event: NormalizedPaymentEvent,
  payment: PaymentState,
): Promise<Plan> {
  const credited = await env.DATABASE.prepare(
    `SELECT 1 FROM dues_ledger_entries WHERE operation_key = ? AND lot_id = ?`,
  )
    .bind(creditKey(payment.id), payment.lotId)
    .first();
  if (credited) return DUPLICATE_EFFECT;

  const plan = settlementEffect(event, payment);
  if (
    plan.effect?.kind === 'credit' &&
    (await resemblesBoardPayment(env, payment, plan.effect.amountCents, event))
  )
    return {
      outcome: 'exception',
      effect: plan.effect,
      exceptions: [...plan.exceptions, 'possible_duplicate'],
    };
  return plan;
}

/** How far back a hand-entered payment can be the same money (#538). */
const POSSIBLE_DUPLICATE_DAYS = 14;

/**
 * Real money is never refused, and a double credit is never silently kept: a
 * provider credit that looks like a check the board already entered — same
 * Lot, same amount, within the window before it — is credited and flagged.
 * A board payment the board reversed (a bounced check) was never money, so it
 * resembles nothing.
 */
async function resemblesBoardPayment(
  env: Env,
  payment: PaymentState,
  amountCents: number,
  event: NormalizedPaymentEvent,
): Promise<boolean> {
  const day = associationDateIso(event.occurredAt);
  const match = await env.DATABASE.prepare(
    `SELECT 1 FROM dues_ledger_entries p
      WHERE p.lot_id = ?1 AND p.source = 'board' AND p.kind = 'payment'
        AND p.amount_cents = ?2
        AND p.effective_day BETWEEN date(?3, ?4) AND ?3
        AND NOT EXISTS (SELECT 1 FROM dues_ledger_entries r
                         WHERE r.reverses_entry_id = p.id)`,
  )
    .bind(payment.lotId, -amountCents, day, `-${POSSIBLE_DUPLICATE_DAYS} days`)
    .first();
  return match !== null;
}

function settlementEffect(
  event: NormalizedPaymentEvent,
  payment: PaymentState,
): Plan {
  if (event.currency !== 'usd')
    return {
      outcome: 'exception',
      effect: null,
      exceptions: ['currency_mismatch'],
    };

  // A confirmed amount of zero moved no money and cannot be a `payment`
  // entry (its sign CHECK), but it still disagrees with what was asked.
  if (event.amountCents !== payment.amountCents)
    return {
      outcome: 'exception',
      effect:
        event.amountCents > 0
          ? { kind: 'credit', amountCents: event.amountCents }
          : null,
      exceptions: ['amount_mismatch'],
    };

  return {
    outcome: 'applied',
    effect: { kind: 'credit', amountCents: event.amountCents },
    exceptions: [],
  };
}

/**
 * Every provider-sourced entry of one payment, in the order they were written
 * — by the insertion order of the facts that produced them, never by a clock,
 * since one pull applies several facts with the same receipt time — each with
 * the provider's time for the fact that produced it. Entries are never edited, so
 * this read describes the whole withdrawal history; the batch's unique keys
 * catch anything written since.
 */
async function providerEntries(
  env: Env,
  paymentId: string,
): Promise<ProviderEntry[]> {
  const { results } = await env.DATABASE.prepare(
    `SELECT l.id, l.kind, l.amount_cents, l.reverses_entry_id, l.operation_key,
            e.occurred_at
       FROM dues_ledger_entries l
       JOIN payment_events e ON e.ledger_entry_id = l.id
      WHERE l.payment_id = ? AND l.source = 'provider'
      ORDER BY e.rowid`,
  )
    .bind(paymentId)
    .all<{
      id: string;
      kind: 'payment' | 'reversal';
      amount_cents: number;
      reverses_entry_id: string | null;
      operation_key: string;
      occurred_at: number;
    }>();
  return results.map((r) => ({
    id: r.id,
    kind: r.kind,
    amountCents: r.amount_cents,
    reversesEntryId: r.reverses_entry_id,
    operationKey: r.operation_key,
    occurredAt: r.occurred_at,
  }));
}

/** The credit money could still leave from: a payment entry nothing reversed. */
function currentCredit(
  entries: readonly ProviderEntry[],
): ProviderEntry | null {
  const reversed = new Set(entries.map((e) => e.reversesEntryId));
  return (
    entries.findLast((e) => e.kind === 'payment' && !reversed.has(e.id)) ?? null
  );
}

/**
 * Money leaving after it was credited (a returned ACH debit, a refund, a lost
 * dispute) reverses the payment's CURRENT credit — the settlement, or the
 * reinstatement of an earlier withdrawal — and the board is told.
 */
function withdrawalPlan(
  event: NormalizedPaymentEvent,
  entries: readonly ProviderEntry[],
): Plan {
  const credit = currentCredit(entries);
  if (!credit)
    // Already withdrawn: this is another report of that withdrawal. Never
    // credited at all: money left that the ledger never held.
    return entries.some((e) => e.kind === 'reversal')
      ? DUPLICATE_EFFECT
      : exceptionOnly('withdrawal_without_credit');

  // A withdrawal that happened before the current credit existed cannot have
  // taken it: it is a late report, under a new id, of an earlier cycle's.
  if (
    event.occurredAt.getTime() < credit.occurredAt &&
    entries.some((e) => e.kind === 'reversal')
  )
    return DUPLICATE_EFFECT;

  // A reversal is an exact negation, so less than the credit cannot be one;
  // the board records the matching adjustment. More than the credit still
  // takes the whole credit away — what left beyond it was never on the
  // ledger — and the board sees the fact's amount on the payment.
  if (event.amountCents < -credit.amountCents)
    return exceptionOnly('partial_withdrawal');
  return {
    outcome: 'exception',
    effect: { kind: 'withdraw', reverses: credit },
    exceptions: ['funds_withdrawn'],
  };
}

/**
 * Money that comes back (a dispute won, a refund that failed) answers the
 * payment's latest withdrawal with a NEW `payment` entry, so the return and the
 * reinstatement both stay on the ledger.
 */
function reinstatementPlan(
  event: NormalizedPaymentEvent,
  payment: PaymentState,
  entries: readonly ProviderEntry[],
): Plan {
  const keys = new Set(entries.map((e) => e.operationKey));
  const unanswered = entries.findLast(
    (e) => e.kind === 'reversal' && !keys.has(reinstateKey(payment.id, e.id)),
  );
  const reinstated = entries.some(
    (e) => e.kind === 'payment' && e.operationKey !== creditKey(payment.id),
  );
  // Every withdrawal is answered: another report of a reinstatement, or money
  // returning that never left the ledger (a failed partial refund, whose own
  // exception stays open for the board).
  if (!unanswered) return reinstated ? DUPLICATE_EFFECT : NO_LEDGER_EFFECT;
  // A reinstatement from before this withdrawal answered an earlier one.
  if (event.occurredAt.getTime() < unanswered.occurredAt && reinstated)
    return DUPLICATE_EFFECT;
  // Money comes back as it left, or the board decides: a different amount
  // writes nothing, and the board is told beside the withdrawal's own
  // exception (which it may already have resolved).
  if (event.amountCents !== unanswered.amountCents)
    return exceptionOnly('amount_mismatch');
  return {
    outcome: 'applied',
    effect: { kind: 'reinstate', answers: unanswered },
    exceptions: [],
  };
}

async function allAlreadyOpen(
  env: Env,
  event: NormalizedPaymentEvent,
  payment: PaymentState,
  reasons: readonly PaymentExceptionReason[],
): Promise<boolean> {
  for (const reason of reasons) {
    const { sql, arity } = alreadyOpenSql(reason);
    const open = await env.DATABASE.prepare(`SELECT ${sql} AS open`)
      .bind(...exceptionSubject(event, reason, payment).slice(0, arity))
      .first<{ open: number }>();
    if (!open?.open) return false;
  }
  return true;
}

/**
 * Bank debits settle within days (ACH, up to four business days), so one
 * still pending this long after it started is a question for the board.
 */
const STALE_PENDING_MS = 10 * 24 * 60 * 60 * 1000;

/**
 * Opens `stale_pending` for every payment still `pending` ten days after it
 * started, and returns the ids it opened for (#543). The daily job calls it
 * after its pulls, so a payment the same run settled is not flagged.
 *
 * Once per payment, ever: an exception the board resolved is not reopened,
 * since nothing new has happened. The guard is inside each INSERT, beside
 * `payment_exceptions_stale_pending_unq`, so a concurrent run cannot open a
 * second, and neither can a payment that settled after the read.
 */
export async function openStalePendingExceptions(
  env: Env,
  now: Date,
): Promise<string[]> {
  const nowMs = now.getTime();
  const startedBefore = nowMs - STALE_PENDING_MS;
  const { results } = await env.DATABASE.prepare(
    `SELECT id FROM payments
      WHERE status = 'pending' AND created_at <= ?1
        AND NOT EXISTS (SELECT 1 FROM payment_exceptions x
                         WHERE x.payment_id = payments.id
                           AND x.reason = 'stale_pending')
      ORDER BY created_at, id`,
  )
    .bind(startedBefore)
    .all<{ id: string }>();
  if (results.length === 0) return [];

  const landed = await env.DATABASE.batch(
    results.map(({ id }) =>
      env.DATABASE.prepare(
        `INSERT INTO payment_exceptions
           (id, payment_event_id, payment_id, reason, opened_at)
         SELECT ?1, NULL, p.id, 'stale_pending', ?2
           FROM payments p
          WHERE p.id = ?3 AND p.status = 'pending' AND p.created_at <= ?4
            AND NOT EXISTS (SELECT 1 FROM payment_exceptions x
                             WHERE x.payment_id = p.id
                               AND x.reason = 'stale_pending')`,
      ).bind(crypto.randomUUID(), nowMs, id, startedBefore),
    ),
  );
  return results
    .filter((_, i) => (landed[i]?.meta.changes ?? 0) > 0)
    .map(({ id }) => id);
}

/**
 * Claims the right to ask the provider about one payment now (#544), and
 * answers whether this caller won it.
 *
 * A pull that finds nothing new writes nothing, so `updated_at` alone would
 * never hold a rate limit. This stamps it, in one guarded UPDATE, only when the
 * payment was last touched — by a fact or by an earlier claim — at least
 * `everyMs` ago, so two requests racing for the same payment ask the provider
 * once. It also refuses a payment of another provider, or one with no
 * reference to ask about. It changes no status: only facts do that.
 *
 * Unlike the site's other mutations it re-checks neither Lot Authority nor the
 * flags: the caller has scoped the payment a moment before, and losing that
 * race costs one provider pull whose facts are recorded whoever asked, since
 * ingestion never reads a flag. The stamp grants nothing and shows nothing.
 */
export async function claimPaymentPull(
  env: Env,
  paymentId: string,
  provider: string,
  now: Date,
  everyMs: number,
): Promise<boolean> {
  const nowMs = now.getTime();
  const result = await env.DATABASE.prepare(
    `UPDATE payments SET updated_at = ?1
      WHERE id = ?2 AND provider = ?3 AND provider_payment_ref IS NOT NULL
        AND updated_at <= ?4`,
  )
    .bind(nowMs, paymentId, provider, nowMs - everyMs)
    .run();
  return result.meta.changes === 1;
}

/**
 * Whether exception `x`, joined to its fact `e`, can be applied to a Lot: an
 * unmatched sale that settled in US dollars and names a provider reference,
 * so the payment it creates can be matched by every later fact (#545). The
 * board's queue reads it, and the apply INSERT asks it again.
 */
export const UNMATCHED_SALE_SQL = `(x.reason = 'unmatched_payment'
   AND x.payment_id IS NULL
   AND e.type = 'payment_succeeded'
   AND e.currency = 'usd'
   AND e.amount_cents > 0
   AND e.provider_payment_ref IS NOT NULL)`;

/** What resolving one exception came to (#545). */
export type ResolveOutcome =
  /** The resolution row was written now. */
  | 'resolved'
  /** This same submission was already recorded; nothing was written twice. */
  | 'retried'
  /** Someone else resolved it first. */
  | 'already_resolved'
  | 'not_found'
  /** The operation key already names a resolution of a different exception. */
  | 'key_reused';

/**
 * Closes one exception with an appended resolution row (ADR 0025): the opening
 * row is never edited, and an exception resolves once, by
 * `payment_exception_resolutions_exception_unq`.
 *
 * The board's operation key is the new row's id, so a retry of the same
 * submission is told apart from a second board member getting there first —
 * both write nothing, but only one of them was already this caller's doing.
 */
export async function resolvePaymentException(
  env: Env,
  input: {
    /** The operation key minted when the form opened. */
    resolutionId: string;
    exceptionId: string;
    resolution: Exclude<PaymentResolution, 'funds_reinstated'>;
    note: string | null;
    accountId: string;
  },
  now: Date,
): Promise<ResolveOutcome> {
  try {
    const result = await env.DATABASE.prepare(
      `INSERT INTO payment_exception_resolutions
         (id, exception_id, resolution, note, acting_account_id, resolved_at)
       SELECT ?1, x.id, ?3, ?4, ?5, ?6
         FROM payment_exceptions x
        WHERE x.id = ?2
          AND NOT EXISTS (SELECT 1 FROM payment_exception_resolutions r
                           WHERE r.exception_id = x.id)`,
    )
      .bind(
        input.resolutionId,
        input.exceptionId,
        input.resolution,
        input.note,
        input.accountId,
        now.getTime(),
      )
      .run();
    if (result.meta.changes === 1) return 'resolved';
  } catch (error) {
    // The key already used (primary key), or a concurrent resolution (the
    // per-exception index): either way, the reads below say which.
    if (!String(error).includes('UNIQUE')) throw error;
  }
  return whyNotResolved(env, input);
}

async function whyNotResolved(
  env: Env,
  input: { resolutionId: string; exceptionId: string },
): Promise<Exclude<ResolveOutcome, 'resolved'>> {
  const byKey = await env.DATABASE.prepare(
    `SELECT exception_id FROM payment_exception_resolutions WHERE id = ?`,
  )
    .bind(input.resolutionId)
    .first<{ exception_id: string }>();
  if (byKey)
    return byKey.exception_id === input.exceptionId ? 'retried' : 'key_reused';
  const exists = await env.DATABASE.prepare(
    `SELECT 1 FROM payment_exceptions WHERE id = ?`,
  )
    .bind(input.exceptionId)
    .first();
  return exists ? 'already_resolved' : 'not_found';
}

/** What applying an unmatched payment to a Lot came to (#545). */
export type ApplyUnmatchedOutcome =
  | { kind: 'applied'; paymentId: string }
  | { kind: Exclude<ResolveOutcome, 'resolved'> }
  /** Not a settled USD sale with a reference, so there is nothing to credit. */
  | { kind: 'not_applicable' }
  /** The Lot does not exist, or Lot Records is switched off. */
  | { kind: 'lot_unavailable' }
  /** The provider's reference already belongs to another payment. */
  | { kind: 'reference_taken' };

type NotApplied = Exclude<ApplyUnmatchedOutcome, { kind: 'applied' }>;

/**
 * Applies a payment taken outside the site — a Payment Link sale, say — to a
 * Lot, exactly once (ADR 0025, #545).
 *
 * 1. A `board_applied` payment is written for the Lot, carrying the sale's
 *    provider reference, so every later fact about that sale (a refund, a
 *    dispute) matches it. Its id is the board's operation key. The INSERT
 *    re-checks the Lot Records flags, the Lot, and that the exception is still
 *    open and still a settled USD sale.
 * 2. The stored fact is replayed through `applyPaymentEvent` as a `board`
 *    fact, under a stable id derived from the original, so it credits the Lot
 *    once under the new payment's credit key, with the same checks as any
 *    settlement (a look-alike check still opens `possible_duplicate`).
 * 3. The exception is resolved `applied_to_lot`, naming the acting account.
 *
 * These are three writes, not one batch, because step 2 is the application
 * path's own batch. Each is idempotent, and an apply interrupted after step 1
 * is finished by trying again: the reference then already belongs to a
 * `board_applied` payment on the same Lot, which is taken as this apply's own.
 * Applying a completed one again writes nothing, since its exception is
 * resolved and the reference taken.
 */
export async function applyUnmatchedPayment(
  env: Env,
  input: {
    /** The operation key minted when the form opened. */
    key: string;
    exceptionId: string;
    lotId: string;
    accountId: string;
  },
  now: Date,
): Promise<ApplyUnmatchedOutcome> {
  const source = await env.DATABASE.prepare(
    `SELECT e.id, e.provider, e.provider_payment_ref, e.amount_cents,
            e.currency, e.occurred_at, ${UNMATCHED_SALE_SQL} AS applicable,
            (SELECT r.id FROM payment_exception_resolutions r
              WHERE r.exception_id = x.id) AS resolution_id
       FROM payment_exceptions x
       LEFT JOIN payment_events e ON e.id = x.payment_event_id
      WHERE x.id = ?`,
  )
    .bind(input.exceptionId)
    .first<{
      id: string | null;
      provider: string | null;
      provider_payment_ref: string | null;
      amount_cents: number | null;
      currency: string | null;
      occurred_at: number | null;
      applicable: number | null;
      resolution_id: string | null;
    }>();
  if (!source) return { kind: 'not_found' };
  if (source.resolution_id !== null)
    return { kind: closedBy(source.resolution_id, input.key) };
  if (
    source.applicable !== 1 ||
    source.id === null ||
    source.provider === null ||
    source.amount_cents === null ||
    source.currency === null ||
    source.occurred_at === null
  )
    return { kind: 'not_applicable' };

  const paymentId = await createBoardAppliedPayment(env, input, now);
  if (typeof paymentId !== 'string') return paymentId;

  await applyPaymentEvent(
    env,
    {
      provider: source.provider,
      // Stable, so an interrupted apply tried again stores the replay once.
      providerEventId: `board:${source.id}`,
      providerPaymentRef: source.provider_payment_ref,
      type: 'payment_succeeded',
      amountCents: source.amount_cents,
      currency: source.currency,
      occurredAt: new Date(source.occurred_at),
      via: 'board',
    },
    now,
  );

  // The Lot is credited now, so the answer is "applied" whatever this step
  // finds: a board member who resolved the exception by hand in the moment
  // between leaves their resolution standing, and an exception left open (a
  // reused key) is closed by applying it again, which resumes this apply.
  await resolvePaymentException(
    env,
    {
      resolutionId: input.key,
      exceptionId: input.exceptionId,
      resolution: 'applied_to_lot',
      note: null,
      accountId: input.accountId,
    },
    now,
  );
  return { kind: 'applied', paymentId };
}

/**
 * An exception already resolved: by this same submission (its key is the
 * resolution's id), or by someone else.
 */
const closedBy = (resolutionId: string, key: string) =>
  resolutionId === key ? ('retried' as const) : ('already_resolved' as const);

/**
 * Step 1 of `applyUnmatchedPayment`: the `board_applied` payment's id, or why
 * there is none.
 */
async function createBoardAppliedPayment(
  env: Env,
  input: { key: string; exceptionId: string; lotId: string },
  now: Date,
): Promise<string | NotApplied> {
  const nowMs = now.getTime();
  try {
    const result = await env.DATABASE.prepare(
      `INSERT INTO payments
         (id, lot_id, amount_cents, initiated_by_person_id, origin, provider,
          provider_payment_ref, status, ledger_state, created_at, updated_at)
       SELECT ?1, lots.id, e.amount_cents, NULL, 'board_applied', e.provider,
              e.provider_payment_ref, 'created', 'none', ?4, ?4
         FROM payment_exceptions x
         JOIN payment_events e ON e.id = x.payment_event_id
         JOIN lots ON lots.id = ?3
        WHERE x.id = ?2
          AND ${UNMATCHED_SALE_SQL}
          AND NOT EXISTS (SELECT 1 FROM payment_exception_resolutions r
                           WHERE r.exception_id = x.id)
          AND ${LOT_RECORDS_ENABLED_SQL}`,
    )
      .bind(input.key, input.exceptionId, input.lotId, nowMs)
      .run();
    if (result.meta.changes === 1) return input.key;
  } catch (error) {
    if (!String(error).includes('UNIQUE')) throw error;
    return interruptedApply(env, input);
  }
  // Nothing written: the exception was resolved in the meantime, or the Lot
  // or the flags were not there.
  const resolution = await env.DATABASE.prepare(
    `SELECT id FROM payment_exception_resolutions WHERE exception_id = ?`,
  )
    .bind(input.exceptionId)
    .first<{ id: string }>();
  if (resolution) return { kind: closedBy(resolution.id, input.key) };
  return { kind: 'lot_unavailable' };
}

/**
 * The INSERT hit a unique key: the sale's reference already belongs to a
 * payment, or the operation key is already some payment's id. A
 * `board_applied` payment for this reference on the same Lot is an earlier
 * apply that stopped before it finished, so it is carried on.
 */
async function interruptedApply(
  env: Env,
  input: { key: string; exceptionId: string; lotId: string },
): Promise<string | NotApplied> {
  const holder = await env.DATABASE.prepare(
    `SELECT p.id, p.lot_id, p.origin
       FROM payment_exceptions x
       JOIN payment_events e ON e.id = x.payment_event_id
       JOIN payments p ON p.provider = e.provider
                      AND p.provider_payment_ref = e.provider_payment_ref
      WHERE x.id = ?`,
  )
    .bind(input.exceptionId)
    .first<{ id: string; lot_id: string; origin: string }>();
  if (!holder) return { kind: 'key_reused' };
  if (holder.origin === 'board_applied' && holder.lot_id === input.lotId)
    return holder.id;
  return { kind: 'reference_taken' };
}
