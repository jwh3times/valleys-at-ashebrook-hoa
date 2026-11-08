import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { handlePaymentWebhook } from '../../../server/payments/webhook';

export const prerender = false;

// The payment provider's webhook (ADR 0025, #541). Outside both session
// namespaces on purpose: the caller is the provider, authenticated by the
// signature the adapter verifies, never by a session. Only POST is exported;
// the guards live in handlePaymentWebhook, beside the rest of the payment
// rail, so this file stays a binding.
export const POST: APIRoute = ({ request }) =>
  handlePaymentWebhook(env, request);
