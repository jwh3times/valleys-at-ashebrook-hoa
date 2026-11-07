import { env } from 'cloudflare:test';
import type {
  NormalizedPaymentEvent,
  PaymentProvider,
} from '../../src/server/payments/provider';
import type { PaymentEventType } from '../../src/lib/types';

/**
 * The fake payment provider (ADR 0025, #539).
 *
 * It lives here, under the test tree, and is injected through the registry's
 * test-only hook — never through `PAYMENTS_PROVIDER` — so no deployment can
 * select it. It emits ADR 0025's normalized events on demand, which is all the
 * application path ever sees of a provider.
 */
export const FAKE_PROVIDER_ID = 'fake';

let eventSequence = 0;

export function resetFakeEvents() {
  eventSequence = 0;
}

/** One normalized fact, as an adapter would hand it to the application path. */
export function fakeEvent(
  type: PaymentEventType,
  providerPaymentRef: string | null,
  overrides: Partial<NormalizedPaymentEvent> = {},
): NormalizedPaymentEvent {
  eventSequence += 1;
  return {
    provider: FAKE_PROVIDER_ID,
    providerEventId: `evt_${eventSequence}`,
    providerPaymentRef,
    type,
    amountCents: 45000,
    currency: 'usd',
    occurredAt: new Date('2026-11-02T15:00:00Z'),
    via: 'webhook',
    ...overrides,
  };
}

/**
 * A provider whose every method answers from what the test queued. Nothing
 * here talks to a network.
 */
export function fakeProvider(
  queued: { events?: NormalizedPaymentEvent[] } = {},
): PaymentProvider {
  return {
    id: FAKE_PROVIDER_ID,
    async createCheckout({ paymentId }) {
      return {
        providerPaymentRef: `ref_${paymentId}`,
        url: `https://checkout.invalid/${paymentId}`,
      };
    },
    async verifyAndParseWebhook() {
      return { ok: true, events: queued.events ?? [] };
    },
    async retrievePayment(ref) {
      return (queued.events ?? []).filter((e) => e.providerPaymentRef === ref);
    },
    async listEventsSince() {
      return { events: queued.events ?? [], nextCursor: null };
    },
  };
}

/**
 * One `payments` row, as a started checkout leaves it. Raw SQL so the fixture
 * states the row's shape rather than whatever the schema module defaults.
 */
export async function seedPayment(row: {
  id: string;
  lotId: string;
  amountCents?: number;
  personId?: string | null;
  ref?: string | null;
  status?: string;
  provider?: string;
}) {
  const personId = row.personId === undefined ? 'payer-1' : row.personId;
  await env.DATABASE.prepare(
    `INSERT INTO payments
       (id, lot_id, amount_cents, initiated_by_person_id, origin, provider,
        provider_payment_ref, status, ledger_state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?)`,
  )
    .bind(
      row.id,
      row.lotId,
      row.amountCents ?? 45000,
      personId,
      personId === null ? 'board_applied' : 'checkout',
      row.provider ?? FAKE_PROVIDER_ID,
      row.ref === undefined ? `ref_${row.id}` : row.ref,
      row.status ?? 'created',
      Date.parse('2026-11-01T12:00:00Z'),
      Date.parse('2026-11-01T12:00:00Z'),
    )
    .run();
}

/** Every stored fact, oldest first, as the board's payment view will list them. */
export async function storedEvents() {
  const { results } = await env.DATABASE.prepare(
    `SELECT provider_event_id, payment_id, type, outcome, ledger_entry_id, via
       FROM payment_events ORDER BY received_at, id`,
  ).all<{
    provider_event_id: string;
    payment_id: string | null;
    type: string;
    outcome: string;
    ledger_entry_id: string | null;
    via: string;
  }>();
  return results;
}

/** Open exceptions, with their reason and what they cite. */
export async function openExceptions() {
  const { results } = await env.DATABASE.prepare(
    `SELECT x.reason, x.payment_id, e.provider_event_id
       FROM payment_exceptions x
       LEFT JOIN payment_events e ON e.id = x.payment_event_id
      WHERE NOT EXISTS (SELECT 1 FROM payment_exception_resolutions r
                         WHERE r.exception_id = x.id)
      ORDER BY x.opened_at, x.id`,
  ).all<{
    reason: string;
    payment_id: string | null;
    provider_event_id: string | null;
  }>();
  return results;
}

export async function paymentRow(id: string) {
  return env.DATABASE.prepare(
    'SELECT status, ledger_state FROM payments WHERE id = ?',
  )
    .bind(id)
    .first<{ status: string; ledger_state: string }>();
}
