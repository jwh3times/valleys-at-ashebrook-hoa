import type { PaymentEventType, PaymentEventVia } from '../../../lib/types';
import type {
  AdapterSecrets,
  NormalizedPaymentEvent,
  PaymentProvider,
  WebhookParse,
} from '../provider';

/**
 * The Stripe adapter (ADR 0025, #538): plain `fetch` and WebCrypto, no SDK and
 * no dependency.
 *
 * `verifyAndParseWebhook` verifies the delivery's signature over the raw body
 * BEFORE parsing a byte of it, then normalizes the event into ADR 0025's
 * vocabulary. Nothing Stripe-shaped leaves this file.
 *
 * `createCheckout` opens a hosted Checkout Session: the homeowner enters bank
 * or card details on Stripe's page, never this site's (SAQ A). It sends the
 * site's payment id and the amount, and nothing about the Lot or its owners.
 *
 * `retrievePayment` and `listEventsSince` serve the daily reconciliation job
 * (#543): the session's current state as facts with stable ids, and the
 * events Stripe still lists since a cursor.
 */
export const STRIPE_PROVIDER_ID = 'stripe';

/** Pinned, so a Stripe-side default change cannot reshape what we parse. */
export const STRIPE_API_VERSION = '2026-10-28.endive';

const API_BASE = 'https://api.stripe.com/v1';

/** How far a delivery's signed timestamp may be from now. Never zero. */
const SIGNATURE_TOLERANCE_S = 5 * 60;

/**
 * How long a Checkout Session stays payable. Stripe allows 30 minutes to 24
 * hours; an hour is long enough to finish and short enough that an abandoned
 * session expires the same afternoon, which reports the payment canceled.
 */
const CHECKOUT_LIFETIME_S = 60 * 60;

/**
 * The one line on Stripe's page and the homeowner's statement. Deliberately
 * neutral: no street address and no name, so nothing about the Lot or its
 * owners reaches the provider. The Payment Reference follows it (#562).
 */
const LINE_ITEM_NAME = 'Dues payment';

/** How long Stripe keeps events: a listing with no cursor reads all of it. */
const EVENT_RETENTION_S = 30 * 24 * 60 * 60;

/**
 * How far before the cursor a listing starts. An event can appear in the list
 * a little after its `created` time, so the span just before the last run is
 * read twice; per-event idempotency makes that free.
 */
const CURSOR_OVERLAP_S = 60 * 60;

/** Stripe's largest page. */
const EVENT_PAGE_SIZE = '100';

/**
 * A signed delivery this adapter cannot read. Stripe sent it, so the fault is
 * ours or a shape change: the route answers 500 and Stripe retries, rather
 * than the delivery being called unsigned.
 */
export class UnreadableStripeEvent extends Error {
  constructor(problem: string) {
    super(`Unreadable Stripe event: ${problem}`);
    this.name = 'UnreadableStripeEvent';
  }
}

type StripeObject = Record<string, unknown>;

/** A GET against Stripe's API, already authorized and version-pinned. */
type StripeGet = (
  path: string,
  params: Record<string, string | readonly string[]>,
) => Promise<unknown>;

/**
 * Checkout Session events carry the session, which is the payment's reference
 * (`providerPaymentRef` is the session id). `null` maps the event to nothing.
 */
const SESSION_EVENTS: Readonly<
  Record<string, (session: StripeObject) => PaymentEventType | null>
> = {
  'checkout.session.completed': (s) =>
    s.payment_status === 'paid'
      ? 'payment_succeeded'
      : // Bank debits complete the session before the money settles.
        s.payment_status === 'unpaid'
        ? 'payment_pending'
        : null,
  'checkout.session.async_payment_succeeded': () => 'payment_succeeded',
  'checkout.session.async_payment_failed': () => 'payment_failed',
  'checkout.session.expired': () => 'payment_canceled',
};

/**
 * Dispute and refund events carry a charge-side object, not the session, so
 * the session is found through the object's payment intent. A bank debit that
 * fails after it succeeded arrives as a dispute, so it takes this mapping too.
 */
const CHARGE_EVENTS: Readonly<
  Record<string, { type: PaymentEventType; amountField: string }>
> = {
  'charge.dispute.created': { type: 'dispute_opened', amountField: 'amount' },
  'charge.dispute.funds_withdrawn': {
    type: 'funds_withdrawn',
    amountField: 'amount',
  },
  'charge.dispute.funds_reinstated': {
    type: 'funds_reinstated',
    amountField: 'amount',
  },
  // Each refund on its own, at its own amount. Not `charge.refunded`, whose
  // `amount_refunded` is the charge's running total: a partial refund the
  // board adjusted for would be counted again when the rest was refunded.
  // Two equal partial refunds of one payment look to the application path
  // like one fact reported twice, so the board gets one flag for them.
  'refund.created': { type: 'funds_withdrawn', amountField: 'amount' },
  // A refund that failed after it was counted gives the money back. One that
  // was never counted matches no withdrawal, and the application path says so.
  'refund.failed': { type: 'funds_reinstated', amountField: 'amount' },
};

export function stripeProvider(
  secrets: AdapterSecrets,
  now: () => number = Date.now,
): PaymentProvider {
  const get: StripeGet = (path, params) =>
    stripeGet(secrets.apiKey, path, params);

  return {
    id: STRIPE_PROVIDER_ID,
    async createCheckout({
      paymentId,
      paymentReference,
      amountCents,
      returnUrl,
      cancelUrl,
    }) {
      const session = await stripePost(
        secrets.apiKey,
        '/checkout/sessions',
        {
          mode: 'payment',
          'line_items[0][quantity]': '1',
          'line_items[0][price_data][currency]': 'usd',
          'line_items[0][price_data][unit_amount]': String(amountCents),
          // The Payment Reference twice (#562): in the line item, which the
          // checkout page and the receipt both show, and as the description,
          // which the receipt prints under Summary and the Dashboard searches.
          // The sandbox rehearsal saw both on the hosted receipt.
          'line_items[0][price_data][product_data][name]': `${LINE_ITEM_NAME} · Ref ${paymentReference}`,
          'payment_intent_data[description]': `Payment Reference ${paymentReference}`,
          // Exactly these two, whatever the account's payment-method settings
          // offer by default (#559). The pinned version answers 400 to the
          // older `payment_method_types`, which endive removed. Bank account
          // listed first: it costs the association far less than a card.
          // Stripe may still order its page by its own rules.
          'allowed_payment_method_types[0]': 'us_bank_account',
          'allowed_payment_method_types[1]': 'card',
          // Link would otherwise add its own button and pay-later options
          // (Klarna among them) beside the two above.
          'wallet_options[link][display]': 'never',
          client_reference_id: paymentId,
          'metadata[payment_id]': paymentId,
          expires_at: String(Math.floor(now() / 1000) + CHECKOUT_LIFETIME_S),
          success_url: returnUrl,
          cancel_url: cancelUrl,
        },
        // A retried request can never open a second session for one payment.
        `checkout:${paymentId}`,
      );
      if (!isObject(session))
        throw new UnreadableStripeEvent('the new session is not an object');
      return {
        providerPaymentRef: requiredString(session, 'id'),
        url: requiredString(session, 'url'),
      };
    },
    async verifyAndParseWebhook(request, rawBody): Promise<WebhookParse> {
      const signed = await verifySignature(
        request.headers.get('stripe-signature'),
        rawBody,
        secrets.webhookSecret,
        now(),
      );
      if (!signed) return { ok: false };
      return {
        ok: true,
        events: await normalize(parseEvent(rawBody), get, 'webhook'),
      };
    },
    async retrievePayment(sessionId) {
      const session = await get(
        `/checkout/sessions/${encodeURIComponent(sessionId)}`,
        { 'expand[]': ['payment_intent.latest_charge'] },
      );
      if (!isObject(session))
        throw new UnreadableStripeEvent('the session is not an object');
      return sessionState(session);
    },
    async listEventsSince(cursor) {
      const startedS = Math.floor(now() / 1000);
      const since =
        cursor !== null && /^\d+$/.test(cursor)
          ? Number(cursor) - CURSOR_OVERLAP_S
          : startedS - EVENT_RETENTION_S;
      const events: NormalizedPaymentEvent[] = [];
      for (const event of await listEvents(get, since))
        events.push(...(await normalize(event, get, 'reconciliation')));
      return { events, nextCursor: String(startedS) };
    },
  };
}

/** Every event type this adapter maps, which is all a listing asks for. */
const MAPPED_EVENT_TYPES: readonly string[] = [
  ...Object.keys(SESSION_EVENTS),
  ...Object.keys(CHARGE_EVENTS),
];

/**
 * Every mapped event created since `sinceS`, oldest first. Stripe lists newest
 * first, a page at a time, so the pages are followed to the end and the whole
 * reversed: applying oldest first is the order the facts happened in.
 */
async function listEvents(
  get: StripeGet,
  sinceS: number,
): Promise<StripeEvent[]> {
  const events: StripeEvent[] = [];
  let startingAfter: string | null = null;
  for (;;) {
    const params: Record<string, string | readonly string[]> = {
      'types[]': MAPPED_EVENT_TYPES,
      'created[gte]': String(sinceS),
      limit: EVENT_PAGE_SIZE,
    };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await get('/events', params);
    if (!isObject(page) || !Array.isArray(page.data))
      throw new UnreadableStripeEvent('the event list has no data');
    const data = (page.data as unknown[]).map(readEvent);
    events.push(...data);
    if (page.has_more !== true || data.length === 0) break;
    startingAfter = data[data.length - 1].id;
  }
  return events.reverse();
}

/**
 * A Checkout Session's current state as the facts it amounts to, with ids
 * stable per session and type, so a pull repeated tomorrow is stored once.
 * Only the settlement states: a pull serves a payment still `created` or
 * `pending`, and a withdrawal or dispute after it settled arrives as an event.
 *
 * A settled payment is dated by its charge, the provider's own time for it
 * (a bank debit's charge is when the debit started, a few days before it
 * settled). A pull matters only for what no listed event reported, and the
 * charge precedes any later refund or dispute, so those still apply after it.
 */
function sessionState(session: StripeObject): NormalizedPaymentEvent[] {
  const sessionId = requiredString(session, 'id');
  const fact = (
    type: PaymentEventType,
    occurredAtS: number,
  ): NormalizedPaymentEvent[] => [
    {
      provider: STRIPE_PROVIDER_ID,
      providerEventId: `reconciliation:${sessionId}:${type}`,
      providerPaymentRef: sessionId,
      type,
      amountCents: requiredInteger(session, 'amount_total'),
      currency: requiredString(session, 'currency'),
      occurredAt: new Date(occurredAtS * 1000),
      via: 'reconciliation',
    },
  ];

  if (session.status === 'expired')
    return fact('payment_canceled', requiredInteger(session, 'expires_at'));
  if (session.status !== 'complete') return [];

  const intent = session.payment_intent;
  if (!isObject(intent))
    throw new UnreadableStripeEvent('payment_intent was not expanded');
  const chargedAtS = () => {
    const charge = intent.latest_charge;
    if (!isObject(charge))
      throw new UnreadableStripeEvent('latest_charge was not expanded');
    return requiredInteger(charge, 'created');
  };

  if (session.payment_status === 'paid' || intent.status === 'succeeded')
    return fact('payment_succeeded', chargedAtS());
  if (
    intent.status === 'requires_payment_method' ||
    intent.status === 'canceled'
  )
    return fact('payment_failed', requiredInteger(intent, 'created'));
  // A completed session not yet paid or failed is in progress, as the
  // completion webhook reports it: settling (`processing`), or waiting on the
  // payer, such as a bank account's microdeposit verification
  // (`requires_action`), which has no charge yet.
  return fact(
    'payment_pending',
    isObject(intent.latest_charge)
      ? chargedAtS()
      : requiredInteger(intent, 'created'),
  );
}

interface StripeEvent {
  id: string;
  type: string;
  createdMs: number;
  object: StripeObject;
}

function parseEvent(rawBody: string): StripeEvent {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new UnreadableStripeEvent('the body is not JSON');
  }
  return readEvent(body);
}

/** A Stripe event object, delivered or listed. */
function readEvent(body: unknown): StripeEvent {
  if (!isObject(body)) throw new UnreadableStripeEvent('not an object');
  const data = body.data;
  if (!isObject(data) || !isObject(data.object))
    throw new UnreadableStripeEvent('no data.object');
  return {
    id: requiredString(body, 'id'),
    type: requiredString(body, 'type'),
    createdMs: requiredInteger(body, 'created') * 1000,
    object: data.object,
  };
}

async function normalize(
  event: StripeEvent,
  get: StripeGet,
  via: PaymentEventVia,
): Promise<NormalizedPaymentEvent[]> {
  const fact = (
    type: PaymentEventType,
    providerPaymentRef: string | null,
    amountField: string,
  ): NormalizedPaymentEvent => ({
    provider: STRIPE_PROVIDER_ID,
    providerEventId: event.id,
    providerPaymentRef,
    type,
    amountCents: requiredInteger(event.object, amountField),
    currency: requiredString(event.object, 'currency'),
    occurredAt: new Date(event.createdMs),
    via,
  });

  if (Object.hasOwn(SESSION_EVENTS, event.type)) {
    const type = SESSION_EVENTS[event.type](event.object);
    return type
      ? [fact(type, requiredString(event.object, 'id'), 'amount_total')]
      : [];
  }
  if (Object.hasOwn(CHARGE_EVENTS, event.type)) {
    const { type, amountField } = CHARGE_EVENTS[event.type];
    // Read the fact first, so a malformed object fails before any API call.
    const draft = fact(type, null, amountField);
    const intent = event.object.payment_intent;
    if (intent === null || intent === undefined) return [draft];
    if (typeof intent !== 'string' || !intent)
      throw new UnreadableStripeEvent('payment_intent is not an id');
    return [{ ...draft, providerPaymentRef: await sessionFor(intent, get) }];
  }
  return [];
}

/**
 * The Checkout Session that created a payment intent, or `null` when Stripe
 * knows none (the fact is then unmatched). One extra call, made only for the
 * rare dispute and refund events. A failed call throws, so Stripe retries.
 */
async function sessionFor(
  paymentIntent: string,
  get: StripeGet,
): Promise<string | null> {
  const list = await get('/checkout/sessions', {
    payment_intent: paymentIntent,
    limit: '1',
  });
  if (!isObject(list) || !Array.isArray(list.data))
    throw new UnreadableStripeEvent('the session list has no data');
  const [first] = list.data as unknown[];
  return isObject(first) ? requiredString(first, 'id') : null;
}

async function stripePost(
  apiKey: string,
  path: string,
  form: Record<string, string>,
  idempotencyKey: string,
): Promise<unknown> {
  const response = await fetch(API_BASE + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Stripe-Version': STRIPE_API_VERSION,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': idempotencyKey,
    },
    body: new URLSearchParams(form).toString(),
  });
  // The status only: an error body can echo request details.
  if (!response.ok)
    throw new Error(`Stripe answered ${response.status} for ${path}`);
  return response.json();
}

async function stripeGet(
  apiKey: string,
  path: string,
  params: Record<string, string | readonly string[]>,
): Promise<unknown> {
  const url = new URL(API_BASE + path);
  for (const [name, value] of Object.entries(params))
    for (const one of typeof value === 'string' ? [value] : value)
      url.searchParams.append(name, one);
  const response = await fetch(url.href, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Stripe-Version': STRIPE_API_VERSION,
    },
  });
  // The status only: an error body can echo request details.
  if (!response.ok)
    throw new Error(`Stripe answered ${response.status} for ${path}`);
  return response.json();
}

/**
 * Stripe's `Stripe-Signature` scheme, by hand: `t=<unix seconds>` and one or
 * more `v1=<hex HMAC-SHA256 of "<t>.<raw body>">`. Every other scheme (`v0`,
 * a test-only one) is ignored, so a delivery carrying only those is refused.
 * Any one valid `v1` suffices, which is how a secret roll looks. The
 * comparison is WebCrypto's HMAC verify, which is constant time.
 */
async function verifySignature(
  header: string | null,
  rawBody: string,
  secret: string,
  nowMs: number,
): Promise<boolean> {
  if (!header) return false;
  let timestamp: string | null = null;
  const signatures: Uint8Array<ArrayBuffer>[] = [];
  for (const part of header.split(',')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') {
      const bytes = hexBytes(value);
      if (bytes) signatures.push(bytes);
    }
  }
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0)
    return false;
  const ageS = Math.abs(nowMs / 1000 - Number(timestamp));
  if (!(ageS <= SIGNATURE_TOLERANCE_S)) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const payload = new TextEncoder().encode(`${timestamp}.${rawBody}`);
  for (const signature of signatures)
    if (await crypto.subtle.verify('HMAC', key, signature, payload))
      return true;
  return false;
}

/** A SHA-256 MAC in lower- or upper-case hex, or `null`. */
function hexBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

const isObject = (value: unknown): value is StripeObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function requiredString(object: StripeObject, field: string): string {
  const value = object[field];
  if (typeof value !== 'string' || !value)
    throw new UnreadableStripeEvent(`${field} is not a string`);
  return value;
}

function requiredInteger(object: StripeObject, field: string): number {
  const value = object[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new UnreadableStripeEvent(`${field} is not an integer`);
  return value;
}
