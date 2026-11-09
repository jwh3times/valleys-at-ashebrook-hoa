import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requirePaymentRefreshApi } from '../../../../server/authz/member-guards';
import { readJson, stringField } from '../../../../server/http';
import { associationDateIso } from '../../../../lib/format';
import { fetchMemberPayment } from '../../../../server/lot-records/reads';
import { refreshPayment } from '../../../../server/payments/refresh';
import { paymentProviderFor } from '../../../../server/payments/registry';

// A homeowner checks one payment with the provider (ADR 0025, #544).
//
// `requirePaymentRefreshApi` answers the Lot Records flags and provider (404),
// the freeze (503), exact Origin (403), the JSON media type (415), the session
// (401) and `member` (403), in that order. `onlinePaymentsEnabled` is NOT
// required: a payment in flight stays chaseable after payments are turned off.
//
// The body is `{ paymentId }`. A payment the caller may not read — another
// Lot's, the seller's from before their own period, or none — is the masked
// 404, decided by the same read the return page uses. The provider is asked at
// most once a minute per payment; inside that window the answer is the stored
// status with `pulled: false`, so the return page can keep showing what a
// webhook has written meanwhile.
//
// It answers `{ status, ledgerState, pulled }`.

export const prerender = false;

const NOT_FOUND = () => new Response('Not found', { status: 404 });

export const POST: APIRoute = async ({ request, locals }) => {
  const gate = await requirePaymentRefreshApi(locals, request, env);
  if (!gate.ok) return gate.res;

  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Invalid JSON body', { status: 400 });
  const paymentId = stringField(parsed.value, 'paymentId');
  if (!paymentId) return new Response('paymentId is required', { status: 400 });

  const provider = paymentProviderFor(env);
  const personId = gate.ctx.personId;
  if (!provider || !personId) return NOT_FOUND();

  const now = new Date();
  const today = associationDateIso(now);
  const payment = await fetchMemberPayment(env, personId, paymentId, today);
  if (!payment) return NOT_FOUND();

  let pulled;
  try {
    pulled = await refreshPayment(env, provider, payment, now);
  } catch (error) {
    // Ids only: the provider's answer can echo request details.
    console.error('member-payments: a payment could not be refreshed', {
      provider: provider.id,
      paymentId: payment.id,
      error: error instanceof Error ? error.name : typeof error,
    });
    return new Response(
      'The payment service could not be reached. Please try again in a minute.',
      { status: 502 },
    );
  }

  const current = pulled
    ? await fetchMemberPayment(env, personId, paymentId, today)
    : payment;
  if (!current) return NOT_FOUND();
  return Response.json({
    status: current.status,
    ledgerState: current.ledgerState,
    pulled,
  });
};
