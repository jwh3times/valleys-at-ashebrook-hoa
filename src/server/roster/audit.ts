// The immutable-history writer shared by every ADR 0022 phase-3b roster,
// board-service, and access mutation (#218; shapes decided by #197 and the
// resolutions on #202/#203/#205).
//
// One accepted command is ONE correlation: its initiating event is sequence 0
// with a globally unique operation key and no cause; consequences take
// increasing sequences and name the ROOT as their cause (the backfill's
// precedent). `recorded_at` is one instant for the whole command.
//
// ATOMICITY. D1 has no interactive transactions, and `db.batch()` rolls back
// on an ERROR — a statement that merely matches zero rows is a silent no-op.
// Every route therefore builds ONE batch of [domain statements..., audit
// statements...] where:
//
//   1. every DOMAIN statement carries the command's precondition in its own
//      WHERE (the mutation-boundary re-check this repo already practices);
//   2. every audit ENVELOPE is an INSERT..SELECT gated on a marker that proves
//      the domain write it describes actually landed — for an insert-primary,
//      `EXISTS (SELECT .. WHERE id = <fresh uuid>)`; for an update-primary,
//      the post-state stamped with this request's `updated_at` instant;
//   3. every detail, subject, and delta row is gated on its own envelope's id,
//      and every consequence envelope is additionally gated on the root's id.
//
// A lost race therefore produces ZERO rows in every table — no partial domain
// write, no phantom ledger entry — and the route detects it afterwards from
// `meta.changes` on its primary statement and answers 409.
//
// Domain statements come FIRST in the batch: ledger subject rows reference
// domain rows through RESTRICT foreign keys, so the rows must already exist.
//
// What this module never does: store personal values in the ledger. Names,
// addresses, and contact values travel as `audit_sensitive_field_changes`
// CATEGORIES only; durable IDs travel as typed subject rows, never as scalar
// deltas.

/** A boolean SQL fragment gating a statement, with its binds. */
export interface SqlGuard {
  sql: string;
  binds: unknown[];
}

export const ALWAYS: SqlGuard = { sql: '1', binds: [] };

/** Marker guard for an update-primary: the row exists in the post-state this
 * command stamped (`updated_at` = this request's instant). Inside the batch's
 * transaction nothing can interleave, so the marker is unambiguous. */
export function updatedRowGuard(
  table:
    | 'properties'
    | 'parties'
    | 'people'
    | 'organizations'
    | 'contact_methods'
    | 'ownerships'
    | 'representations'
    | 'board_service_terms'
    | 'board_office_assignments',
  id: string,
  nowMs: number,
  // `properties` is the one legacy table here; its timestamps are SECONDS.
  extraSql = '',
  extraBinds: unknown[] = [],
): SqlGuard {
  const stamp = table === 'properties' ? Math.floor(nowMs / 1000) : nowMs;
  // The subtype tables key on their party.
  const idColumn =
    table === 'people' || table === 'organizations' ? 'party_id' : 'id';
  return {
    sql: `EXISTS (SELECT 1 FROM ${table} WHERE ${idColumn} = ? AND updated_at = ?${extraSql})`,
    binds: [id, stamp, ...extraBinds],
  };
}

/** Marker guard for an insert-primary: the freshly minted row exists. */
export function insertedRowGuard(
  table:
    | 'parties'
    | 'contact_methods'
    | 'ownerships'
    | 'representations'
    | 'board_service_terms'
    | 'board_office_assignments'
    | 'access_grants',
  id: string,
): SqlGuard {
  return {
    sql: `EXISTS (SELECT 1 FROM ${table} WHERE id = ?)`,
    binds: [id],
  };
}

export function andGuards(...guards: SqlGuard[]): SqlGuard {
  return {
    sql: guards.map((g) => `(${g.sql})`).join(' AND '),
    binds: guards.flatMap((g) => g.binds),
  };
}

export type EvidenceKind =
  | 'document'
  | 'meeting'
  | 'election'
  | 'request'
  | 'external'
  | 'operator_observation';

/** Exactly one reference, matching its kind — `operator_observation` carries
 * none. `requestId` is legal only on a Roster Change (the opaque locator for a
 * member correction request); the board-service detail table has no such
 * column. */
export interface Evidence {
  kind: EvidenceKind;
  documentId?: string | null;
  meetingId?: string | null;
  electionId?: string | null;
  requestId?: string | null;
  externalReference?: string | null;
}

export const OPERATOR_OBSERVATION: Evidence = {
  kind: 'operator_observation',
};

/**
 * Roster Change reason codes. The SQL column is deliberately unchecked (unlike
 * board-service reasons), so this union IS the discipline — extend it here,
 * never inline at a call site.
 */
export type RosterChangeReason =
  | 'board_recorded'
  | 'ownership_transfer'
  | 'lot_retired'
  | 'duplicate_consolidation'
  | 'consolidation_correction'
  | 'correction_request_accepted'
  | 'scope_correction'
  | 'recorded_in_error';

/** Mirrors `board_service_changes_reason_code_check` (migration 0024). */
export type BoardServiceReason =
  | 'term_expired'
  | 'resigned'
  | 'removed'
  | 'declared_vacant_absences'
  | 'eligibility_lost'
  | 'vacancy_appointment'
  | 'elected'
  | 'qualifying_lot_substituted'
  | 'office_assigned'
  | 'office_ended'
  | 'recorded_in_error';

/** `known` requires the real Association Day; `unknown` is reserved for
 * accepted legacy facts; `not_applicable` for identity/consolidation
 * corrections with no meaningful real-world day. */
export type EffectiveDay =
  | { day: string }
  | 'unknown'
  | 'not_applicable';

export type RosterSubjectColumn =
  | 'lot_id'
  | 'party_id'
  | 'contact_method_id'
  | 'ownership_id'
  | 'representation_id'
  | 'person_link_id';

export type BoardSubjectColumn =
  | 'board_term_id'
  | 'office_assignment_id'
  | 'lot_id';

export type SubjectRole =
  | 'primary'
  | 'created'
  | 'ended'
  | 'voided'
  | 'replacement'
  | 'duplicate'
  | 'survivor'
  | 'related';

const ROSTER_SUBJECT_COLUMNS: ReadonlySet<string> = new Set([
  'lot_id',
  'party_id',
  'contact_method_id',
  'ownership_id',
  'representation_id',
  'person_link_id',
]);

const BOARD_SUBJECT_COLUMNS: ReadonlySet<string> = new Set([
  'board_term_id',
  'office_assignment_id',
  'lot_id',
]);

export type SensitiveCategory =
  | 'person_name'
  | 'lot_address'
  | 'email'
  | 'phone'
  | 'free_text';

export interface ScalarDelta {
  fieldKey: string;
  valueType: 'text' | 'integer' | 'boolean' | 'day' | 'instant';
  old: string | number | boolean | null;
  new: string | number | boolean | null;
}

export type AuditDetail =
  | {
      family: 'roster_change';
      effective: EffectiveDay;
      reason: RosterChangeReason;
      evidence: Evidence;
      subjects: { column: RosterSubjectColumn; id: string; role: SubjectRole }[];
    }
  | {
      family: 'board_service_change';
      effective: EffectiveDay;
      reason: BoardServiceReason;
      evidence: Evidence;
      subjects: { column: BoardSubjectColumn; id: string; role: SubjectRole }[];
    }
  | {
      family: 'access';
      grantId?: string | null;
      targetAccountId?: string | null;
      grantType?: 'board' | 'system_admin' | null;
      requestedAction:
        | 'grant'
        | 'revoke'
        | 'roster_export'
        | 'last_administrator_change';
      outcome: 'allowed' | 'denied';
      reason?: string | null;
    }
  | {
      family: 'roster_redaction';
      targetPersonId?: string | null;
      targetContactMethodId?: string | null;
      fieldCategory: 'person_name' | 'email' | 'phone';
      authorizedByAccountId: string;
      authorityKind: 'legal_requirement' | 'binding_policy';
      authorityReference: string;
      reason: string;
    };

export interface AuditEventSpec {
  /** Checked domain action, e.g. `ownership_ended`. Extend the writers, never
   * pass a runtime string. */
  kind: string;
  detail: AuditDetail;
  scalars?: ScalarDelta[];
  sensitive?: SensitiveCategory[];
  /** Omitted = the commanding account (required for the root: an automatic
   * root is schema-impossible). `automatic` is for caused facts — the term
   * that ended because an Ownership did. */
  actor?: { kind: 'automatic'; cause: string };
  /** Gate proving the domain write this event describes landed. The root's
   * guard doubles as the command's success marker; consequences are gated on
   * the root's envelope AND their own guard. */
  guard: SqlGuard;
}

const effectiveColumns = (
  effective: EffectiveDay,
): { day: string | null; basis: string } =>
  typeof effective === 'string'
    ? { day: null, basis: effective }
    : { day: effective.day, basis: 'known' };

function evidenceColumns(
  evidence: Evidence,
  family: 'roster_change' | 'board_service_change',
): unknown[] {
  const refs = [
    evidence.documentId ?? null,
    evidence.meetingId ?? null,
    evidence.electionId ?? null,
    ...(family === 'roster_change' ? [evidence.requestId ?? null] : []),
    evidence.externalReference ?? null,
  ];
  const present = refs.filter((r) => r !== null).length;
  const expected = evidence.kind === 'operator_observation' ? 0 : 1;
  if (present !== expected || (family !== 'roster_change' && evidence.requestId))
    throw new Error(`evidence for ${family}/${evidence.kind} must carry exactly ${expected} reference`);
  return refs;
}

/**
 * One command's correlation. Call `event()` in consequence order — the first
 * call is the root — then append `statements` AFTER the command's domain
 * statements in one `db.batch()`.
 */
export class AuditCorrelation {
  private seq = 0;
  private rootId: string | null = null;
  private readonly correlationId = crypto.randomUUID();
  readonly statements: D1PreparedStatement[] = [];

  constructor(
    private readonly database: D1Database,
    private readonly opts: {
      /** Globally unique; `<route>:<action>:<uuid>` unless the command is
       * deliberately idempotent. */
      operationKey: string;
      actorAccountId: string;
      nowMs: number;
    },
  ) {}

  get rootEventId(): string | null {
    return this.rootId;
  }

  /** Registers one event (envelope + detail + subjects + deltas). Returns its id. */
  event(spec: AuditEventSpec): string {
    const id = crypto.randomUUID();
    const seq = this.seq;
    this.seq += 1;
    const isRoot = seq === 0;
    if (isRoot) {
      if (spec.actor) throw new Error('a correlation root is always account-attributed');
      this.rootId = id;
    }

    const guard = isRoot
      ? spec.guard
      : andGuards(
          { sql: 'EXISTS (SELECT 1 FROM audit_events WHERE id = ?)', binds: [this.rootId] },
          spec.guard,
        );

    this.statements.push(
      this.database
        .prepare(
          `INSERT INTO audit_events (id, family, event_kind, correlation_id, correlation_sequence, causing_event_id, actor_kind, actor_account_id, automatic_cause, operation_key, recorded_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
        )
        .bind(
          id,
          spec.detail.family,
          spec.kind,
          this.correlationId,
          seq,
          isRoot ? null : this.rootId,
          spec.actor ? 'automatic' : 'account',
          spec.actor ? null : this.opts.actorAccountId,
          spec.actor ? spec.actor.cause : null,
          isRoot ? this.opts.operationKey : null,
          this.opts.nowMs,
          ...guard.binds,
        ),
    );

    const own: SqlGuard = {
      sql: 'EXISTS (SELECT 1 FROM audit_events WHERE id = ?)',
      binds: [id],
    };
    this.pushDetail(id, spec.detail, own);
    for (const s of spec.scalars ?? []) this.pushScalar(id, s, own);
    for (const c of spec.sensitive ?? []) {
      this.statements.push(
        this.database
          .prepare(
            `INSERT INTO audit_sensitive_field_changes (id, event_id, field_category)
             SELECT ?, ?, ? WHERE ${own.sql}`,
          )
          .bind(crypto.randomUUID(), id, c, ...own.binds),
      );
    }
    return id;
  }

  private pushDetail(id: string, detail: AuditDetail, own: SqlGuard): void {
    if (detail.family === 'roster_change') {
      const { day, basis } = effectiveColumns(detail.effective);
      this.statements.push(
        this.database
          .prepare(
            `INSERT INTO roster_changes (event_id, effective_day, effective_day_basis, reason_code, evidence_kind, evidence_document_id, evidence_meeting_id, evidence_election_id, evidence_request_id, external_reference)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${own.sql}`,
          )
          .bind(
            id,
            day,
            basis,
            detail.reason,
            detail.evidence.kind,
            ...evidenceColumns(detail.evidence, 'roster_change'),
            ...own.binds,
          ),
      );
      this.pushSubjects(id, 'roster_change_subjects', ROSTER_SUBJECT_COLUMNS, detail.subjects, own);
      return;
    }
    if (detail.family === 'board_service_change') {
      const { day, basis } = effectiveColumns(detail.effective);
      this.statements.push(
        this.database
          .prepare(
            `INSERT INTO board_service_changes (event_id, effective_day, effective_day_basis, reason_code, evidence_kind, evidence_document_id, evidence_meeting_id, evidence_election_id, external_reference)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${own.sql}`,
          )
          .bind(
            id,
            day,
            basis,
            detail.reason,
            detail.evidence.kind,
            ...evidenceColumns(detail.evidence, 'board_service_change'),
            ...own.binds,
          ),
      );
      this.pushSubjects(id, 'board_service_change_subjects', BOARD_SUBJECT_COLUMNS, detail.subjects, own);
      return;
    }
    if (detail.family === 'access') {
      this.statements.push(
        this.database
          .prepare(
            `INSERT INTO access_events (event_id, access_grant_id, target_account_id, grant_type, requested_action, outcome, reason_code)
             SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${own.sql}`,
          )
          .bind(
            id,
            detail.grantId ?? null,
            detail.targetAccountId ?? null,
            detail.grantType ?? null,
            detail.requestedAction,
            detail.outcome,
            detail.reason ?? null,
            ...own.binds,
          ),
      );
      return;
    }
    this.statements.push(
      this.database
        .prepare(
          `INSERT INTO roster_redactions (event_id, target_person_id, target_contact_method_id, field_category, authorized_by_account_id, authority_kind, authority_reference, reason_code)
           SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${own.sql}`,
        )
        .bind(
          id,
          detail.targetPersonId ?? null,
          detail.targetContactMethodId ?? null,
          detail.fieldCategory,
          detail.authorizedByAccountId,
          detail.authorityKind,
          detail.authorityReference,
          detail.reason,
          ...own.binds,
        ),
    );
  }

  private pushSubjects(
    id: string,
    table: 'roster_change_subjects' | 'board_service_change_subjects',
    allowed: ReadonlySet<string>,
    subjects: { column: string; id: string; role: SubjectRole }[],
    own: SqlGuard,
  ): void {
    for (const s of subjects) {
      // The column name is interpolated, so it goes through the typed
      // allow-list even though the union already constrains it — a cast at a
      // call site must not become an injection.
      if (!allowed.has(s.column)) throw new Error(`illegal subject column ${s.column}`);
      this.statements.push(
        this.database
          .prepare(
            `INSERT INTO ${table} (id, event_id, role, ${s.column})
             SELECT ?, ?, ?, ? WHERE ${own.sql}`,
          )
          .bind(crypto.randomUUID(), id, s.role, s.id, ...own.binds),
      );
    }
  }

  private pushScalar(id: string, delta: ScalarDelta, own: SqlGuard): void {
    const cols: Record<ScalarDelta['valueType'], [string, string]> = {
      text: ['old_text', 'new_text'],
      integer: ['old_integer', 'new_integer'],
      boolean: ['old_boolean', 'new_boolean'],
      day: ['old_day', 'new_day'],
      instant: ['old_instant', 'new_instant'],
    };
    const [oldCol, newCol] = cols[delta.valueType];
    const encode = (v: ScalarDelta['old']) =>
      typeof v === 'boolean' ? (v ? 1 : 0) : v;
    this.statements.push(
      this.database
        .prepare(
          `INSERT INTO audit_scalar_changes (id, event_id, field_key, value_type, ${oldCol}, ${newCol})
           SELECT ?, ?, ?, ?, ?, ? WHERE ${own.sql}`,
        )
        .bind(
          crypto.randomUUID(),
          id,
          delta.fieldKey,
          delta.valueType,
          encode(delta.old),
          encode(delta.new),
          ...own.binds,
        ),
    );
  }
}

/** The conventional non-idempotent operation key. */
export function operationKey(route: string, action: string): string {
  return `${route}:${action}:${crypto.randomUUID()}`;
}
