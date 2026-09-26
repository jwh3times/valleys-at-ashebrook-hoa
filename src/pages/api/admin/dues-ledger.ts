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
import {
  fetchAdminLotDuesLedger,
  fetchAdminLotRecordEvents,
} from '../../../server/lot-records/reads';
import {
  isoDateOrError,
  DUES_CHARGE_CATEGORIES,
  DUES_PAYMENT_METHODS,
} from '../../../lib/types';
import { MAX_ENTRY_CENTS } from '../../../lib/money';

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

// The bound is defined once, in `src/lib/money.ts`, so the form that refuses a
// slipped decimal point and the route that refuses it agree on the number.

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
  if (Math.abs(raw) > MAX_ENTRY_CENTS)
    return fail(
      `${key} is larger than a single entry may be (${MAX_ENTRY_CENTS} cents) — check the decimal point`,
    );
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
      WHERE EXISTS (SELECT 1 FROM lots WHERE lots.id = ?)
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

/**
 * Turn a UNIQUE violation into the answer that is actually true.
 *
 * Three unique indexes guard this table, and they mean three different things.
 * Answering "already posted" for all of them is worse than saying nothing: a
 * board member who reuses a key from a stale tab for a DIFFERENT charge would
 * be told their entry was already recorded when no such entry exists anywhere —
 * reassured, with the money unrecorded. So the index is identified, and a
 * duplicate operation key is only reported as an idempotent retry when the row
 * already there really is the same entry.
 *
 * An unrecognised constraint is re-thrown rather than guessed at.
 */
async function conflictResponse(
  error: unknown,
  intended: {
    lotId: string;
    kind: string;
    amountCents: number;
    operationKey: string;
  } | null,
): Promise<Response> {
  const message = String(error);
  if (!message.includes('UNIQUE')) throw error;

  if (message.includes('reverses_entry_id'))
    return new Response(
      'That entry has already been reversed — an entry is reversed at most once',
      { status: 409 },
    );
  if (message.includes('payment_id'))
    return new Response(
      'That payment has already been credited to the ledger',
      { status: 409 },
    );
  if (!message.includes('operation_key')) throw error;
  if (!intended)
    return new Response(
      'This submission was already posted — nothing was posted twice',
      { status: 409 },
    );

  // Same key, same lot: is what is already there the same entry, or a
  // different one wearing a reused key?
  const existing = await env.DATABASE.prepare(
    `SELECT kind, amount_cents FROM dues_ledger_entries
      WHERE operation_key = ? AND lot_id = ?`,
  )
    .bind(intended.operationKey, intended.lotId)
    .first<{ kind: string; amount_cents: number }>();
  if (
    existing &&
    existing.kind === intended.kind &&
    existing.amount_cents === intended.amountCents
  )
    return new Response(
      'This entry was already posted — nothing was posted twice',
      { status: 409 },
    );
  return new Response(
    'That operation key has already been used on this lot for a different entry — use a new key',
    { status: 409 },
  );
}

/** Run an insert and its event append as one batch, answering uniformly. */
async function post(
  statement: D1PreparedStatement,
  recordId: string,
  accountId: string,
  conflict: string,
  intended: {
    lotId: string;
    kind: string;
    amountCents: number;
    operationKey: string;
  } | null = null,
): Promise<Response> {
  let applied, logged;
  try {
    [applied, logged] = await env.DATABASE.batch([
      statement,
      eventInsert(recordId, accountId),
    ]);
  } catch (error) {
    return conflictResponse(error, intended);
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
    {
      lotId: common.lotId,
      kind: 'charge',
      amountCents: amount.value,
      operationKey: common.operationKey,
    },
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
    {
      lotId: common.lotId,
      kind: 'payment',
      amountCents: -amount.value,
      operationKey: common.operationKey,
    },
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
    {
      lotId: common.lotId,
      kind: 'adjustment',
      amountCents: amount.value,
      operationKey: common.operationKey,
    },
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
 *
 * The amount is derived in SQL, so it is deliberately NOT subject to
 * `MAX_ENTRY_CENTS`: a reversal must match its original exactly, and a
 * provider-sourced entry may one day be larger than the board's typo cap.
 *
 * **Only a board-entered row is reversible here.** A provider-sourced payment
 * is undone by its own `funds_withdrawn` event (ADR 0025), and that path needs
 * the one `reverses_entry_id` slot the UNIQUE index allows — a board reversal
 * would occupy it and leave a real ACH return with nowhere to write its effect.
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
        AND original.source = 'board'
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
    'That entry cannot be reversed — it does not exist, is itself a reversal, came from the payment provider, or lot records are not enabled',
  );
}

/**
 * One assessment posted to every non-retired lot, in one statement, under ONE
 * operation key.
 *
 * The key is shared on purpose: re-submitting the same bulk post writes
 * nothing for the lots that already have it, which is what makes a double
 * click safe on the one action that touches every home at once. It does still
 * reach a lot created since — "every non-retired lot has this assessment" is
 * the state the action asserts, not "this ran once".
 *
 * Row ids come from SQLite rather than from a loop in TypeScript, so this
 * stays one statement: a partially posted assessment would be worse than a
 * failed one. They are `randomblob` hex rather than the `crypto.randomUUID()`
 * every other row here carries — a deliberate difference, since SQL is where
 * they have to be generated.
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

  // ON CONFLICT DO NOTHING rather than letting the UNIQUE raise: re-sending a
  // bulk post must be safe, and a Lot CREATED since the first post should
  // still receive the assessment. Raising would refuse the whole statement and
  // leave that new Lot silently without it, reported as "already posted".
  const [inserted, logged] = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO dues_ledger_entries ${ENTRY_COLUMNS}
       SELECT lower(hex(randomblob(16))), lots.id, 'charge', ?, ?, ?,
              ?, NULL, NULL, 'board', NULL, NULL, ?, ?, ?
         FROM lots
        WHERE lots.retired_at IS NULL
          AND ${LOT_RECORDS_ENABLED_SQL}
       ON CONFLICT (operation_key, lot_id) DO NOTHING`,
    ).bind(
      amount.value,
      effectiveDay,
      description,
      category,
      accountId,
      Date.now(),
      key.value,
    ),
    // One event per entry, in the same batch, matched by the shared key. ADR
    // 0024 asks for an event per create and does not exempt a bulk one: the
    // board's per-entry history would otherwise be populated for hand-entered
    // rows and empty for bulk-posted ones, which a board member reading one
    // Lot's history would read as "nobody recorded this".
    //
    // The `changes() = 1` guard the single-entry path uses does not generalise
    // to N rows, so this selects the entries by their key instead — and it is
    // restricted to rows with no event yet, so a re-post that inserts one new
    // Lot logs that Lot only.
    env.DATABASE.prepare(
      `INSERT INTO lot_record_events
         (id, record_type, record_id, action, acting_account_id, reason_code, recorded_at)
       SELECT lower(hex(randomblob(16))), 'dues_ledger_entries', entry.id,
              'created', ?, NULL, ?
         FROM dues_ledger_entries entry
        WHERE entry.operation_key = ?
          AND NOT EXISTS (
            SELECT 1 FROM lot_record_events existing
            WHERE existing.record_type = 'dues_ledger_entries'
              AND existing.record_id = entry.id
          )`,
    ).bind(accountId, Date.now(), key.value),
  ]);

  const posted = inserted.meta.changes;
  if (posted === 0)
    return new Response(
      'Nothing was posted — this assessment is already on every active lot, or there are no active lots, or lot records are not enabled',
      { status: 409 },
    );
  if (logged.meta.changes !== posted)
    return new Response(
      'The assessment was posted, but its events were not logged — contact an administrator',
      { status: 500 },
    );
  return Response.json({ posted }, { status: 201 });
}

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  if (!(await lotRecordsAvailable(env))) return NOT_FOUND();

  const url = new URL(request.url);
  // Presence, not truthiness: `?events=` with no value must not fall through
  // to the whole ledger.
  if (url.searchParams.has('events')) {
    const recordId = url.searchParams.get('events') ?? '';
    if (!recordId)
      return new Response('events requires an entry id', { status: 400 });
    return Response.json(
      await fetchAdminLotRecordEvents(env, 'dues_ledger_entries', recordId),
    );
  }

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
