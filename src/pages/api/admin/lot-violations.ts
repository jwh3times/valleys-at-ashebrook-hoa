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
  fetchAdminLotRecordEvents,
  fetchAdminLotViolations,
} from '../../../server/lot-records/reads';
import {
  isoDateOrError,
  LOT_RECORD_REASON_CODES,
  LOT_VIOLATION_CATEGORIES,
  type LotRecordReasonCode,
  type LotViolationCategory,
} from '../../../lib/types';

export const prerender = false;

/**
 * BOARD DATA ENTRY FOR LOT RECORDS (ADR 0024, #291 slice 2).
 *
 * Gate order is board-first, which ADR 0024 fixes deliberately:
 * `requireBoard` (write freeze `503`, then `401`, then `403`), and only then
 * the two feature flags (`404`). That keeps the codes identical to the
 * `/api/admin/*` middleware backstop, which answers `401`/`403` before any
 * route runs, and keeps `admin-routes-all-gated.test.ts` — which expects
 * exactly `401` for an anonymous caller with no settings seeded — valid
 * without a special case. Existence is not a secret from anonymous callers on
 * a namespace that already answers `401` uniformly.
 *
 * Every mutation re-checks both flags INSIDE its own statement. A board edit
 * that lands while the flags are being turned off answers `409` and writes
 * nothing, rather than depending on a preflight that was true a round trip
 * ago.
 *
 * Status moves only through the named actions below — there is no `PATCH` that
 * can set it, the same rule resolutions and elections follow. Nothing is ever
 * hard-deleted: a mistaken record is **voided** with a reason, stays visible to
 * the board, and disappears from the Lot's own surface. Every create,
 * transition, void, and correction appends one `lot_record_events` row in the
 * same D1 batch, gated on `changes() = 1` from the statement before it, so a
 * refused mutation logs nothing.
 *
 * The converse — a logged event whose mutation did not land — is prevented by
 * the shape of the statements rather than by the idiom: every mutation here
 * keys on the primary key, so it changes exactly one row or none. An action
 * that ever changes several rows would need a different check than
 * `changes() !== 1`, which would then read a partial apply as a conflict AFTER
 * the batch had committed. ADR 0025's ledger reuses this helper; that is the
 * constraint it inherits.
 */

const NOT_FOUND = () => new Response('Not found', { status: 404 });

/**
 * An optional free-text field: a string, or absent. A non-string is a `400`,
 * never a silent clear — `stringField` reads every non-string as `''`, and for
 * `internalNote` that would DELETE the board's note rather than reject the
 * request. It is the one column ADR 0024 designates as the place prose lives.
 */
function optionalTextOrError(
  body: unknown,
  key: string,
): { ok: true; value: string | null } | { ok: false; res: Response } {
  const raw = (body as Record<string, unknown>)[key];
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string')
    return {
      ok: false,
      res: new Response(`${key} must be text`, { status: 400 }),
    };
  return { ok: true, value: raw.trim() || null };
}

/**
 * A transition's optional reason. Bounded to `LOT_RECORD_REASON_CODES`
 * (migration `0035`) rather than free text, so the log cannot accumulate
 * resident-identifying prose in a column Roster Redaction does not cover.
 */
function reasonOrError(
  body: unknown,
  required: boolean,
):
  | { ok: true; value: LotRecordReasonCode | null }
  | { ok: false; res: Response } {
  const raw = stringField(body, 'reason');
  if (!raw) {
    if (!required) return { ok: true, value: null };
    return {
      ok: false,
      res: new Response(
        `reason is required — one of: ${LOT_RECORD_REASON_CODES.join(', ')}`,
        { status: 400 },
      ),
    };
  }
  if (!(LOT_RECORD_REASON_CODES as readonly string[]).includes(raw))
    return {
      ok: false,
      res: new Response(
        `Unknown reason — expected one of: ${LOT_RECORD_REASON_CODES.join(', ')}`,
        { status: 400 },
      ),
    };
  return { ok: true, value: raw as LotRecordReasonCode };
}

/** The `lot_record_events` insert that rides every mutation's batch. */
function eventInsert(
  recordId: string,
  action: string,
  actingAccountId: string,
  reasonCode: string | null,
) {
  return env.DATABASE.prepare(
    `INSERT INTO lot_record_events
       (id, record_type, record_id, action, acting_account_id, reason_code, recorded_at)
     SELECT ?, 'lot_violations', ?, ?, ?, ?, ?
      WHERE changes() = 1`,
  ).bind(
    crypto.randomUUID(),
    recordId,
    action,
    actingAccountId,
    reasonCode,
    Date.now(),
  );
}

/**
 * Run one mutation plus its event append as a single D1 batch.
 *
 * D1 executes a batch as one transaction and `changes()` inside statement two
 * reads statement one's row count, which is what lets the event insert be
 * gated on the mutation having actually applied — the same guarded-insert
 * idiom `setSiteGate` and `openElection` use.
 */
async function withEvent(
  mutation: D1PreparedStatement,
  recordId: string,
  action: string,
  actingAccountId: string,
  reasonCode: string | null,
  conflict: string,
): Promise<Response> {
  const [applied, logged] = await env.DATABASE.batch([
    mutation,
    eventInsert(recordId, action, actingAccountId, reasonCode),
  ]);
  if (applied.meta.changes !== 1)
    return new Response(conflict, { status: 409 });
  if (logged.meta.changes !== 1)
    return new Response(
      'The record changed, but its event was not logged — contact an administrator',
      { status: 500 },
    );
  return new Response(null, { status: 204 });
}

async function create(body: unknown, accountId: string): Promise<Response> {
  const lotId = stringField(body, 'lotId');
  if (!lotId) return new Response('lotId is required', { status: 400 });

  const category = stringField(body, 'category');
  if (!(LOT_VIOLATION_CATEGORIES as readonly string[]).includes(category))
    return new Response(
      `category must be one of: ${LOT_VIOLATION_CATEGORIES.join(', ')}`,
      { status: 400 },
    );

  const effectiveDay = stringField(body, 'effectiveDay');
  if (!effectiveDay)
    return new Response('effectiveDay is required', { status: 400 });
  const dayCheck = isoDateOrError(effectiveDay, 'effectiveDay');
  if (!dayCheck.ok) return new Response(dayCheck.error, { status: 400 });

  const summary = stringField(body, 'summary');
  if (!summary) return new Response('summary is required', { status: 400 });
  const note = optionalTextOrError(body, 'internalNote');
  if (!note.ok) return note.res;
  // A reason is optional on a create and is recorded when given, rather than
  // accepted and dropped: a panel that sends one would otherwise look like it
  // worked.
  const reason = reasonOrError(body, false);
  if (!reason.ok) return reason.res;

  const id = crypto.randomUUID();
  // The lot is checked inside the INSERT rather than by a preflight SELECT:
  // the foreign key would refuse a missing lot anyway, but as a raw D1 error
  // rather than a readable status. `EXISTS` here turns both that case and a
  // flags race into the same handled 409.
  const insert = env.DATABASE.prepare(
    `INSERT INTO lot_violations
       (id, lot_id, category, effective_day, summary, internal_note, status, created_by, created_at)
     SELECT ?, ?, ?, ?, ?, ?, 'open', ?, ?
      WHERE EXISTS (SELECT 1 FROM lots WHERE lots.id = ?)
        AND ${LOT_RECORDS_ENABLED_SQL}`,
  ).bind(
    id,
    lotId,
    category as LotViolationCategory,
    effectiveDay,
    summary,
    note.value,
    accountId,
    Date.now(),
    lotId,
  );

  const [inserted, logged] = await env.DATABASE.batch([
    insert,
    eventInsert(id, 'created', accountId, reason.value),
  ]);
  if (inserted.meta.changes !== 1)
    return new Response('Lot not found, or lot records are not enabled', {
      status: 409,
    });
  if (logged.meta.changes !== 1)
    return new Response(
      'The record was created, but its event was not logged — contact an administrator',
      { status: 500 },
    );
  return Response.json({ id }, { status: 201 });
}

/**
 * The named status transitions. Each names the statuses it may move FROM, so
 * the legal moves are stated once, in one place, and an illegal one is a `409`
 * from the `UPDATE`'s own `WHERE` rather than a check that can go stale.
 *
 * `voided` appears in no `from` list: a voided record is terminal. Correcting
 * one means recording a new violation, not resurrecting the mistake.
 */
const TRANSITIONS = {
  cure: { to: 'cured', from: ['open'], action: 'cured' },
  close: { to: 'closed', from: ['open', 'cured'], action: 'closed' },
  reopen: { to: 'open', from: ['cured', 'closed'], action: 'reopened' },
  void: { to: 'voided', from: ['open', 'cured', 'closed'], action: 'voided' },
} as const;

type TransitionName = keyof typeof TRANSITIONS;

async function transition(
  name: TransitionName,
  body: unknown,
  accountId: string,
): Promise<Response> {
  const id = stringField(body, 'id');
  if (!id) return new Response('id is required', { status: 400 });

  // A void is the correction path and always records WHY. The other three are
  // ordinary lifecycle moves, where a reason is welcome but not demanded.
  const reason = reasonOrError(body, name === 'void');
  if (!reason.ok) return reason.res;

  const spec = TRANSITIONS[name];
  const fromList = spec.from.map(() => '?').join(', ');
  const update = env.DATABASE.prepare(
    `UPDATE lot_violations
        SET status = ?
      WHERE id = ?
        AND status IN (${fromList})
        AND ${LOT_RECORDS_ENABLED_SQL}`,
  ).bind(spec.to, id, ...spec.from);

  return withEvent(
    update,
    id,
    spec.action,
    accountId,
    reason.value,
    `Cannot ${name} this record — it does not exist, is not in a state this action applies to, or lot records are not enabled`,
  );
}

/**
 * A correction to the descriptive fields of a record that stands.
 *
 * Status is not here and never will be: it moves through the named
 * transitions, which is what lets the event log describe the lifecycle. A
 * voided record is not editable either — it is preserved as it was.
 */
async function edit(body: unknown, accountId: string): Promise<Response> {
  const id = stringField(body, 'id');
  if (!id) return new Response('id is required', { status: 400 });

  const sets: string[] = [];
  const binds: unknown[] = [];

  if ('category' in (body as Record<string, unknown>)) {
    const category = stringField(body, 'category');
    if (!(LOT_VIOLATION_CATEGORIES as readonly string[]).includes(category))
      return new Response(
        `category must be one of: ${LOT_VIOLATION_CATEGORIES.join(', ')}`,
        { status: 400 },
      );
    sets.push('category = ?');
    binds.push(category);
  }

  if ('effectiveDay' in (body as Record<string, unknown>)) {
    const effectiveDay = stringField(body, 'effectiveDay');
    const dayCheck = isoDateOrError(effectiveDay, 'effectiveDay');
    if (!dayCheck.ok) return new Response(dayCheck.error, { status: 400 });
    sets.push('effective_day = ?');
    binds.push(effectiveDay);
  }

  if ('summary' in (body as Record<string, unknown>)) {
    const summary = stringField(body, 'summary');
    if (!summary)
      return new Response('summary cannot be blank', { status: 400 });
    sets.push('summary = ?');
    binds.push(summary);
  }

  // An explicit null or a blank string clears the board-only note; omitting the
  // key leaves it; a non-string is refused rather than clearing it.
  if ('internalNote' in (body as Record<string, unknown>)) {
    const note = optionalTextOrError(body, 'internalNote');
    if (!note.ok) return note.res;
    sets.push('internal_note = ?');
    binds.push(note.value);
  }

  if (sets.length === 0)
    return new Response('No fields to update', { status: 400 });

  const reason = reasonOrError(body, false);
  if (!reason.ok) return reason.res;

  const update = env.DATABASE.prepare(
    `UPDATE lot_violations
        SET ${sets.join(', ')}
      WHERE id = ?
        AND status <> 'voided'
        AND ${LOT_RECORDS_ENABLED_SQL}`,
  ).bind(...binds, id);

  return withEvent(
    update,
    id,
    'edited',
    accountId,
    reason.value,
    'Cannot edit this record — it does not exist, is voided, or lot records are not enabled',
  );
}

/**
 * Board reads: every violation for one Lot or for the association, including
 * voided rows and board-only notes, plus one record's event log.
 *
 * These are the unscoped `fetchAdminLot*` reads, so this `requireBoard` gate is
 * the only thing standing between them and the whole association's enforcement
 * history. The flags gate them too, because a board surface that accumulates
 * real Lot-level data on a site still disclaiming it is the HOA is exactly what
 * ADR 0024's second flag exists to prevent.
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  if (!(await lotRecordsAvailable(env))) return NOT_FOUND();

  // Built from `request.url` rather than taken from the context, as
  // `meetings.ts` and `reports.ts` do: the context's `url` is Astro's, and a
  // handler that depends on it cannot be invoked directly the way the Workers
  // pool and `permission-matrix.test.ts` invoke every route.
  const url = new URL(request.url);
  // Presence, not truthiness: `?events=` with no value used to be falsy here
  // and fall through to the full violation list, which is a surprising answer
  // to a request that plainly asked for one record's log.
  if (url.searchParams.has('events')) {
    const recordId = url.searchParams.get('events') ?? '';
    if (!recordId)
      return new Response('events requires a record id', { status: 400 });
    return Response.json(
      await fetchAdminLotRecordEvents(env, 'lot_violations', recordId),
    );
  }

  const lotId = url.searchParams.get('lotId') ?? undefined;
  return Response.json(await fetchAdminLotViolations(env, lotId));
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  if (!(await lotRecordsAvailable(env))) return NOT_FOUND();

  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });

  const action = stringField(parsed.value, 'action');
  if (action === 'create') return create(parsed.value, ctx.userId);
  if (action in TRANSITIONS)
    return transition(action as TransitionName, parsed.value, ctx.userId);
  if (action === 'edit') return edit(parsed.value, ctx.userId);
  return new Response(
    `Unknown action — expected one of: create, ${Object.keys(TRANSITIONS).join(', ')}, edit`,
    { status: 400 },
  );
};
