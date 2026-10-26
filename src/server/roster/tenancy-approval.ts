// The board's approval of an owner's Tenancy request (ADR 0028, #294 slice 3;
// spec decision 3).
//
// Approval is one batch. It records the tenant Person and Contact Method when
// the request needs them, then the Tenancy, then marks the request approved,
// and each write re-checks every approval condition inside its own statement.
// One list of named checks builds both that in-batch gate and the diagnosis
// that names which one failed, so the 409 the panel shows and the condition
// the batch enforced cannot drift apart.

import { boardAccessSql } from '../authz/derive';
import { AuditCorrelation, insertedRowGuard, operationKey } from './audit';
import type { Evidence, SqlGuard } from './audit';
import { lotAuthorityExists } from './authority';
import { recordContactMethod, recordPerson } from './builders';
import {
  CLEAR_REQUEST_CONTACT_SQL,
  TENANCY_MAX_MONTHS,
  TENANT_ACCESS_ENABLED_SQL,
  basisCurrentSql,
} from './tenancy';

/** Why an approval was refused; the Tenants panel shows each. */
export type ApprovalRefusal =
  | 'already-decided'
  | 'gates-off'
  | 'not-board'
  | 'basis-ended'
  | 'requester-lost-authority'
  | 'renewed-ended'
  | 'end-day-passed'
  | 'end-day-too-far'
  | 'person-consolidated'
  | 'overlap';

export const APPROVAL_REFUSAL_MESSAGES: Record<ApprovalRefusal, string> = {
  'already-decided': 'This request has already been decided.',
  'gates-off': 'Tenant access is switched off.',
  'not-board': 'You no longer have board access.',
  'basis-ended':
    'The Ownership this request rests on has ended, or its Lot was retired. Refuse it; the owner can submit a new one.',
  'requester-lost-authority':
    'The owner who made this request no longer holds the Lot. Refuse it; a current owner can submit a new one.',
  'renewed-ended': 'The Tenancy this request renews has been ended or voided.',
  'end-day-passed':
    'The requested end day has passed. Refuse it; the owner can submit a new one.',
  'end-day-too-far': `The requested end day is more than ${TENANCY_MAX_MONTHS} months after the start.`,
  'person-consolidated':
    'That Person was consolidated into another. Name the surviving record instead.',
  overlap: 'That Person already rents this Lot for an overlapping period.',
};

interface Check {
  reason: ApprovalRefusal;
  sql: string;
  binds: unknown[];
}

interface CheckInput {
  requestId: string;
  actorAccountId: string;
  today: string;
  startDay: string;
  /** The named or renewed tenant; null when approval creates the Person. */
  tenantPersonId: string | null;
  /** Whether the board named an existing Person for a `new` request. */
  namedPerson: boolean;
}

/** Every approval condition, each a predicate over the request row `r`, in
 * the order a refusal names them. */
function approvalChecks(input: CheckInput): Check[] {
  const board = boardAccessSql(input.actorAccountId, input.today);
  const authority = lotAuthorityExists(
    { column: 'r.requested_by_person_id' },
    { column: 'r.lot_id' },
    input.today,
  );
  const checks: Check[] = [
    { reason: 'already-decided', sql: `r.status = 'open'`, binds: [] },
    { reason: 'gates-off', sql: TENANT_ACCESS_ENABLED_SQL, binds: [] },
    { reason: 'not-board', sql: board.sql, binds: board.binds },
    {
      reason: 'basis-ended',
      sql: basisCurrentSql('r.basis_ownership_id', 'r.lot_id', '?'),
      binds: [input.today, input.today],
    },
    {
      reason: 'requester-lost-authority',
      sql: authority.sql,
      binds: authority.binds,
    },
    {
      reason: 'renewed-ended',
      sql: `(r.kind = 'new' OR EXISTS (
        SELECT 1 FROM tenancies rt
        WHERE rt.id = r.renews_tenancy_id
          AND rt.voided_at IS NULL AND rt.actual_end_day IS NULL
      ))`,
      binds: [],
    },
    {
      reason: 'end-day-passed',
      sql: `r.scheduled_end_day > ?`,
      binds: [input.startDay],
    },
    {
      reason: 'end-day-too-far',
      sql: `r.scheduled_end_day <= date(?, '+${TENANCY_MAX_MONTHS} months')`,
      binds: [input.startDay],
    },
  ];
  if (input.namedPerson)
    checks.push({
      reason: 'person-consolidated',
      sql: `EXISTS (
        SELECT 1 FROM parties
        WHERE id = ? AND kind = 'person' AND consolidated_into_party_id IS NULL
      )`,
      binds: [input.tenantPersonId],
    });
  if (input.tenantPersonId !== null)
    checks.push({
      reason: 'overlap',
      sql: `NOT EXISTS (
        SELECT 1 FROM tenancies o
        WHERE o.tenant_person_id = ? AND o.lot_id = r.lot_id
          AND o.voided_at IS NULL
          AND o.start_day < r.scheduled_end_day
          AND ? < COALESCE(o.actual_end_day, o.scheduled_end_day)
      )`,
      binds: [input.tenantPersonId, input.startDay],
    });
  return checks;
}

/** All of the checks, as a guard any statement in the batch can carry. */
function approvalGuard(requestId: string, checks: Check[]): SqlGuard {
  return {
    sql: `EXISTS (SELECT 1 FROM tenancy_requests r WHERE r.id = ?
      AND ${checks.map((c) => `(${c.sql})`).join(' AND ')})`,
    binds: [requestId, ...checks.flatMap((c) => c.binds)],
  };
}

/** The first check that fails today, or null when approval may proceed. */
async function firstFailure(
  database: D1Database,
  requestId: string,
  checks: Check[],
): Promise<ApprovalRefusal | null> {
  const row = await database
    .prepare(
      `SELECT CASE
         ${checks.map((c) => `WHEN NOT (${c.sql}) THEN '${c.reason}'`).join('\n         ')}
         ELSE NULL END AS reason
       FROM tenancy_requests r WHERE r.id = ?`,
    )
    .bind(...checks.flatMap((c) => c.binds), requestId)
    .first<{ reason: ApprovalRefusal | null }>();
  // A request that has vanished cannot be approved either.
  if (!row) return 'already-decided';
  return row.reason;
}

export interface ApproveInput {
  database: D1Database;
  requestId: string;
  /** For a `new` request: an existing Person to record as the tenant. */
  personId: string | null;
  actorAccountId: string;
  today: string;
}

export type ApproveResult =
  | { ok: true; tenancyId: string; personId: string }
  | { ok: false; status: 400 | 404; message: string }
  | { ok: false; status: 409; reason: ApprovalRefusal };

interface RequestRow {
  id: string;
  lot_id: string;
  basis_ownership_id: string;
  kind: 'new' | 'renewal';
  renews_tenancy_id: string | null;
  tenant_name: string | null;
  channel: 'email' | 'sms' | null;
  contact_value: string | null;
  contact_normalized: string | null;
  scheduled_end_day: string;
  renewed_person_id: string | null;
  renewed_end_day: string | null;
}

export async function approveTenancyRequest(
  input: ApproveInput,
): Promise<ApproveResult> {
  const { database, requestId, today } = input;
  const request = await database
    .prepare(
      `SELECT r.id, r.lot_id, r.basis_ownership_id, r.kind, r.renews_tenancy_id,
              r.tenant_name, r.channel, r.contact_value, r.contact_normalized,
              r.scheduled_end_day, rt.tenant_person_id AS renewed_person_id,
              rt.scheduled_end_day AS renewed_end_day
       FROM tenancy_requests r
       LEFT JOIN tenancies rt ON rt.id = r.renews_tenancy_id
       WHERE r.id = ?`,
    )
    .bind(requestId)
    .first<RequestRow>();
  if (!request) return { ok: false, status: 404, message: 'Request not found' };

  if (request.kind === 'renewal' && input.personId !== null)
    return {
      ok: false,
      status: 400,
      message: 'A renewal keeps its tenant; do not name a Person',
    };
  if (input.personId !== null) {
    const exists = await database
      .prepare(`SELECT 1 FROM people WHERE party_id = ?`)
      .bind(input.personId)
      .first();
    if (!exists) return { ok: false, status: 404, message: 'Person not found' };
  }

  // A renewal starts where the renewed Tenancy is scheduled to end, so the two
  // are adjacent; if that day has passed, it starts today.
  const startDay =
    request.kind === 'renewal' && request.renewed_end_day !== null
      ? request.renewed_end_day > today
        ? request.renewed_end_day
        : today
      : today;
  const createPerson = request.kind === 'new' && input.personId === null;
  const tenantPersonId =
    request.kind === 'renewal'
      ? request.renewed_person_id
      : (input.personId ?? crypto.randomUUID());

  const checks = approvalChecks({
    requestId,
    actorAccountId: input.actorAccountId,
    today,
    startDay,
    tenantPersonId: createPerson ? null : tenantPersonId,
    namedPerson: input.personId !== null,
  });
  const failure = await firstFailure(database, requestId, checks);
  if (failure) return { ok: false, status: 409, reason: failure };
  if (tenantPersonId === null)
    return { ok: false, status: 409, reason: 'renewed-ended' };

  // A named Person gets the requested contact only if they lack it.
  let addContact = createPerson;
  if (request.kind === 'new' && !createPerson) {
    const held = await database
      .prepare(
        `SELECT 1 FROM contact_methods
         WHERE party_id = ? AND channel = ? AND value_normalized = ?
           AND end_day IS NULL AND voided_at IS NULL`,
      )
      .bind(tenantPersonId, request.channel, request.contact_normalized)
      .first();
    addContact = !held;
  }

  const gate = approvalGuard(requestId, checks);
  const nowMs = Date.now();
  const evidence: Evidence = { kind: 'request', requestId };
  const correlation = new AuditCorrelation(database, {
    operationKey: operationKey('tenancies', 'approve'),
    actorAccountId: input.actorAccountId,
    nowMs,
  });
  const statements: D1PreparedStatement[] = [];
  if (createPerson)
    statements.push(
      ...recordPerson(database, correlation, {
        id: tenantPersonId,
        fullName: request.tenant_name!,
        nowMs,
        effectiveDay: today,
        reason: 'tenancy_request_approved',
        evidence,
        guard: gate,
      }),
    );
  if (addContact)
    statements.push(
      recordContactMethod(database, correlation, {
        id: crypto.randomUUID(),
        partyId: tenantPersonId,
        channel: request.channel!,
        value: request.contact_value!,
        valueNormalized: request.contact_normalized!,
        // A new Person's only contact is their preferred one; a named Person
        // keeps whichever they already prefer.
        isPreferred: createPerson,
        startDay: null,
        nowMs,
        effectiveDay: today,
        reason: 'tenancy_request_approved',
        evidence,
        guard: gate,
      }),
    );

  const tenancyId = crypto.randomUUID();
  const tenancyIndex = statements.length;
  statements.push(
    database
      .prepare(
        `INSERT INTO tenancies (id, tenant_person_id, lot_id, basis_ownership_id,
           start_day, scheduled_end_day, renews_tenancy_id, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${gate.sql}`,
      )
      .bind(
        tenancyId,
        tenantPersonId,
        request.lot_id,
        request.basis_ownership_id,
        startDay,
        request.scheduled_end_day,
        request.renews_tenancy_id,
        nowMs,
        nowMs,
        ...gate.binds,
      ),
    database
      .prepare(
        `UPDATE tenancy_requests
         SET status = 'approved', tenancy_id = ?, decided_at = ?,
             decided_by_account_id = ?, ${CLEAR_REQUEST_CONTACT_SQL}
         WHERE id = ? AND status = 'open'
           AND EXISTS (SELECT 1 FROM tenancies WHERE id = ?)`,
      )
      .bind(tenancyId, nowMs, input.actorAccountId, requestId, tenancyId),
  );
  correlation.event({
    kind: 'tenancy_recorded',
    guard: insertedRowGuard('tenancies', tenancyId),
    detail: {
      family: 'roster_change',
      effective: { day: startDay },
      reason: 'tenancy_request_approved',
      evidence,
      subjects: [
        { column: 'tenancy_id', id: tenancyId, role: 'created' },
        { column: 'lot_id', id: request.lot_id, role: 'related' },
        { column: 'party_id', id: tenantPersonId, role: 'related' },
        {
          column: 'ownership_id',
          id: request.basis_ownership_id,
          role: 'related',
        },
      ],
    },
  });
  statements.push(...correlation.statements);

  const results = await database.batch(statements);
  if (results[tenancyIndex].meta.changes !== 1)
    return {
      ok: false,
      status: 409,
      reason:
        (await firstFailure(database, requestId, checks)) ?? 'already-decided',
    };
  return { ok: true, tenancyId, personId: tenantPersonId };
}
