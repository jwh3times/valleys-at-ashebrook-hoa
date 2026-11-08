import type { PaymentEventType } from '../../../lib/types';
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
 * `createCheckout` arrives with #542, `retrievePayment` and `listEventsSince`
 * with #543. Nothing calls them before then.
 */
export const STRIPE_PROVIDER_ID = 'stripe';

/** Pinned, so a Stripe-side default change cannot reshape what we parse. */
export const STRIPE_API_VERSION = '2026-10-28.endive';

const API_BASE = 'https://api.stripe.com/v1';

/** How far a delivery's signed timestamp may be from now. Never zero. */
const SIGNATURE_TOLERANCE_S = 5 * 60;

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
  params: Record<string, string>,
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
    createCheckout: () => notYet('createCheckout', '#542'),
    async verifyAndParseWebhook(request, rawBody): Promise<WebhookParse> {
      const signed = await verifySignature(
        request.headers.get('stripe-signature'),
        rawBody,
        secrets.webhookSecret,
        now(),
      );
      if (!signed) return { ok: false };
      return { ok: true, events: await normalize(parseEvent(rawBody), get) };
    },
    retrievePayment: () => notYet('retrievePayment', '#543'),
    listEventsSince: () => notYet('listEventsSince', '#543'),
  };
}

function notYet(method: string, ticket: string): never {
  throw new Error(`The Stripe adapter's ${method} arrives with ${ticket}`);
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
    via: 'webhook',
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

async function stripeGet(
  apiKey: string,
  path: string,
  params: Record<string, string>,
): Promise<unknown> {
  const url = new URL(API_BASE + path);
  for (const [name, value] of Object.entries(params))
    url.searchParams.set(name, value);
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
