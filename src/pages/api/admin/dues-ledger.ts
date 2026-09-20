import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import {
  LOT_RECORDS_ENABLED_SQL,
  lotRecordsAvailable,
} from '../../../server/lot-records/gate';
import { fetchAdminLotDuesLedger } from '../../../server/lot-records/reads';
import {
  isoDateOrError,
  DUES_CHARGE_CATEGORIES,
  DUES_PAYMENT_METHODS,
} from '../../../lib/types';

export const prerender = false;

/**
 * BOARD ENTRY FOR THE DUES LEDGER (ADR 0025, #295 slice 2).
 *
 * The ledger is append-only, so this route only ever INSERTs. There is no
 * PATCH and no DELETE, and adding one would be the whole design going away: a
 * mistaken entry is corrected by appending its `reverse`, and a real-world
 * credit or debit by an `adjustment`. That is what makes the balance a sum of
 * things that happened rather than a number someone maintained.
 *
 * Gate order is board-first, as ADR 0024 fixes for admin routes: `requireBoard`
 * (write freeze `503`, `401`, `403`), then both flags (`404`), then the body.
 * Every mutation re-checks the flags inside its own statement and appends one
 * `lot_record_events` row in the same D1 batch, gated on `changes() = 1`.
 *
 * **Money never passes through a float or a `||` default.** Amounts arrive as
 * integer cents and are validated as integers; a blank field is rejected
 * rather than defaulted, because for money the difference between "blank" and
 * "zero" is the difference between a mistake and a decision.
 *
 * **Idempotency is the caller's to assert.** Every write carries an
 * `operationKey`, unique per lot, so a double submit posts nothing twice. The
 * panel generates one when a form opens and a new one after a post succeeds.
 * A bulk assessment uses ONE key for every lot it touches, which is why the
 * uniqueness is `(operation_key, lot_id)` rather than the key alone.
 */

const NOT_FOUND = () => new Response('Not found', { status: 404 });

/** Cents from the body: an integer, present, and non-zero. */
function centsOrError(
  body: unknown,
  key: string,
): { ok: true; value: number } | { ok: false; res: Response } {
  const raw = (body as Record<string, unknown> | null)?.[key];
  const fail = (message: string) => ({
    ok: false as const,
    res: new Response(message, { status: 400 }),
  });
  // Deliberately not `Number(raw) || fallback`: `Number('')` and `Number('0')`
  // are both 0, so a blank field would silently become a real amount. Blank is
  // its own answer here, and zero is refused outright — a zero-cent entry is
  // never a fact anyone meant to record.
  if (raw === undefined || raw === null || raw === '')
    return fail(`${key} is required, in whole cents`);
  if (typeof raw !== 'number' || !Number.isInteger(raw))
    return fail(`${key} must be a whole number of cents`);
  if (raw === 0) return fail(`${key} cannot be zero`);
  return { ok: true, value: raw };
}

/** The idempotency key every write carries. */
function operationKeyOrError(
  body: unknown,
): { ok: true; value: string } | { ok: false; res: Response } {
  const key = stringField(body, 'operationKey');
  if (!key)
    return {
      ok: false,
      res: new Response(
        'operationKey is required — send the same key to retry a submission safely',
        { status: 400 },
      ),
    };
  return { ok: true, value: key };
}

/** The `lot_record_events` insert that rides every mutation's batch. */
function eventInsert(recordId: string, accountId: string) {
  return env.DATABASE.prepare(
    `INSERT INTO lot_record_events
       (id, record_type, record_id, action, acting_account_id, reason_code, recorded_at)
     SELECT ?, 'dues_ledger_entries', ?, 'created', ?, NULL, ?
      WHERE changes() = 1`,
  ).bind(crypto.randomUUID(), recordId, accountId, Date.now());
}

/**
 * The columns every entry insert writes, in one place: fifteen positional
 * binds are exactly where a silent mis-post would come from.
 */
const ENTRY_COLUMNS = `(id, lot_id, kind, amount_cents, effective_day, description,
      category, method, reference, source, payment_id, reverses_entry_id,
      recorded_by, recorded_at, operation_key)`;

interface EntryInput {
  id: string;
  lotId: string;
  kind: 'charge' | 'payment' | 'adjustment';
  amountCents: number;
  effectiveDay: string;
  description: string;
  category: string | null;
  method: string | null;
  reference: string | null;
  accountId: string;
  operationKey: string;
}

/**
 * One board-entered row.
 *
 * The lot is checked inside the INSERT rather than by a preflight SELECT: the
 * foreign key would refuse a missing lot anyway, but as a raw D1 error rather
 * than a readable status. `EXISTS` turns that and a flags race into the same
 * handled `409`.
 */
function entryInsert(input: EntryInput) {
  return env.DATABASE.prepare(
    `INSERT INTO dues_ledger_entries ${ENTRY_COLUMNS}
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'board', NULL, NULL, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM properties WHERE properties.id = ?)
        AND ${LOT_RECORDS_ENABLED_SQL}`,
  ).bind(
    input.id,
    input.lotId,
    input.kind,
    input.amountCents,
    input.effectiveDay,
    input.description,
    input.category,
    input.method,
    input.reference,
    input.accountId,
    Date.now(),
    input.operationKey,
    input.lotId,
  );
}

/** Run an insert and its event append as one batch, answering uniformly. */
async function post(
  statement: D1PreparedStatement,
  recordId: string,
  accountId: string,
  conflict: string,
): Promise<Response> {
  let applied, logged;
  try {
    [applied, logged] = await env.DATABASE.batch([
      statement,
      eventInsert(recordId, accountId),
    ]);
  } catch (error) {
    // The duplicate `(operation_key, lot_id)` a double submit produces is a
    // UNIQUE violation rather than a zero-row no-op, and it means the first
    // submission already landed — which is success, not a server fault.
    if (String(error).includes('UNIQUE'))
      return new Response(
        'This entry was already posted — nothing was posted twice',
        { status: 409 },
      );
    throw error;
  }
  if (applied.meta.changes !== 1)
    return new Response(conflict, { status: 409 });
  if (logged.meta.changes !== 1)
    return new Response(
      'The entry was posted, but its event was not logged — contact an administrator',
      { status: 500 },
    );
  return Response.json({ id: recordId }, { status: 201 });
}

/** Fields every board-entered entry shares. */
function commonOrError(body: unknown) {
  const lotId = stringField(body, 'lotId');
  if (!lotId)
    return {
      ok: false as const,
      res: new Response('lotId is required', { status: 400 }),
    };

  const effectiveDay = stringField(body, 'effectiveDay');
  if (!effectiveDay)
    return {
      ok: false as const,
      res: new Response('effectiveDay is required', { status: 400 }),
    };
  const dayCheck = isoDateOrError(effectiveDay, 'effectiveDay');
  if (!dayCheck.ok)
    return {
      ok: false as const,
      res: new Response(dayCheck.error, { status: 400 }),
    };

  const description = stringField(body, 'description');
  if (!description)
    return {
      ok: false as const,
      res: new Response('description is required — the homeowner reads it', {
        status: 400,
      }),
    };

  const key = operationKeyOrError(body);
  if (!key.ok) return { ok: false as const, res: key.res };

  return {
    ok: true as const,
    lotId,
    effectiveDay,
    description,
    // Board-only, and optional: a check number, say.
    reference: stringField(body, 'reference') || null,
    operationKey: key.value,
  };
}

async function postCharge(body: unknown, accountId: string) {
  const common = commonOrError(body);
  if (!common.ok) return common.res;

  const category = stringField(body, 'category');
  if (!(DUES_CHARGE_CATEGORIES as readonly string[]).includes(category))
    return new Response(
      `category must be one of: ${DUES_CHARGE_CATEGORIES.join(', ')}`,
      { status: 400 },
    );

  const amount = centsOrError(body, 'amountCents');
  if (!amount.ok) return amount.res;
  // A charge is owed, so it is positive. The API takes the amount as the board
  // says it — "a $450 assessment" — rather than asking them to think in signs.
  if (amount.value < 0)
    return new Response('A charge is a positive amount', { status: 400 });

  const id = crypto.randomUUID();
  return post(
    entryInsert({
      id,
      lotId: common.lotId,
      kind: 'charge',
      amountCents: amount.value,
      effectiveDay: common.effectiveDay,
      description: common.description,
      category,
      method: null,
      reference: common.reference,
      accountId,
      operationKey: common.operationKey,
    }),
    id,
    accountId,
    'Lot not found, or lot records are not enabled',
  );
}

async function postPayment(body: unknown, accountId: string) {
  const common = commonOrError(body);
  if (!common.ok) return common.res;

  const method = stringField(body, 'method');
  if (!(DUES_PAYMENT_METHODS as readonly string[]).includes(method))
    return new Response(
      `method must be one of: ${DUES_PAYMENT_METHODS.join(', ')}`,
      { status: 400 },
    );
  if (method === 'online')
    return new Response(
      'An online payment is recorded from the provider, never by hand',
      { status: 400 },
    );

  const amount = centsOrError(body, 'amountCents');
  if (!amount.ok) return amount.res;
  if (amount.value < 0)
    return new Response(
      'Send a payment as a positive amount — the ledger stores it as a credit',
      { status: 400 },
    );

  const id = crypto.randomUUID();
  return post(
    entryInsert({
      id,
      lotId: common.lotId,
      kind: 'payment',
      // Stored negative so the balance stays a plain sum.
      amountCents: -amount.value,
      effectiveDay: common.effectiveDay,
      description: common.description,
      category: null,
      method,
      reference: common.reference,
      accountId,
      operationKey: common.operationKey,
    }),
    id,
    accountId,
    'Lot not found, or lot records are not enabled',
  );
}

async function postAdjustment(body: unknown, accountId: string) {
  const common = commonOrError(body);
  if (!common.ok) return common.res;

  // The one kind whose sign the board must choose, because an adjustment can
  // go either way: a waiver credits the lot, a correction may debit it.
  const amount = centsOrError(body, 'amountCents');
  if (!amount.ok) return amount.res;

  const id = crypto.randomUUID();
  return post(
    entryInsert({
      id,
      lotId: common.lotId,
      kind: 'adjustment',
      amountCents: amount.value,
      effectiveDay: common.effectiveDay,
      description: common.description,
      category: null,
      method: null,
      reference: common.reference,
      accountId,
      operationKey: common.operationKey,
    }),
    id,
    accountId,
    'Lot not found, or lot records are not enabled',
  );
}

/**
 * Reverse an entry — the only correction the ledger has.
 *
 * Three of ADR 0025's rules cannot be same-row CHECKs and live here instead,
 * inside the `INSERT … SELECT` that reads the original: the reversal's amount
 * is exactly the negation of the original, it takes the original's lot, and a
 * reversal may not itself be reversed. "Already reversed" is left to the
 * UNIQUE index on `reverses_entry_id`, which is the only form of it that
 * survives two requests racing.
 */
async function reverse(body: unknown, accountId: string) {
  const targetId = stringField(body, 'entryId');
  if (!targetId) return new Response('entryId is required', { status: 400 });

  const effectiveDay = stringField(body, 'effectiveDay');
  if (!effectiveDay)
    return new Response('effectiveDay is required', { status: 400 });
  const dayCheck = isoDateOrError(effectiveDay, 'effectiveDay');
  if (!dayCheck.ok) return new Response(dayCheck.error, { status: 400 });

  const description = stringField(body, 'description');
  if (!description)
    return new Response('description is required — the homeowner reads it', {
      status: 400,
    });

  const key = operationKeyOrError(body);
  if (!key.ok) return key.res;

  const id = crypto.randomUUID();
  const insert = env.DATABASE.prepare(
    `INSERT INTO dues_ledger_entries ${ENTRY_COLUMNS}
     SELECT ?, original.lot_id, 'reversal', -original.amount_cents, ?, ?,
            NULL, NULL, ?, 'board', NULL, original.id, ?, ?, ?
       FROM dues_ledger_entries original
      WHERE original.id = ?
        AND original.kind <> 'reversal'
        AND ${LOT_RECORDS_ENABLED_SQL}`,
  ).bind(
    id,
    effectiveDay,
    description,
    stringField(body, 'reference') || null,
    accountId,
    Date.now(),
    key.value,
    targetId,
  );

  return post(
    insert,
    id,
    accountId,
    'That entry cannot be reversed — it does not exist, is itself a reversal, or lot records are not enabled',
  );
}

/**
 * One assessment posted to every non-retired lot, in one statement, under ONE
 * operation key.
 *
 * The key is shared on purpose: re-submitting the same bulk post collides per
 * lot and writes nothing, which is what makes a double click safe on the one
 * action that touches every home at once. Row ids come from SQLite rather than
 * from a loop in TypeScript, so this stays a single statement — a partially
 * posted assessment would be worse than a failed one.
 */
async function postBulkAssessment(body: unknown, accountId: string) {
  const effectiveDay = stringField(body, 'effectiveDay');
  if (!effectiveDay)
    return new Response('effectiveDay is required', { status: 400 });
  const dayCheck = isoDateOrError(effectiveDay, 'effectiveDay');
  if (!dayCheck.ok) return new Response(dayCheck.error, { status: 400 });

  const description = stringField(body, 'description');
  if (!description)
    return new Response('description is required — the homeowner reads it', {
      status: 400,
    });

  const category = stringField(body, 'category');
  if (!(DUES_CHARGE_CATEGORIES as readonly string[]).includes(category))
    return new Response(
      `category must be one of: ${DUES_CHARGE_CATEGORIES.join(', ')}`,
      { status: 400 },
    );

  const amount = centsOrError(body, 'amountCents');
  if (!amount.ok) return amount.res;
  if (amount.value < 0)
    return new Response('A charge is a positive amount', { status: 400 });

  const key = operationKeyOrError(body);
  if (!key.ok) return key.res;

  let result;
  try {
    result = await env.DATABASE.prepare(
      `INSERT INTO dues_ledger_entries ${ENTRY_COLUMNS}
       SELECT lower(hex(randomblob(16))), properties.id, 'charge', ?, ?, ?,
              ?, NULL, NULL, 'board', NULL, NULL, ?, ?, ?
         FROM properties
        WHERE properties.retired_at IS NULL
          AND ${LOT_RECORDS_ENABLED_SQL}`,
    )
      .bind(
        amount.value,
        effectiveDay,
        description,
        category,
        accountId,
        Date.now(),
        key.value,
      )
      .run();
  } catch (error) {
    if (String(error).includes('UNIQUE'))
      return new Response(
        'This assessment was already posted — nothing was posted twice',
        { status: 409 },
      );
    throw error;
  }

  const posted = result.meta.changes;
  if (posted === 0)
    return new Response(
      'Nothing was posted — there are no active lots, or lot records are not enabled',
      { status: 409 },
    );
  // Deliberately no `lot_record_events` row per entry here. The log's subject
  // is one record, and a bulk post would write one row per lot for an act the
  // board took once; the shared `operation_key` is what ties those entries
  // together, and it is on every one of them.
  return Response.json({ posted }, { status: 201 });
}

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  if (!(await lotRecordsAvailable(env))) return NOT_FOUND();

  const url = new URL(request.url);
  const lotId = url.searchParams.get('lotId') ?? undefined;
  return Response.json(await fetchAdminLotDuesLedger(env, lotId));
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  if (!(await lotRecordsAvailable(env))) return NOT_FOUND();

  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });

  switch (stringField(parsed.value, 'action')) {
    case 'postCharge':
      return postCharge(parsed.value, ctx.userId);
    case 'postPayment':
      return postPayment(parsed.value, ctx.userId);
    case 'postAdjustment':
      return postAdjustment(parsed.value, ctx.userId);
    case 'reverse':
      return reverse(parsed.value, ctx.userId);
    case 'postBulkAssessment':
      return postBulkAssessment(parsed.value, ctx.userId);
    default:
      return new Response(
        'Unknown action — expected one of: postCharge, postPayment, postAdjustment, reverse, postBulkAssessment',
        { status: 400 },
      );
  }
};
