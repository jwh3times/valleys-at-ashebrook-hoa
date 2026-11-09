import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import {
  BOARD_PAYMENT_RESOLUTIONS,
  MAX_RESOLUTION_NOTE_LENGTH,
  PAYMENT_STATUSES,
  isoDateOrError,
  type BoardPaymentResolution,
  type PaymentStatus,
} from '../../../lib/types';
import { paymentProviderFor } from '../../../server/payments/registry';
import {
  applyUnmatchedPayment,
  resolvePaymentException,
  type ApplyUnmatchedOutcome,
  type ResolveOutcome,
} from '../../../server/payments/apply';
import {
  fetchBoardPaymentDetail,
  listBoardPayments,
  listOpenPaymentExceptions,
  resyncBoardPayment,
} from '../../../server/payments/board';
import { exportProviderEntries } from '../../../server/payments/export';
import type { PaymentProvider } from '../../../server/payments/provider';

export const prerender = false;

/**
 * THE BOARD'S PAYMENTS SURFACE (ADR 0025, #545).
 *
 * Gate order is board-first, as ADR 0024 fixes for admin routes:
 * `requireBoard` (write freeze `503` on a mutation, `401`, `403`), then a
 * configured payment provider (`404` without one, like every payment
 * surface). It does NOT need the Lot Records flags to read: ingestion never
 * reads a flag, so payments keep arriving while Lot Records is off and the
 * board must still be able to see them. Applying a payment to a Lot writes a
 * ledger entry, so that one re-checks the flags inside its INSERT.
 *
 * Every write the board makes carries an operation key minted when its form
 * opens, and the key becomes the id of the row the write creates. A retry of
 * the same submission is then answered "already recorded", which is true,
 * rather than "someone else got there first", which would not be. A re-sync
 * creates nothing of its own (its facts are the provider's, stored once), so
 * it takes no key, and neither does the treasurer's CSV `export` (#546),
 * which only reads.
 */

const NOT_FOUND = () => new Response('Not found', { status: 404 });
const refuse = (status: number, message: string) =>
  new Response(message, { status });

/** The key a form minted: `crypto.randomUUID()`'s shape, nothing else. */
const OPERATION_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function operationKeyOrError(
  body: unknown,
): { ok: true; value: string } | { ok: false; res: Response } {
  const key = stringField(body, 'operationKey');
  if (!OPERATION_KEY.test(key))
    return {
      ok: false,
      res: refuse(
        400,
        'operationKey is required, as a lower-case UUID — send the same key to retry a submission safely',
      ),
    };
  return { ok: true, value: key };
}

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  if (!paymentProviderFor(env)) return NOT_FOUND();

  const url = new URL(request.url);
  // Presence, not truthiness: `?id=` with no value must not fall through to
  // the whole list.
  if (url.searchParams.has('id')) {
    const id = url.searchParams.get('id') ?? '';
    if (!id) return refuse(400, 'id requires a payment id');
    const detail = await fetchBoardPaymentDetail(env, id);
    return detail ? Response.json(detail) : NOT_FOUND();
  }

  const lotId = url.searchParams.get('lotId') || undefined;
  const status = url.searchParams.get('status') || undefined;
  if (
    status !== undefined &&
    !(PAYMENT_STATUSES as readonly string[]).includes(status)
  )
    return refuse(400, `status must be one of: ${PAYMENT_STATUSES.join(', ')}`);

  const [payments, exceptions] = await Promise.all([
    listBoardPayments(env, {
      lotId,
      status: status as PaymentStatus | undefined,
    }),
    listOpenPaymentExceptions(env),
  ]);
  return Response.json({ payments, exceptions });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const provider = paymentProviderFor(env);
  if (!provider) return NOT_FOUND();

  const parsed = await readJson(request);
  if (!parsed.ok) return refuse(400, 'Malformed JSON body');
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return refuse(401, 'Unauthorized');

  switch (stringField(parsed.value, 'action')) {
    case 'resync':
      return resync(parsed.value, provider);
    case 'resolveException':
      return resolve(parsed.value, ctx.userId);
    case 'applyUnmatched':
      return apply(parsed.value, ctx.userId);
    case 'export':
      return exportCsv(parsed.value);
    default:
      return refuse(
        400,
        'Unknown action — expected one of: resync, resolveException, applyUnmatched, export',
      );
  }
};

/**
 * The treasurer's CSV of provider-sourced entries over a range of
 * Association Days, both ends included. It writes nothing, so it takes no
 * operation key. It is a `POST` action as the spec fixes it, so the write
 * freeze holds it too.
 */
async function exportCsv(body: unknown): Promise<Response> {
  const from = isoDateOrError(stringField(body, 'from'), 'from');
  if (!from.ok) return refuse(400, from.error);
  const to = isoDateOrError(stringField(body, 'to'), 'to');
  if (!to.ok) return refuse(400, to.error);
  // Association Days are `YYYY-MM-DD`, so text order is day order.
  if (to.value < from.value) return refuse(400, 'to must not be before from');

  const csv = await exportProviderEntries(env, {
    from: from.value,
    to: to.value,
  });
  return new Response(csv, {
    headers: { 'content-type': 'text/csv; charset=utf-8' },
  });
}

async function resync(
  body: unknown,
  provider: PaymentProvider,
): Promise<Response> {
  const paymentId = stringField(body, 'paymentId');
  if (!paymentId) return refuse(400, 'paymentId is required');

  let outcome;
  try {
    outcome = await resyncBoardPayment(env, provider, paymentId, new Date());
  } catch (error) {
    // Ids and the error's name only: a provider error can quote the payer.
    console.error(
      `[payments] board re-sync failed for payment ${paymentId}: ${
        error instanceof Error ? error.name : 'unknown error'
      }`,
    );
    return refuse(
      502,
      'The payment service could not be reached. Nothing changed; try again in a minute.',
    );
  }
  switch (outcome.kind) {
    case 'not_found':
      return NOT_FOUND();
    case 'no_reference':
      return refuse(
        409,
        'That payment has no provider reference, so there is nothing to ask the provider about',
      );
    case 'other_provider':
      return refuse(
        409,
        'That payment was taken through a different payment provider than the one configured now',
      );
    case 'pulled':
      return Response.json({ recorded: outcome.recorded });
  }
}

async function resolve(body: unknown, accountId: string): Promise<Response> {
  const exceptionId = stringField(body, 'exceptionId');
  if (!exceptionId) return refuse(400, 'exceptionId is required');

  const resolution = stringField(body, 'resolution');
  if (!(BOARD_PAYMENT_RESOLUTIONS as readonly string[]).includes(resolution))
    return refuse(
      400,
      `resolution must be one of: ${BOARD_PAYMENT_RESOLUTIONS.join(', ')}`,
    );

  const rawNote = (body as Record<string, unknown> | null)?.note;
  if (rawNote !== undefined && rawNote !== null && typeof rawNote !== 'string')
    return refuse(400, 'note must be text');
  const note = stringField(body, 'note') || null;
  if (note !== null && note.length > MAX_RESOLUTION_NOTE_LENGTH)
    return refuse(
      400,
      `note is longer than ${MAX_RESOLUTION_NOTE_LENGTH} characters`,
    );
  // "Other" says nothing by itself: the note is the only record of what was
  // decided.
  if (resolution === 'other' && note === null)
    return refuse(400, 'A note is required when the resolution is "other"');

  const key = operationKeyOrError(body);
  if (!key.ok) return key.res;

  const outcome = await resolvePaymentException(
    env,
    {
      resolutionId: key.value,
      exceptionId,
      resolution: resolution as BoardPaymentResolution,
      note,
      accountId,
    },
    new Date(),
  );
  if (outcome === 'resolved')
    return Response.json({ id: key.value }, { status: 201 });
  return notWritten(outcome);
}

async function apply(body: unknown, accountId: string): Promise<Response> {
  const exceptionId = stringField(body, 'exceptionId');
  if (!exceptionId) return refuse(400, 'exceptionId is required');
  const lotId = stringField(body, 'lotId');
  if (!lotId) return refuse(400, 'lotId is required');
  const key = operationKeyOrError(body);
  if (!key.ok) return key.res;

  const outcome = await applyUnmatchedPayment(
    env,
    { key: key.value, exceptionId, lotId, accountId },
    new Date(),
  );
  if (outcome.kind === 'applied')
    return Response.json({ paymentId: outcome.paymentId }, { status: 201 });
  return notWritten(outcome.kind);
}

/** The honest answer for each way a resolve or an apply wrote nothing. */
function notWritten(
  why: Exclude<
    ResolveOutcome | ApplyUnmatchedOutcome['kind'],
    'resolved' | 'applied'
  >,
): Response {
  switch (why) {
    case 'not_found':
      return NOT_FOUND();
    case 'retried':
      return refuse(
        409,
        'This was already recorded — nothing was recorded twice',
      );
    case 'already_resolved':
      return refuse(409, 'That exception has already been resolved');
    case 'key_reused':
      return refuse(
        409,
        'That operation key has already been used for something else — use a new key',
      );
    case 'not_applicable':
      return refuse(
        409,
        'Only a settled payment in US dollars that names a provider reference can be applied to a lot',
      );
    case 'lot_unavailable':
      return refuse(409, 'Lot not found, or lot records are not enabled');
    case 'reference_taken':
      return refuse(
        409,
        "That payment's provider reference already belongs to another payment",
      );
  }
}
