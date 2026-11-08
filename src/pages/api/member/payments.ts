import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requirePaymentStartApi } from '../../../server/authz/member-guards';
import { readJson, stringField } from '../../../server/http';
import { paymentAmountError } from '../../../lib/payments';
import { startPayment } from '../../../server/payments/checkout';
import { paymentProviderFor } from '../../../server/payments/registry';

// A homeowner starts paying dues on a Lot they hold (ADR 0025, #542).
//
// `requirePaymentStartApi` answers the flags and provider (404), the freeze
// (503), exact Origin (403), the JSON media type (415), the session (401) and
// `member` (403), in that order. The body is `{ lotId, amountCents }`, the
// amount integer cents within the shared payment bounds. A Lot the caller does
// not hold is the masked 404, never 403. `startPayment` opens the provider's
// checkout and records the payment in one insert that re-checks the flags and
// Lot Authority, so a lost race answers 409 or the masked 404 and writes
// nothing.
//
// It answers `{ url }`, and the browser navigates there: the CSP's
// `form-action 'self'` rules out a cross-origin form redirect.

export const prerender = false;

const NOT_FOUND = () => new Response('Not found', { status: 404 });

export const POST: APIRoute = async ({ request, locals }) => {
  const gate = await requirePaymentStartApi(locals, request, env);
  if (!gate.ok) return gate.res;

  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Invalid JSON body', { status: 400 });
  const lotId = stringField(parsed.value, 'lotId');
  if (!lotId) return new Response('lotId is required', { status: 400 });
  const amountCents = (parsed.value as Record<string, unknown> | null)
    ?.amountCents;
  const amountError = paymentAmountError(amountCents);
  if (amountError) return new Response(amountError, { status: 400 });

  // No Person Link means no Lot Authority to scope by: the masked 404.
  const personId = gate.ctx.personId;
  const provider = paymentProviderFor(env);
  if (!personId || !provider) return NOT_FOUND();

  let started;
  try {
    started = await startPayment(env, provider, {
      personId,
      lotId,
      amountCents: amountCents as number,
      siteUrl: env.BETTER_AUTH_URL,
    });
  } catch (error) {
    // Ids only: the provider's answer can echo request details.
    console.error('member-payments: the checkout could not be opened', {
      provider: provider.id,
      error: error instanceof Error ? error.name : typeof error,
    });
    return new Response(
      'The payment service could not be reached. Nothing was charged; please try again.',
      { status: 502 },
    );
  }
  if (started.kind === 'not_found') return NOT_FOUND();
  if (started.kind === 'conflict')
    return new Response(
      'Online payments were turned off just now. Nothing was charged.',
      { status: 409 },
    );
  return Response.json({ url: started.url }, { status: 201 });
};
