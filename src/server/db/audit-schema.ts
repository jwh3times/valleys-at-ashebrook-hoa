import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  check,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './auth-schema';
import {
  properties,
  documents,
  meetings,
  elections,
  motions,
  memberAttendance,
  memberVotes,
  ballots,
  proxies,
} from './schema';
import {
  parties,
  people,
  contactMethods,
  ownerships,
  representations,
  personLinks,
  personVerifications,
  boardServiceTerms,
  boardOfficeAssignments,
  accessGrants,
} from './roster-schema';

// The ADR 0022 immutable history: a causally ordered typed Audit Event ledger.
//
// PHASE 1 ("expand"). Nothing reads these tables yet — see issue #195.
//
// The promise, and its limits. The ledger reconstructs durable identity
// relationships, effective periods, non-personal structural values, who or what
// recorded a change, when, and its causal consequences. It deliberately CANNOT
// reconstruct erased names, addresses, emails, phones, or sensitive free text —
// that is what makes Roster Redaction meaningful rather than cosmetic. No table
// here stores personal before/after values, hashes, ciphertext, reversible
// surrogates, arbitrary JSON, or serialized snapshots.
//
// Current domain rows, never replayed events, drive live authorization.
//
// "Append-only" is a discipline, not a database guarantee: D1 has one
// application binding and this design forbids triggers, so no route or
// repository may update or delete a ledger row, integration tests pin
// insert-only behavior, and the product claims no cryptographic tamper
// evidence.

const instant = (name: string) => integer(name, { mode: 'timestamp_ms' });
const day = (name: string) => text(name);

const EVENT_FAMILIES = [
  'roster_change',
  'board_service_change',
  'identity',
  'access',
  'roster_redaction',
  'review',
  'audit_record_correction',
] as const;

const EFFECTIVE_DAY_BASES = ['known', 'unknown', 'not_applicable'] as const;

const EVIDENCE_KINDS = [
  'document',
  'meeting',
  'election',
  'request',
  'external',
  // The explicit no-external-record kind. "The treasurer knows her, she was at
  // the March meeting" is honestly this, and naming it stops it being dressed
  // up as something firmer.
  'operator_observation',
] as const;

// ---------------------------------------------------------------------------
// The common envelope
// ---------------------------------------------------------------------------

export const auditEvents = sqliteTable(
  'audit_events',
  {
    // Authoritative database-wide commit and replay order. Gaps carry no
    // business meaning and are never reused. Pagination and replay use this;
    // displays use `recorded_at`.
    ledgerSequence: integer('ledger_sequence').primaryKey({
      autoIncrement: true,
    }),
    // Opaque. Every event FK in this file references `id`, not the sequence.
    id: text('id').notNull(),
    family: text('family', { enum: EVENT_FAMILIES }).notNull(),
    // Checked domain actions such as `ownership_ended`,
    // `qualifying_lot_substituted`, `person_link_ended`, `grant_revoked`,
    // `value_redacted` — never generic runtime strings. Extending the set
    // requires a migration, writer behavior, and Worker/D1 tests.
    eventKind: text('event_kind').notNull(),
    // One accepted command is one correlation. Its initiating event is
    // sequence 0 with no cause and a globally unique operation key;
    // consequences take increasing positive sequences and name their cause.
    correlationId: text('correlation_id').notNull(),
    correlationSequence: integer('correlation_sequence').notNull(),
    causingEventId: text('causing_event_id').references(
      (): AnySQLiteColumn => auditEvents.id,
      { onDelete: 'restrict' },
    ),
    actorKind: text('actor_kind', {
      // `migration` is legal only for the backfill and still requires the
      // operator's account id — the same shape that makes `bootstrap` safe. It
      // exists because stamping `account` would claim a human individually
      // decided each of hundreds of baseline facts.
      enum: ['account', 'automatic', 'bootstrap', 'migration'],
    }).notNull(),
    actorAccountId: text('actor_account_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    automaticCause: text('automatic_cause'),
    // Idempotency key on the initiating event of each correlation.
    operationKey: text('operation_key'),
    // Server-generated. One instant is bound for all events of a synchronous
    // mutation; clients never supply or alter it.
    recordedAt: instant('recorded_at').notNull(),
  },
  (t) => [
    check(
      'audit_events_family_check',
      sql`"family" IN ('roster_change', 'board_service_change', 'identity', 'access', 'roster_redaction', 'review', 'audit_record_correction')`,
    ),
    check(
      'audit_events_actor_kind_check',
      sql`"actor_kind" IN ('account', 'automatic', 'bootstrap', 'migration')`,
    ),
    // An accountable actor kind names its account and carries no automatic
    // cause; an automatic consequence names its cause and no account.
    check(
      'audit_events_actor_account_shape',
      sql`"actor_kind" NOT IN ('account', 'migration') OR ("actor_account_id" IS NOT NULL AND "automatic_cause" IS NULL)`,
    ),
    check(
      'audit_events_automatic_shape',
      sql`"actor_kind" <> 'automatic' OR ("automatic_cause" IS NOT NULL AND "causing_event_id" IS NOT NULL)`,
    ),
    check(
      'audit_events_correlation_sequence_nonneg',
      sql`"correlation_sequence" >= 0`,
    ),
    // Sequence 0 initiates: no cause, and an operation key. Anything later is
    // a consequence: a cause, and no key.
    check(
      'audit_events_initiating_shape',
      sql`("correlation_sequence" = 0) = ("operation_key" IS NOT NULL)`,
    ),
    check(
      'audit_events_consequence_shape',
      sql`"correlation_sequence" = 0 OR "causing_event_id" IS NOT NULL`,
    ),
    check(
      'audit_events_root_has_no_cause',
      sql`"correlation_sequence" <> 0 OR "causing_event_id" IS NULL`,
    ),
    uniqueIndex('audit_events_id_unq').on(t.id),
    // No two events occupy one ordering position in a correlation.
    uniqueIndex('audit_events_correlation_position_unq').on(
      t.correlationId,
      t.correlationSequence,
    ),
    uniqueIndex('audit_events_operation_key_unq').on(t.operationKey),
    index('audit_events_family_kind_idx').on(t.family, t.eventKind),
    index('audit_events_causing_idx').on(t.causingEventId),
    index('audit_events_recorded_at_idx').on(t.recordedAt),
  ],
);

const eventId = () =>
  text('event_id')
    .primaryKey()
    .references(() => auditEvents.id, { onDelete: 'restrict' });

// ---------------------------------------------------------------------------
// Typed details — exactly one per envelope
// ---------------------------------------------------------------------------

export const rosterChanges = sqliteTable(
  'roster_changes',
  {
    eventId: eventId(),
    // `known` requires a real Association Day; `unknown` is restricted to
    // accepted legacy facts; `not_applicable` to identity/consolidation
    // corrections with no meaningful real-world day.
    effectiveDay: day('effective_day'),
    effectiveDayBasis: text('effective_day_basis', {
      enum: EFFECTIVE_DAY_BASES,
    }).notNull(),
    reasonCode: text('reason_code').notNull(),
    evidenceKind: text('evidence_kind', { enum: EVIDENCE_KINDS }).notNull(),
    evidenceDocumentId: text('evidence_document_id').references(
      () => documents.id,
      { onDelete: 'restrict' },
    ),
    evidenceMeetingId: text('evidence_meeting_id').references(
      () => meetings.id,
      { onDelete: 'restrict' },
    ),
    evidenceElectionId: text('evidence_election_id').references(
      () => elections.id,
      { onDelete: 'restrict' },
    ),
    // An opaque, non-personal locator for a request that has since expired.
    evidenceRequestId: text('evidence_request_id'),
    externalReference: text('external_reference'),
  },
  () => [
    check(
      'roster_changes_effective_day_basis_check',
      sql`"effective_day_basis" IN ('known', 'unknown', 'not_applicable')`,
    ),
    check(
      'roster_changes_known_day_present',
      sql`("effective_day_basis" = 'known') = ("effective_day" IS NOT NULL)`,
    ),
    check(
      'roster_changes_evidence_kind_check',
      sql`"evidence_kind" IN ('document', 'meeting', 'election', 'request', 'external', 'operator_observation')`,
    ),
    // Each evidence kind carries exactly its own reference, and
    // `operator_observation` carries none.
    check(
      'roster_changes_evidence_exactly_one',
      sql`(CASE WHEN "evidence_document_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "evidence_meeting_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "evidence_election_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "evidence_request_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "external_reference" IS NULL THEN 0 ELSE 1 END) = (CASE WHEN "evidence_kind" = 'operator_observation' THEN 0 ELSE 1 END)`,
    ),
  ],
);

export const boardServiceChanges = sqliteTable(
  'board_service_changes',
  {
    eventId: eventId(),
    effectiveDay: day('effective_day'),
    effectiveDayBasis: text('effective_day_basis', {
      enum: EFFECTIVE_DAY_BASES,
    }).notNull(),
    // Checked codes so the ledger distinguishes the Art. IV §1(c) absence
    // declaration from a resignation without free text.
    // `legacy_migration_baseline` (migration 0024) is the backfill's baseline
    // code — `roster_changes` accepts it because its reason column is
    // unchecked, and the board-term baseline must not be forced to claim a
    // human reason that never existed.
    reasonCode: text('reason_code', {
      enum: [
        'term_expired',
        'resigned',
        'removed',
        'declared_vacant_absences',
        'eligibility_lost',
        'vacancy_appointment',
        'elected',
        'qualifying_lot_substituted',
        'office_assigned',
        'office_ended',
        'recorded_in_error',
        'legacy_migration_baseline',
      ],
    }).notNull(),
    evidenceKind: text('evidence_kind', { enum: EVIDENCE_KINDS }).notNull(),
    evidenceDocumentId: text('evidence_document_id').references(
      () => documents.id,
      { onDelete: 'restrict' },
    ),
    evidenceMeetingId: text('evidence_meeting_id').references(
      () => meetings.id,
      { onDelete: 'restrict' },
    ),
    evidenceElectionId: text('evidence_election_id').references(
      () => elections.id,
      { onDelete: 'restrict' },
    ),
    externalReference: text('external_reference'),
  },
  () => [
    check(
      'board_service_changes_effective_day_basis_check',
      sql`"effective_day_basis" IN ('known', 'unknown', 'not_applicable')`,
    ),
    check(
      'board_service_changes_known_day_present',
      sql`("effective_day_basis" = 'known') = ("effective_day" IS NOT NULL)`,
    ),
    check(
      'board_service_changes_reason_code_check',
      sql`"reason_code" IN ('term_expired', 'resigned', 'removed', 'declared_vacant_absences', 'eligibility_lost', 'vacancy_appointment', 'elected', 'qualifying_lot_substituted', 'office_assigned', 'office_ended', 'recorded_in_error', 'legacy_migration_baseline')`,
    ),
    check(
      'board_service_changes_evidence_kind_check',
      sql`"evidence_kind" IN ('document', 'meeting', 'election', 'request', 'external', 'operator_observation')`,
    ),
    check(
      'board_service_changes_evidence_exactly_one',
      sql`(CASE WHEN "evidence_document_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "evidence_meeting_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "evidence_election_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "external_reference" IS NULL THEN 0 ELSE 1 END) = (CASE WHEN "evidence_kind" = 'operator_observation' THEN 0 ELSE 1 END)`,
    ),
  ],
);

// Distinct from a Roster Change because a linked Account may self-unlink,
// while a roster fact requires stronger authority. Evidence columns mirror
// `roster_changes` so the most judgment-laden write in the system — a human
// deciding an Account is a Person — is not the one with the weakest trail.
export const identityEvents = sqliteTable(
  'identity_events',
  {
    eventId: eventId(),
    personVerificationId: text('person_verification_id').references(
      () => personVerifications.id,
      { onDelete: 'restrict' },
    ),
    personLinkId: text('person_link_id').references(() => personLinks.id, {
      onDelete: 'restrict',
    }),
    personId: text('person_id').references(() => people.partyId, {
      onDelete: 'restrict',
    }),
    targetAccountId: text('target_account_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    // Deliberately UNCHECKED at the SQL level: migration 0024's
    // board-service-changes rebuild is the recorded lesson that reason-code
    // CHECKs become flip-blockers. The `IdentityReason` union in
    // `src/server/roster/audit.ts` is the discipline.
    reasonCode: text('reason_code').notNull(),
    // No election kind: identity decisions cite documents, meetings, review
    // requests, external records, or the approver's own observation — an
    // election proves nothing about who an account is.
    evidenceKind: text('evidence_kind', {
      enum: [
        'document',
        'meeting',
        'request',
        'external',
        'operator_observation',
      ],
    }),
    evidenceDocumentId: text('evidence_document_id').references(
      () => documents.id,
      { onDelete: 'restrict' },
    ),
    evidenceMeetingId: text('evidence_meeting_id').references(
      () => meetings.id,
      { onDelete: 'restrict' },
    ),
    // Opaque, non-personal locator for a verification review request that has
    // since expired — the roster_changes precedent, never an FK.
    evidenceRequestId: text('evidence_request_id'),
    externalReference: text('external_reference'),
  },
  () => [
    check(
      'identity_events_evidence_kind_check',
      sql`"evidence_kind" IS NULL OR "evidence_kind" IN ('document', 'meeting', 'request', 'external', 'operator_observation')`,
    ),
    // Evidence is optional (automatic verification carries none), but when a
    // kind is named it carries exactly its one reference, and
    // `operator_observation` carries none — mirroring roster_changes.
    check(
      'identity_events_evidence_exactly_one',
      sql`(CASE WHEN "evidence_document_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "evidence_meeting_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "evidence_request_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "external_reference" IS NULL THEN 0 ELSE 1 END) = (CASE WHEN "evidence_kind" IS NULL OR "evidence_kind" = 'operator_observation' THEN 0 ELSE 1 END)`,
    ),
  ],
);

// Permanently records successful privileged grants and revocations, privileged
// change attempts denied by an access-specific invariant, and bulk personal-data
// export — the one read that removes data from the system's control, after
// which every other privacy boundary is moot. Ordinary 401/403 responses,
// malformed requests, login failures, and attacker payloads belong in bounded
// security telemetry, not here.
export const accessEvents = sqliteTable(
  'access_events',
  {
    eventId: eventId(),
    accessGrantId: text('access_grant_id').references(() => accessGrants.id, {
      onDelete: 'restrict',
    }),
    targetAccountId: text('target_account_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    grantType: text('grant_type', { enum: ['board', 'system_admin'] }),
    requestedAction: text('requested_action', {
      enum: [
        'grant',
        'revoke',
        'bootstrap',
        'roster_export',
        'last_administrator_change',
        'grant_precondition_revalidation',
      ],
    }).notNull(),
    outcome: text('outcome', { enum: ['allowed', 'denied'] }).notNull(),
    reasonCode: text('reason_code'),
  },
  () => [
    check(
      'access_events_grant_type_check',
      sql`"grant_type" IS NULL OR "grant_type" IN ('board', 'system_admin')`,
    ),
    check(
      'access_events_requested_action_check',
      sql`"requested_action" IN ('grant', 'revoke', 'bootstrap', 'roster_export', 'last_administrator_change', 'grant_precondition_revalidation')`,
    ),
    check(
      'access_events_outcome_check',
      sql`"outcome" IN ('allowed', 'denied')`,
    ),
  ],
);

// Evidence of a redaction — never the erased value, its hash, ciphertext, or
// any reversible token. Authority is a policy or legal citation.
export const rosterRedactions = sqliteTable(
  'roster_redactions',
  {
    eventId: eventId(),
    targetPersonId: text('target_person_id').references(() => people.partyId, {
      onDelete: 'restrict',
    }),
    targetContactMethodId: text('target_contact_method_id').references(
      () => contactMethods.id,
      { onDelete: 'restrict' },
    ),
    fieldCategory: text('field_category', {
      enum: ['person_name', 'email', 'phone'],
    }).notNull(),
    authorizedByAccountId: text('authorized_by_account_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    authorityKind: text('authority_kind', {
      enum: ['legal_requirement', 'binding_policy'],
    }).notNull(),
    authorityReference: text('authority_reference').notNull(),
    reasonCode: text('reason_code').notNull(),
  },
  () => [
    check(
      'roster_redactions_field_category_check',
      sql`"field_category" IN ('person_name', 'email', 'phone')`,
    ),
    check(
      'roster_redactions_authority_kind_check',
      sql`"authority_kind" IN ('legal_requirement', 'binding_policy')`,
    ),
    check(
      'roster_redactions_target_exactly_one',
      sql`(CASE WHEN "target_person_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "target_contact_method_id" IS NULL THEN 0 ELSE 1 END) = 1`,
    ),
  ],
);

export const reviewEvents = sqliteTable(
  'review_events',
  {
    eventId: eventId(),
    reviewFlagId: text('review_flag_id').notNull(),
    resolutionCode: text('resolution_code', {
      enum: ['remediated', 'confirmed_valid', 'no_effect', 'superseded'],
    }),
  },
  (t) => [
    check(
      'review_events_resolution_code_check',
      sql`"resolution_code" IS NULL OR "resolution_code" IN ('remediated', 'confirmed_valid', 'no_effect', 'superseded')`,
    ),
    index('review_events_flag_idx').on(t.reviewFlagId),
  ],
);

// A clerical error in event *metadata* creates one of these; it never updates
// the original row. It may address only allow-listed non-personal metadata —
// Effective Day and basis, reason code, supporting reference, subject role —
// and can never alter the original's id, family, Recorded At, actor,
// correlation, or causal chain.
export const auditRecordCorrections = sqliteTable(
  'audit_record_corrections',
  {
    eventId: eventId(),
    correctedEventId: text('corrected_event_id')
      .notNull()
      .references(() => auditEvents.id, { onDelete: 'restrict' }),
    correctionSequence: integer('correction_sequence').notNull(),
  },
  (t) => [
    check(
      'audit_record_corrections_sequence_positive',
      sql`"correction_sequence" > 0`,
    ),
    uniqueIndex('audit_record_corrections_position_unq').on(
      t.correctedEventId,
      t.correctionSequence,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Subjects and structural deltas
// ---------------------------------------------------------------------------

const SUBJECT_ROLES = [
  'primary',
  'created',
  'ended',
  'voided',
  'replacement',
  'duplicate',
  'survivor',
  'related',
] as const;

export const rosterChangeSubjects = sqliteTable(
  'roster_change_subjects',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => auditEvents.id, { onDelete: 'restrict' }),
    role: text('role', { enum: SUBJECT_ROLES }).notNull(),
    lotId: text('lot_id').references(() => properties.id, {
      onDelete: 'restrict',
    }),
    partyId: text('party_id').references(() => parties.id, {
      onDelete: 'restrict',
    }),
    contactMethodId: text('contact_method_id').references(
      () => contactMethods.id,
      { onDelete: 'restrict' },
    ),
    ownershipId: text('ownership_id').references(() => ownerships.id, {
      onDelete: 'restrict',
    }),
    representationId: text('representation_id').references(
      () => representations.id,
      { onDelete: 'restrict' },
    ),
    personLinkId: text('person_link_id').references(() => personLinks.id, {
      onDelete: 'restrict',
    }),
  },
  (t) => [
    check(
      'roster_change_subjects_role_check',
      sql`"role" IN ('primary', 'created', 'ended', 'voided', 'replacement', 'duplicate', 'survivor', 'related')`,
    ),
    check(
      'roster_change_subjects_exactly_one',
      sql`(CASE WHEN "lot_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "party_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "contact_method_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "ownership_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "representation_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "person_link_id" IS NULL THEN 0 ELSE 1 END) = 1`,
    ),
    index('roster_change_subjects_event_idx').on(t.eventId),
    index('roster_change_subjects_party_idx').on(t.partyId),
    index('roster_change_subjects_lot_idx').on(t.lotId),
  ],
);

// `lot_id` is here because a qualifying-Lot substitution is a durable-ID
// change, and durable IDs travel as real subject FKs rather than being copied
// into scalar deltas. A substitution writes three rows: the Term as `primary`,
// the outgoing Lot as `related`, the incoming Lot as `replacement`.
export const boardServiceChangeSubjects = sqliteTable(
  'board_service_change_subjects',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => auditEvents.id, { onDelete: 'restrict' }),
    role: text('role', { enum: SUBJECT_ROLES }).notNull(),
    boardTermId: text('board_term_id').references(() => boardServiceTerms.id, {
      onDelete: 'restrict',
    }),
    officeAssignmentId: text('office_assignment_id').references(
      () => boardOfficeAssignments.id,
      { onDelete: 'restrict' },
    ),
    lotId: text('lot_id').references(() => properties.id, {
      onDelete: 'restrict',
    }),
  },
  (t) => [
    check(
      'board_service_change_subjects_role_check',
      sql`"role" IN ('primary', 'created', 'ended', 'voided', 'replacement', 'duplicate', 'survivor', 'related')`,
    ),
    check(
      'board_service_change_subjects_exactly_one',
      sql`(CASE WHEN "board_term_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "office_assignment_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "lot_id" IS NULL THEN 0 ELSE 1 END) = 1`,
    ),
    index('board_service_change_subjects_event_idx').on(t.eventId),
    index('board_service_change_subjects_term_idx').on(t.boardTermId),
  ],
);

// Allow-listed NON-PERSONAL fields only: dates, weights, enums, offices, scope,
// grant type, lifecycle markers. Durable entity IDs never appear here — they
// travel as subject FKs above.
export const auditScalarChanges = sqliteTable(
  'audit_scalar_changes',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => auditEvents.id, { onDelete: 'restrict' }),
    fieldKey: text('field_key').notNull(),
    valueType: text('value_type', {
      enum: ['text', 'integer', 'boolean', 'day', 'instant'],
    }).notNull(),
    oldText: text('old_text'),
    newText: text('new_text'),
    oldInteger: integer('old_integer'),
    newInteger: integer('new_integer'),
    oldBoolean: integer('old_boolean', { mode: 'boolean' }),
    newBoolean: integer('new_boolean', { mode: 'boolean' }),
    oldDay: day('old_day'),
    newDay: day('new_day'),
    oldInstant: instant('old_instant'),
    newInstant: instant('new_instant'),
  },
  (t) => [
    check(
      'audit_scalar_changes_value_type_check',
      sql`"value_type" IN ('text', 'integer', 'boolean', 'day', 'instant')`,
    ),
    index('audit_scalar_changes_event_idx').on(t.eventId),
  ],
);

// Field CATEGORY only. Never the old or new value, in any encoding — this table
// is what lets the ledger say "her name changed" after redaction has made it
// unable to say what the name was.
export const auditSensitiveFieldChanges = sqliteTable(
  'audit_sensitive_field_changes',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => auditEvents.id, { onDelete: 'restrict' }),
    fieldCategory: text('field_category', {
      enum: ['person_name', 'lot_address', 'email', 'phone', 'free_text'],
    }).notNull(),
  },
  (t) => [
    check(
      'audit_sensitive_field_changes_category_check',
      sql`"field_category" IN ('person_name', 'lot_address', 'email', 'phone', 'free_text')`,
    ),
    index('audit_sensitive_field_changes_event_idx').on(t.eventId),
  ],
);

// ---------------------------------------------------------------------------
// Review flags
// ---------------------------------------------------------------------------

// A durable current projection, changed only atomically with its Review Event.
// A flag NEVER rewrites or automatically invalidates the action it references.
//
// Ballot secrecy: a flag may reference the identity-linked turnout Ballot and
// the election occasion, and nothing else. No flag, event, correlation, export,
// or log may reference `ballot_choices` or candidate selection.
//
// Categories are for discrete past events a human should look at once.
// Continuous states — board composition outside three-to-five, Ownerless
// Lots — are live-derived advisories, deliberately NOT flags, because a state
// an unrelated later action silently fixes leaves a graveyard of open rows.
export const reviewFlags = sqliteTable(
  'review_flags',
  {
    id: text('id').primaryKey(),
    category: text('category', {
      enum: [
        'intervening_action_backdated',
        'authority_lost_pending_occasion',
        'vote_reset_on_transfer',
        'ballot_final_after_transfer',
      ],
    }).notNull(),
    sourceEventId: text('source_event_id')
      .notNull()
      .references(() => auditEvents.id, { onDelete: 'restrict' }),
    status: text('status', { enum: ['open', 'resolved'] })
      .notNull()
      .default('open'),
    openedAt: instant('opened_at').notNull(),
    resolvedAt: instant('resolved_at'),
    resolutionCode: text('resolution_code', {
      enum: ['remediated', 'confirmed_valid', 'no_effect', 'superseded'],
    }),
    // At most one typed impacted action. The four legacy-record references
    // are SET NULL, not RESTRICT: proxy deletion IS the revocation model, and
    // setMemberAttendance/setMemberVotes/setBallots are full-replacement
    // corrections — the board's own remedy per #204 — so a flag must never
    // freeze the record it points at. When the referenced row goes, the flag
    // survives with its source event and ledger context, impact unset. The
    // remaining references stay RESTRICT because their parents are already
    // undeletable while a flag could exist (a motion with live-voting history
    // refuses deletion; terms, grants, and ledger events are never deleted).
    impactedProxyId: text('impacted_proxy_id').references(() => proxies.id, {
      onDelete: 'set null',
    }),
    impactedMemberAttendanceId: text(
      'impacted_member_attendance_id',
    ).references(() => memberAttendance.id, { onDelete: 'set null' }),
    impactedMemberVoteId: text('impacted_member_vote_id').references(
      () => memberVotes.id,
      { onDelete: 'set null' },
    ),
    // Phase 3d (#220): a vote_reset_on_transfer flag names the MOTION whose
    // vote was reset — the deleted member_votes row cannot be referenced, and
    // the queue row must answer "what was reset?" directly. RESTRICT is safe:
    // motion deletion already refuses while live-voting history exists.
    impactedMotionId: text('impacted_motion_id').references(() => motions.id, {
      onDelete: 'restrict',
    }),
    impactedBallotId: text('impacted_ballot_id').references(() => ballots.id, {
      onDelete: 'set null',
    }),
    impactedBoardTermId: text('impacted_board_term_id').references(
      () => boardServiceTerms.id,
      { onDelete: 'restrict' },
    ),
    impactedAccessGrantId: text('impacted_access_grant_id').references(
      () => accessGrants.id,
      { onDelete: 'restrict' },
    ),
    impactedEventId: text('impacted_event_id').references(
      () => auditEvents.id,
      { onDelete: 'restrict' },
    ),
  },
  (t) => [
    check(
      'review_flags_category_check',
      sql`"category" IN ('intervening_action_backdated', 'authority_lost_pending_occasion', 'vote_reset_on_transfer', 'ballot_final_after_transfer')`,
    ),
    check('review_flags_status_check', sql`"status" IN ('open', 'resolved')`),
    check(
      'review_flags_resolution_paired',
      sql`("status" = 'resolved') = ("resolved_at" IS NOT NULL)`,
    ),
    check(
      'review_flags_impact_at_most_one',
      sql`(CASE WHEN "impacted_proxy_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "impacted_member_attendance_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "impacted_member_vote_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "impacted_motion_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "impacted_ballot_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "impacted_board_term_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "impacted_access_grant_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "impacted_event_id" IS NULL THEN 0 ELSE 1 END) <= 1`,
    ),
    index('review_flags_open_idx').on(t.status, t.openedAt),
    index('review_flags_source_idx').on(t.sourceEventId),
  ],
);

// ---------------------------------------------------------------------------
// Redaction cleanup
// ---------------------------------------------------------------------------

// IDs and checked codes only. Every derived store must be purgeable by durable
// source ID — a derivative searchable only by raw value is prohibited.
// Completed rows may expire under operational retention because the permanent
// evidence lives in the ledger.
export const redactionTasks = sqliteTable(
  'redaction_tasks',
  {
    id: text('id').primaryKey(),
    redactionEventId: text('redaction_event_id')
      .notNull()
      .references(() => auditEvents.id, { onDelete: 'restrict' }),
    targetKind: text('target_kind', {
      enum: [
        'rag_corpus',
        'ai_search_index',
        'pseudonymizer_catalog',
        'export_cache',
      ],
    }).notNull(),
    targetIdentifier: text('target_identifier').notNull(),
    status: text('status', {
      enum: ['pending', 'succeeded', 'failed'],
    })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastErrorCode: text('last_error_code'),
    createdAt: instant('created_at').notNull(),
    completedAt: instant('completed_at'),
  },
  (t) => [
    check(
      'redaction_tasks_target_kind_check',
      sql`"target_kind" IN ('rag_corpus', 'ai_search_index', 'pseudonymizer_catalog', 'export_cache')`,
    ),
    check(
      'redaction_tasks_status_check',
      sql`"status" IN ('pending', 'succeeded', 'failed')`,
    ),
    // Retries are idempotent on the event, kind, and target.
    uniqueIndex('redaction_tasks_target_unq').on(
      t.redactionEventId,
      t.targetKind,
      t.targetIdentifier,
    ),
    index('redaction_tasks_status_idx').on(t.status),
  ],
);
