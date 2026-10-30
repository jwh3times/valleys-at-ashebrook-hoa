import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requireMemberApi } from '../../../server/authz/member-guards';
import { readJson, stringField } from '../../../server/http';
import { associationDateIso } from '../../../lib/format';
import { isoDateOrError } from '../../../lib/types';
import {
  lotAuthorityBasis,
  lotAuthorityExists,
} from '../../../server/roster/authority';
import { normalizedContactValue } from '../../../server/roster/builders';
import { fetchMemberTenancies } from '../../../server/roster/reads';
import {
  inviteTenant,
  reinviteResponse,
} from '../../../server/roster/tenancy-invitation';
import {
  AuditCorrelation,
  OPERATOR_OBSERVATION,
  operationKey,
  updatedRowGuard,
} from '../../../server/roster/audit';
import {
  CLEAR_REQUEST_CONTACT_SQL,
  TENANCY_MAX_MONTHS,
  TENANT_ACCESS_ENABLED_SQL,
  basisCurrentSql,
  latestTenancyEndDay,
  tenantAccessAvailable,
  tenancyCurrentSql,
} from '../../../server/roster/tenancy';

// An owner's half of Tenant Access (ADR 0028, #294 slice 3; spec decision 3).
// Any current holder of Lot Authority over a Lot may request a Tenancy for it,
// renew or end one, and withdraw an open request, whoever made it.
//
// A request is not a roster fact: this route writes `tenancy_requests`, and
// the board's approval records the Tenancy. Every action re-checks the
// caller's Lot Authority inside its own statement. Anything outside the
// caller's Lots answers the same masked 404 as a row that does not exist.
//
// The actions that grant something (request, renew, reinvite) answer 404 while either
// gate is off and re-check both inside their statement, so a race answers
// 409. Withdraw and end, like the board's refuse, end and void, stay live with
// `tenantAccessEnabled` off: ending access must not wait on a setting, and a
// pending request's name and contact can always be cleared (review decision,
// 2026-10-25). So does the list, which the page needs to offer them. With
// `officialMode` off the whole member API is the 404 (`requireMemberApi`, ADR
// 0019), and the board's actions are what remain.

export const prerender = false;

const NOT_FOUND = () => new Response('Not found', { status: 404 });
const TENANT_NAME_MAX = 200;
/** Open requests for a new tenant one Lot may hold at once. Each names a
 * different contact; a renewal is one per Tenancy and does not count. */
const OPEN_REQUESTS_MAX = 10;

/** Fewer than `OPEN_REQUESTS_MAX` open new-tenant requests on the Lot bound
 * here. */
const OPEN_REQUESTS_BELOW_MAX_SQL = `(SELECT COUNT(*) FROM tenancy_requests
  WHERE lot_id = ? AND status = 'open' AND kind = 'new') < ${OPEN_REQUESTS_MAX}`;

/** Who is acting, resolved once per request. */
interface Caller {
  accountId: string;
  personId: string;
  /** The Association Day. */
  today: string;
}

/** The requested end day: a real day after `startDay` and at most 13 months
 * past it. */
function endDayOrError(
  body: unknown,
  startDay: string,
): { ok: true; value: string } | { ok: false; res: Response } {
  const parsed = isoDateOrError(
    stringField(body, 'scheduledEndDay'),
    'scheduledEndDay',
  );
  if (!parsed.ok)
    return { ok: false, res: new Response(parsed.error, { status: 400 }) };
  if (parsed.value <= startDay)
    return {
      ok: false,
      res: new Response('The end day must be after the start', {
        status: 400,
      }),
    };
  if (parsed.value > latestTenancyEndDay(startDay))
    return {
      ok: false,
      res: new Response(
        `The end day may be at most ${TENANCY_MAX_MONTHS} months out`,
        { status: 400 },
      ),
    };
  return { ok: true, value: parsed.value };
}

function isUniqueViolation(err: unknown): boolean {
  return /UNIQUE constraint failed: tenancy_requests\./.test(String(err));
}

/** Binds the Association Day once, as `d.today`, for a currency rule that
 * repeats it. Join it in the FROM clause; its `?` binds in that position. */
const TODAY_SOURCE = '(SELECT ? AS today) d';

async function requestTenancy(
  body: unknown,
  { accountId, personId, today }: Caller,
): Promise<Response> {
  const lotId = stringField(body, 'lotId');
  if (!lotId) return new Response('lotId is required', { status: 400 });

  const tenantName = stringField(body, 'tenantName');
  if (!tenantName)
    return new Response('tenantName is required', { status: 400 });
  if (tenantName.length > TENANT_NAME_MAX)
    return new Response(
      `tenantName must be ${TENANT_NAME_MAX} characters or fewer`,
      { status: 400 },
    );
  const channel = stringField(body, 'channel');
  if (channel !== 'email' && channel !== 'sms')
    return new Response("channel must be 'email' or 'sms'", { status: 400 });
  const contact = stringField(body, 'contact');
  const normalized = normalizedContactValue(channel, contact);
  if (!normalized.ok) return new Response(normalized.error, { status: 400 });
  const endDay = endDayOrError(body, today);
  if (!endDay.ok) return endDay.res;

  // No basis means no Lot Authority over this Lot: the masked 404, the same
  // answer as a Lot that does not exist.
  const basis = await lotAuthorityBasis(env.DATABASE, personId, lotId, today);
  if (!basis) return NOT_FOUND();

  // Checked after scope, so the count never answers for a Lot outside it.
  const belowMax = await env.DATABASE.prepare(
    `SELECT ${OPEN_REQUESTS_BELOW_MAX_SQL} AS ok`,
  )
    .bind(lotId)
    .first<{ ok: number }>();
  if (belowMax?.ok !== 1)
    return new Response(
      `This Lot already has ${OPEN_REQUESTS_MAX} open requests for a new tenant; withdraw one first`,
      { status: 409 },
    );

  const authority = lotAuthorityExists(
    { value: personId },
    { value: lotId },
    today,
  );
  const id = crypto.randomUUID();
  try {
    const [result] = await env.DATABASE.batch([
      env.DATABASE.prepare(
        `INSERT INTO tenancy_requests (id, lot_id, requested_by_account_id,
         requested_by_person_id, basis_ownership_id, kind, tenant_name, channel,
         contact_value, contact_normalized, scheduled_end_day, created_at)
       SELECT ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?
       FROM ${TODAY_SOURCE}
       WHERE ${TENANT_ACCESS_ENABLED_SQL} AND ${authority.sql}
         AND ${basisCurrentSql('?', '?', 'd.today')}
         AND ${OPEN_REQUESTS_BELOW_MAX_SQL}`,
      ).bind(
        id,
        lotId,
        accountId,
        personId,
        basis,
        tenantName,
        channel,
        contact,
        normalized.value,
        endDay.value,
        Date.now(),
        today,
        ...authority.binds,
        basis,
        lotId,
        lotId,
      ),
    ]);
    // The preflight found Lot Authority, its basis, the gates and room under
    // the cap; losing any since is a race. A retired Lot keeps Lot Authority
    // but is no basis.
    if (result.meta.changes !== 1)
      return new Response('This Lot can no longer take a request', {
        status: 409,
      });
  } catch (err) {
    if (isUniqueViolation(err))
      return new Response(
        'There is already an open request for this contact on this Lot',
        { status: 409 },
      );
    throw err;
  }
  return Response.json({ id }, { status: 201 });
}

/** A Tenancy that is current on `d.today` and has no end recorded: the only
 * kind an owner may renew. */
function renewableSql(t: string): string {
  return `${t}.actual_end_day IS NULL AND ${tenancyCurrentSql(t, 'd.today')}`;
}

/** The Tenancy, if the caller holds Lot Authority over its Lot today, with
 * whether it is unended and unvoided, and whether it is also current; null is
 * the masked 404. */
async function tenancyInScope(
  tenancyId: string,
  personId: string,
  today: string,
): Promise<{
  lotId: string;
  scheduledEndDay: string;
  tenantPersonId: string;
  unended: boolean;
  renewable: boolean;
  basis: string;
} | null> {
  const row = await env.DATABASE.prepare(
    `SELECT t.lot_id, t.scheduled_end_day, t.tenant_person_id,
            (t.voided_at IS NULL AND t.actual_end_day IS NULL) AS unended,
            (${renewableSql('t')}) AS renewable
     FROM tenancies t, ${TODAY_SOURCE} WHERE t.id = ?`,
  )
    .bind(today, tenancyId)
    .first<{
      lot_id: string;
      scheduled_end_day: string;
      tenant_person_id: string;
      unended: number;
      renewable: number;
    }>();
  if (!row) return null;
  const basis = await lotAuthorityBasis(
    env.DATABASE,
    personId,
    row.lot_id,
    today,
  );
  if (!basis) return null;
  return {
    lotId: row.lot_id,
    scheduledEndDay: row.scheduled_end_day,
    tenantPersonId: row.tenant_person_id,
    unended: row.unended === 1,
    renewable: row.renewable === 1,
    basis,
  };
}

/** Opens a renewal of a current Tenancy. The renewal starts where the renewed
 * Tenancy is scheduled to end, so the end day is measured from there. */
async function renewTenancy(
  body: unknown,
  { accountId, personId, today }: Caller,
): Promise<Response> {
  const tenancyId = stringField(body, 'tenancyId');
  if (!tenancyId) return new Response('tenancyId is required', { status: 400 });
  const tenancy = await tenancyInScope(tenancyId, personId, today);
  if (!tenancy) return NOT_FOUND();
  if (!tenancy.renewable)
    return new Response('Only a current Tenancy can be renewed', {
      status: 409,
    });
  const endDay = endDayOrError(body, tenancy.scheduledEndDay);
  if (!endDay.ok) return endDay.res;

  const authority = lotAuthorityExists(
    { value: personId },
    { column: 't.lot_id' },
    today,
  );
  const id = crypto.randomUUID();
  try {
    const [result] = await env.DATABASE.batch([
      env.DATABASE.prepare(
        `INSERT INTO tenancy_requests (id, lot_id, requested_by_account_id,
           requested_by_person_id, basis_ownership_id, kind, renews_tenancy_id,
           scheduled_end_day, created_at)
         SELECT ?, t.lot_id, ?, ?, ?, 'renewal', t.id, ?, ?
         FROM tenancies t, ${TODAY_SOURCE}
         WHERE t.id = ? AND ${renewableSql('t')}
           AND ${TENANT_ACCESS_ENABLED_SQL} AND ${authority.sql}
           AND ${basisCurrentSql('?', 't.lot_id', 'd.today')}`,
      ).bind(
        id,
        accountId,
        personId,
        tenancy.basis,
        endDay.value,
        Date.now(),
        today,
        tenancyId,
        ...authority.binds,
        tenancy.basis,
      ),
    ]);
    if (result.meta.changes !== 1)
      return new Response('This Tenancy can no longer be renewed', {
        status: 409,
      });
  } catch (err) {
    if (isUniqueViolation(err))
      return new Response('This Tenancy already has an open renewal', {
        status: 409,
      });
    throw err;
  }
  return Response.json({ id }, { status: 201 });
}

/** Withdraws an open request for a Lot the caller holds, whoever made it
 * (spec review decision 4). One statement: scope, open status and existence
 * are all in the WHERE, so "not yours", "already decided" and "no such
 * request" are the same masked 404. The name and contact leave with it. */
async function withdrawRequest(
  body: unknown,
  { accountId, personId, today }: Caller,
): Promise<Response> {
  const requestId = stringField(body, 'requestId');
  if (!requestId) return new Response('requestId is required', { status: 400 });
  const authority = lotAuthorityExists(
    { value: personId },
    { column: 'tenancy_requests.lot_id' },
    today,
  );
  const result = await env.DATABASE.prepare(
    `UPDATE tenancy_requests
     SET status = 'withdrawn', decided_at = ?, decided_by_account_id = ?,
         ${CLEAR_REQUEST_CONTACT_SQL}
     WHERE id = ? AND status = 'open' AND ${authority.sql}`,
  )
    .bind(Date.now(), accountId, requestId, ...authority.binds)
    .run();
  if (result.meta.changes !== 1) return NOT_FOUND();
  return new Response(null, { status: 204 });
}

const ALREADY_ENDED = () =>
  new Response('Tenancy already ended or voided', { status: 409 });

/**
 * Ends a Tenancy of the caller's Lot today, with `owner_ended`. One that has
 * not begun ends on its start day, so it never runs.
 *
 * The one Roster Change a non-board Account may make (spec decision 8): the
 * owner's Account is the actor. It never checks the gates: ending access must
 * not wait on a setting.
 */
async function endTenancy(
  body: unknown,
  { accountId, personId, today }: Caller,
): Promise<Response> {
  const tenancyId = stringField(body, 'tenancyId');
  if (!tenancyId) return new Response('tenancyId is required', { status: 400 });
  const tenancy = await tenancyInScope(tenancyId, personId, today);
  if (!tenancy) return NOT_FOUND();
  if (!tenancy.unended) return ALREADY_ENDED();
  // Unended but past its end day: it has lapsed, with nothing left to end.
  // The board's route answers this case in the same words.
  if (tenancy.scheduledEndDay <= today)
    return new Response('Tenancy has already reached its end day', {
      status: 409,
    });

  // The UPDATE re-checks the Tenancy's state, so one the board ends or voids
  // first answers the ended 409.
  const authority = lotAuthorityExists(
    { value: personId },
    { column: 'tenancies.lot_id' },
    today,
  );
  const nowMs = Date.now();
  const primary = env.DATABASE.prepare(
    `UPDATE tenancies
     SET actual_end_day = MAX(start_day, ?), end_reason = 'owner_ended',
         ended_by_account_id = ?, updated_at = ?
     WHERE id = ? AND voided_at IS NULL AND actual_end_day IS NULL
       AND MAX(start_day, ?) < scheduled_end_day
       AND ${authority.sql}`,
  ).bind(today, accountId, nowMs, tenancyId, today, ...authority.binds);
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('member-tenancies', 'end'),
    actorAccountId: accountId,
    nowMs,
  });
  correlation.event({
    kind: 'tenancy_ended',
    guard: updatedRowGuard('tenancies', tenancyId, nowMs),
    detail: {
      family: 'roster_change',
      effective: { day: today },
      reason: 'owner_ended',
      evidence: OPERATOR_OBSERVATION,
      subjects: [
        { column: 'tenancy_id', id: tenancyId, role: 'ended' },
        { column: 'lot_id', id: tenancy.lotId, role: 'related' },
        { column: 'party_id', id: tenancy.tenantPersonId, role: 'related' },
      ],
    },
  });
  const [result] = await env.DATABASE.batch([
    primary,
    ...correlation.statements,
  ]);
  if (result.meta.changes !== 1) return ALREADY_ENDED();
  return new Response(null, { status: 204 });
}

/** Sends a fresh invitation for an approved Tenancy of the caller's Lot whose
 * tenant has not claimed (spec review decision 2), to the contact the board
 * approved. The insert re-checks the caller's Lot Authority with the rest. */
async function reinvite(
  body: unknown,
  { personId, today }: Caller,
): Promise<Response> {
  const tenancyId = stringField(body, 'tenancyId');
  if (!tenancyId) return new Response('tenancyId is required', { status: 400 });
  if (!(await tenancyInScope(tenancyId, personId, today))) return NOT_FOUND();
  return reinviteResponse(
    await inviteTenant(env, {
      tenancyId,
      today,
      scope: lotAuthorityExists(
        { value: personId },
        { column: 't.lot_id' },
        today,
      ),
    }),
  );
}

/** Each action, and whether it grants something and so needs both gates. */
const ACTIONS: Record<
  string,
  { gated: boolean; run: (body: unknown, caller: Caller) => Promise<Response> }
> = {
  request: { gated: true, run: requestTenancy },
  renew: { gated: true, run: renewTenancy },
  withdraw: { gated: false, run: withdrawRequest },
  end: { gated: false, run: endTenancy },
  reinvite: { gated: true, run: reinvite },
};

const FORBIDDEN = () => new Response('Forbidden', { status: 403 });

export const GET: APIRoute = async ({ request, locals }) => {
  const gate = await requireMemberApi(locals, request, env);
  if (!gate.ok) return gate.res;
  if (!gate.ctx.personId) return FORBIDDEN();
  return Response.json(
    await fetchMemberTenancies(env, gate.ctx.lotIds, associationDateIso()),
    { headers: { 'cache-control': 'no-store' } },
  );
};

/** `requireMemberApi` (which needs `officialMode`), then both gates for a
 * gated action (404), then a Person (403). */
export const POST: APIRoute = async ({ request, locals }) => {
  const gate = await requireMemberApi(locals, request, env);
  if (!gate.ok) return gate.res;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const name = stringField(parsed.value, 'action');
  const action = Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : undefined;
  if (!action) return new Response('Unknown action', { status: 400 });
  if (action.gated && !(await tenantAccessAvailable(env))) return NOT_FOUND();
  if (!gate.ctx.personId) return FORBIDDEN();
  return action.run(parsed.value, {
    accountId: gate.ctx.userId,
    personId: gate.ctx.personId,
    today: associationDateIso(),
  });
};
