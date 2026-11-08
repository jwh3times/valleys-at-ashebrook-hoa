import { writeFreezeError } from '../authz/write-freeze';
import { applyPaymentEvent } from './apply';
import type { WebhookParse } from './provider';
import { paymentProviderFor } from './registry';

/**
 * `POST /api/webhooks/payments` (ADR 0025, #541): the provider telling the
 * site about a payment.
 *
 * In order:
 *
 * 1. **No provider configured → 404.** The endpoint does not exist, which is
 *    what a deployment without a merchant account looks like.
 * 2. **Write freeze → 503**, before the body is read. The provider retries,
 *    so a delivery during maintenance is delayed, never lost. There is no
 *    exemption; middleware's final branch applies the same freeze in
 *    production.
 * 3. **The raw body, as text, verified by the adapter before anything parses
 *    it → 400 when unverified**, with nothing stored. This is the one route
 *    that reads its body as text rather than through `readJson`, because the
 *    signature covers the exact bytes.
 * 4. **Each normalized fact applied in its own batch**, in order. `200` only
 *    when every one was applied, a duplicate or unmatched; an unmapped event
 *    type is zero facts and a `200`. Any failure answers `500` so the provider
 *    redelivers, and the facts before it are re-applied then as duplicates.
 *
 * It reads no site flag: ingestion never does (#538), so a payment already in
 * flight lands even with online payments switched off. Logs carry ids and
 * counts only, never the payload.
 */
export async function handlePaymentWebhook(
  env: Env,
  request: Request,
): Promise<Response> {
  const provider = paymentProviderFor(env);
  if (!provider) return new Response('Not found', { status: 404 });

  const frozen = await writeFreezeError(env, request);
  if (frozen) return frozen;

  const rawBody = await request.text();
  let parsed: WebhookParse;
  try {
    parsed = await provider.verifyAndParseWebhook(request, rawBody);
  } catch (error) {
    console.error(
      'payments-webhook: the delivery could not be verified or read',
      {
        provider: provider.id,
        error: errorName(error),
      },
    );
    return new Response('Could not read the delivery', { status: 500 });
  }
  if (!parsed.ok) return new Response('Invalid signature', { status: 400 });

  for (const event of parsed.events) {
    try {
      await applyPaymentEvent(env, event);
    } catch (error) {
      console.error('payments-webhook: a fact could not be applied', {
        provider: provider.id,
        providerEventId: event.providerEventId,
        error: errorName(error),
      });
      return new Response('Could not record the delivery', { status: 500 });
    }
  }
  return new Response('OK', { status: 200 });
}

const errorName = (error: unknown) =>
  error instanceof Error ? error.name : typeof error;
