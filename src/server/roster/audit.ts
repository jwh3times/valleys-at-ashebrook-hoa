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
    | 'access_grants'
    | 'person_verifications'
    | 'person_links'
    | 'verification_codes'
    | 'system_admin_bootstrap',
  id: string,
): SqlGuard {
  // The bootstrap singleton has no `id`; its key column is the marker.
  const idColumn = table === 'system_admin_bootstrap' ? 'singleton_key' : 'id';
  return {
    sql: `EXISTS (SELECT 1 FROM ${table} WHERE ${idColumn} = ?)`,
    binds: [id],
  };
}

/** Marker guard for a Person Link ending: `person_links` carries no
 * `updated_at`, so the post-state marker is the ending instant this command
 * stamped. */
export function endedLinkGuard(linkId: string, nowMs: number): SqlGuard {
  return {
    sql: 'EXISTS (SELECT 1 FROM person_links WHERE id = ? AND ended_at = ?)',
    binds: [linkId, nowMs],
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
 * none. `requestId` is legal only on a Roster Change or an Identity Event
 * (the opaque locator for a member correction request or a verification
 * review request); the board-service detail table has no such column, and
 * `identity_events` has no election column — an election proves nothing about
 * who an account is. */
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

/**
 * Identity Event reason codes (#201/#219). The `identity_events.reason_code`
 * column is deliberately unchecked (0024's board-service rebuild is the
 * recorded lesson that reason-code CHECKs become flip-blockers), so this
 * union IS the discipline — extend it here, never inline at a call site.
 * The first four mirror `person_verifications.reason`; the rest are the
 * Person Link ending reasons plus the review-queue decline.
 */
export type IdentityReason =
  | 'automatic_contact_proof'
  | 'manual_board_decision'
  | 'migration_reverification'
  | 'bootstrap_first_administrator'
  | 'self_unlink'
  | 'account_replaced'
  | 'no_longer_qualifies'
  | 'suspected_compromise'
  | 'recorded_in_error'
  | 'resident_request'
  | 'verification_review_declined';

/**
 * Review Flag resolution codes (#204/#220). Mirrors
 * `review_events_resolution_code_check` (migration 0020). `superseded` is
 * reserved for the automatic void/correction path — the admin resolve route
 * rejects it.
 */
export type ReviewResolutionCode =
  | 'remediated'
  | 'confirmed_valid'
  | 'no_effect'
  | 'superseded';

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
export type EffectiveDay = { day: string } | 'unknown' | 'not_applicable';

export type RosterSubjectColumn =
  | 'lot_id'
  | 'party_id'
  | 'contact_method_id'
  | 'ownership_id'
  | 'representation_id'
  | 'person_link_id';

export type BoardSubjectColumn =
  'board_term_id' | 'office_assignment_id' | 'lot_id';

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
  'person_name' | 'lot_address' | 'email' | 'phone' | 'free_text';

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
      subjects: {
        column: RosterSubjectColumn;
        id: string;
        role: SubjectRole;
      }[];
    }
  | {
      family: 'board_service_change';
      effective: EffectiveDay;
      reason: BoardServiceReason;
      evidence: Evidence;
      subjects: { column: BoardSubjectColumn; id: string; role: SubjectRole }[];
    }
  | {
      family: 'identity';
      reason: IdentityReason;
      personVerificationId?: string | null;
      personLinkId?: string | null;
      personId?: string | null;
      targetAccountId?: string | null;
      /** Absent for automatic verification (the verification row itself
       * carries the contact proof) and for link endings; a manual decision
       * carries what the approver actually relied on. */
      evidence?: Evidence | null;
    }
  | {
      family: 'access';
      grantId?: string | null;
      targetAccountId?: string | null;
      grantType?: 'board' | 'system_admin' | null;
      requestedAction:
        | 'grant'
        | 'revoke'
        | 'bootstrap'
        | 'roster_export'
        | 'last_administrator_change';
      outcome: 'allowed' | 'denied';
      reason?: string | null;
    }
  | {
      /** The Review Flag lifecycle (#220): `review_flag_opened` is a caused
       * event under the command that opened the flag, `review_flag_resolved`
       * an account-attributed root from the resolve route,
       * `review_flag_superseded` a caused event under the correcting command.
       * The category is read from the flag row, so kinds stay uniform. The
       * flag row FK-references its events, which is why flag statements come
       * AFTER the correlation's statements in the batch — the one exception
       * to domain-rows-first, documented at the top of this file's protocol. */
      family: 'review';
      reviewFlagId: string;
      /** NULL on an opening event; set on resolution and supersession. */
      resolutionCode?: ReviewResolutionCode | null;
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
  family: 'roster_change' | 'board_service_change' | 'identity',
): unknown[] {
  const allowRequest = family === 'roster_change' || family === 'identity';
  const allowElection = family !== 'identity';
  const refs = [
    evidence.documentId ?? null,
    evidence.meetingId ?? null,
    ...(allowElection ? [evidence.electionId ?? null] : []),
    ...(allowRequest ? [evidence.requestId ?? null] : []),
    evidence.externalReference ?? null,
  ];
  const present = refs.filter((r) => r !== null).length;
  const expected = evidence.kind === 'operator_observation' ? 0 : 1;
  if (
    present !== expected ||
    (!allowRequest && evidence.requestId) ||
    (!allowElection && evidence.electionId)
  )
    throw new Error(
      `evidence for ${family}/${evidence.kind} must carry exactly ${expected} reference`,
    );
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
      /** `bootstrap` is legal exactly once: the first-System-Administrator
       * operation (#201). The account is still recorded — the schema permits
       * a NULL account for bootstrap, but this writer always knows it. */
      actorKind?: 'account' | 'bootstrap';
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
      if (spec.actor)
        throw new Error('a correlation root is always account-attributed');
      this.rootId = id;
    }

    const guard = isRoot
      ? spec.guard
      : andGuards(
          {
            sql: 'EXISTS (SELECT 1 FROM audit_events WHERE id = ?)',
            binds: [this.rootId],
          },
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
          spec.actor ? 'automatic' : (this.opts.actorKind ?? 'account'),
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
      this.pushSubjects(
        id,
        'roster_change_subjects',
        ROSTER_SUBJECT_COLUMNS,
        detail.subjects,
        own,
      );
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
      this.pushSubjects(
        id,
        'board_service_change_subjects',
        BOARD_SUBJECT_COLUMNS,
        detail.subjects,
        own,
      );
      return;
    }
    if (detail.family === 'identity') {
      const evidence = detail.evidence ?? null;
      const [doc, meeting, request, external] = evidence
        ? evidenceColumns(evidence, 'identity')
        : [null, null, null, null];
      this.statements.push(
        this.database
          .prepare(
            `INSERT INTO identity_events (event_id, person_verification_id, person_link_id, person_id, target_account_id, reason_code, evidence_kind, evidence_document_id, evidence_meeting_id, evidence_request_id, external_reference)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${own.sql}`,
          )
          .bind(
            id,
            detail.personVerificationId ?? null,
            detail.personLinkId ?? null,
            detail.personId ?? null,
            detail.targetAccountId ?? null,
            detail.reason,
            evidence?.kind ?? null,
            doc,
            meeting,
            request,
            external,
            ...own.binds,
          ),
      );
      return;
    }
    if (detail.family === 'review') {
      this.statements.push(
        this.database
          .prepare(
            `INSERT INTO review_events (event_id, review_flag_id, resolution_code)
             SELECT ?, ?, ? WHERE ${own.sql}`,
          )
          .bind(
            id,
            detail.reviewFlagId,
            detail.resolutionCode ?? null,
            ...own.binds,
          ),
      );
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
      if (!allowed.has(s.column))
        throw new Error(`illegal subject column ${s.column}`);
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

/**
 * A statement that ERRORS — rolling back the entire batch — unless `guard`
 * holds when it runs.
 *
 * The zero-row no-op protocol above is right for the command's own race (the
 * route answers 409 from `meta.changes`), but some multi-part commands must
 * be all-or-nothing across parts that cannot share one primary statement: a
 * certification must not commit with one winner's term missing, and a named
 * substitute qualifying Lot that fails validation must fail the command
 * rather than fall through to a silent termination. This converts "the part
 * did not land" into a rollback by attempting an insert that violates
 * `audit_events_correlation_sequence_nonneg` — the CHECK's name is what the
 * route sniffs for in the caught error to answer 409/400 instead of 500.
 *
 * When the guard holds, the SELECT yields no row and nothing is inserted:
 * the ledger never sees this statement.
 */
export const BATCH_ASSERTION_CHECK = 'audit_events_correlation_sequence_nonneg';

export function assertInBatch(
  database: D1Database,
  guard: SqlGuard,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO audit_events (id, family, event_kind, correlation_id, correlation_sequence, causing_event_id, actor_kind, actor_account_id, automatic_cause, operation_key, recorded_at)
       SELECT ?, 'access', 'batch_assertion_failed', ?, -1, NULL, 'bootstrap', NULL, NULL, NULL, 0
       WHERE NOT (${guard.sql})`,
    )
    .bind(crypto.randomUUID(), crypto.randomUUID(), ...guard.binds);
}

/** True when a caught batch error is an `assertInBatch` rollback. */
export function isBatchAssertionError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes(BATCH_ASSERTION_CHECK)
  );
}
