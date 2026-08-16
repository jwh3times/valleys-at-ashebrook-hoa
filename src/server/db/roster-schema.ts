import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  foreignKey,
  primaryKey,
  check,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './auth-schema';
import { properties, elections } from './schema';

// The ADR 0022 party roster: durable Lots, parties, relationships, and access.
//
// PHASE 1 ("expand") of the migration. Nothing in the application reads these
// tables yet — see the phase tickets on issue #195. Two naming rules are
// load-bearing and deliberately ugly until phase 4:
//
//  1. There is no `lots` table. The Lot *is* `properties`, which already holds
//     every Lot with its identity intact; nine tables reference
//     `properties.id`, and rebuilding all nine to change a name is exactly
//     where this repo's drizzle FK trap bites. `lot_id` columns below therefore
//     reference `properties.id`, and the physical rename waits for phase 4.
//     The consequence is a feature, not a compromise: there is no Lot backfill.
//
//  2. Board service lives in `board_service_terms`, not `board_terms`. The
//     legacy `board_terms` table still exists with a different shape, and every
//     statement in this phase's migrations is `IF NOT EXISTS` — so a create
//     under the real name would silently do nothing and surface much later as
//     confusing column errors. Renamed in phase 4 once the legacy table drops.
//
// Instants are millisecond integers (matching the Better Auth tables rather
// than the legacy app tables' seconds), and Association Days are ISO
// `YYYY-MM-DD` text. Intervals are inclusive-start, exclusive-end.

const day = (name: string) => text(name);
const instant = (name: string) => integer(name, { mode: 'timestamp_ms' });

/** `end > start` when both endpoints are known. NULL on either side passes. */
const intervalOrdered = (start: string, end: string) =>
  sql.raw(`("${end}" IS NULL OR "${start}" IS NULL OR "${end}" > "${start}")`);

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

// A Party is a Person or an Organization. The subtype tables carry the real
// attributes; this table carries identity and the discriminator.
//
// SQLite cannot enforce the parent-to-child direction (a Party must have
// exactly one subtype row), so creation happens in one checked D1 batch and
// `verify-invariants.ts` checks the population. The child-to-parent direction
// *is* enforced, by the composite FK on each subtype: a `people` row can only
// point at a Party whose kind is already 'person'.
export const parties = sqliteTable(
  'parties',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['person', 'organization'] }).notNull(),
    // A duplicate keeps its row and points at the survivor. Historical
    // references are never rewritten; reads canonicalize one hop. Cleared by
    // an audited correction if the consolidation was wrong.
    consolidatedIntoPartyId: text('consolidated_into_party_id').references(
      (): AnySQLiteColumn => parties.id,
      { onDelete: 'restrict' },
    ),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (t) => [
    check('parties_kind_check', sql`"kind" IN ('person', 'organization')`),
    // No self-consolidation. Cycles, cross-kind targets, and chains longer
    // than one hop are transactional checks — SQLite cannot express them.
    check(
      'parties_no_self_consolidation',
      sql`"consolidated_into_party_id" IS NULL OR "consolidated_into_party_id" <> "id"`,
    ),
    // Lets each subtype's composite FK pin the discriminator.
    uniqueIndex('parties_id_kind_unq').on(t.id, t.kind),
    index('parties_consolidated_into_idx').on(t.consolidatedIntoPartyId),
  ],
);

export const people = sqliteTable(
  'people',
  {
    partyId: text('party_id')
      .primaryKey()
      .references(() => parties.id, { onDelete: 'restrict' }),
    // Literal discriminator, checked, so the composite FK below can only
    // resolve to a Party of kind 'person'.
    partyKind: text('party_kind').notNull().default('person'),
    // Nullable only under Roster Redaction, which stamps the marker in the
    // same mutation. Reads render a durable-ID fallback — identical for every
    // viewer, board included.
    fullName: text('full_name'),
    nameNormalized: text('name_normalized'),
    nameRedactedAt: instant('name_redacted_at'),
    updatedAt: instant('updated_at').notNull(),
  },
  (t) => [
    check('people_party_kind_check', sql`"party_kind" = 'person'`),
    // A name may only be absent alongside its redaction marker.
    check(
      'people_name_redaction_paired',
      sql`("full_name" IS NULL) = ("name_redacted_at" IS NOT NULL)`,
    ),
    foreignKey({
      columns: [t.partyId, t.partyKind],
      foreignColumns: [parties.id, parties.kind],
      name: 'people_party_kind_fk',
    }).onDelete('restrict'),
    index('people_name_normalized_idx').on(t.nameNormalized),
  ],
);

// Organization names are required and stay outside redaction: an entity has no
// privacy interest of the kind Roster Redaction exists to serve.
export const organizations = sqliteTable(
  'organizations',
  {
    partyId: text('party_id')
      .primaryKey()
      .references(() => parties.id, { onDelete: 'restrict' }),
    partyKind: text('party_kind').notNull().default('organization'),
    legalName: text('legal_name').notNull(),
    displayName: text('display_name'),
    nameNormalized: text('name_normalized').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (t) => [
    check('organizations_party_kind_check', sql`"party_kind" = 'organization'`),
    foreignKey({
      columns: [t.partyId, t.partyKind],
      foreignColumns: [parties.id, parties.kind],
      name: 'organizations_party_kind_fk',
    }).onDelete('restrict'),
    // Deliberately NOT unique: "The Smith Family Trust" can legitimately
    // recur, and uniqueness would force a false merge exactly where an audited
    // human decision belongs. Collisions warn at creation instead.
    index('organizations_name_normalized_idx').on(t.nameNormalized),
  ],
);

// ---------------------------------------------------------------------------
// Contact Methods
// ---------------------------------------------------------------------------

// A contact supports Automatic Person Verification only when it is current,
// unredacted, and *uniquely attributable* — its (channel, value_normalized)
// pair belongs to exactly one Party across the whole roster. A household email
// shared by two owners disqualifies both, which is what
// `contact_methods_lookup_idx` exists to make cheap.
export const contactMethods = sqliteTable(
  'contact_methods',
  {
    id: text('id').primaryKey(),
    partyId: text('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'restrict' }),
    // Denormalized discriminator, kept honest by the composite FK below, so
    // that `person_verifications` can structurally require a PERSON's contact
    // (#202): an Organization's contact id can never satisfy a composite
    // reference to (id, 'person'). Migration 0026 rebuilt the table for this.
    partyKind: text('party_kind', {
      enum: ['person', 'organization'],
    }).notNull(),
    channel: text('channel', { enum: ['email', 'sms'] }).notNull(),
    value: text('value'),
    valueNormalized: text('value_normalized'),
    isPreferred: integer('is_preferred', { mode: 'boolean' })
      .notNull()
      .default(false),
    // NULL start is permitted only for accepted legacy facts whose day cannot
    // be established.
    startDay: day('start_day'),
    endDay: day('end_day'),
    redactedAt: instant('redacted_at'),
    voidedAt: instant('voided_at'),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (t) => [
    check('contact_methods_channel_check', sql`"channel" IN ('email', 'sms')`),
    check(
      'contact_methods_party_kind_check',
      sql`"party_kind" IN ('person', 'organization')`,
    ),
    foreignKey({
      columns: [t.partyId, t.partyKind],
      foreignColumns: [parties.id, parties.kind],
      name: 'contact_methods_party_kind_fk',
    }).onDelete('restrict'),
    // The composite-FK target for `person_verifications`' person-only contact
    // reference.
    uniqueIndex('contact_methods_id_kind_unq').on(t.id, t.partyKind),
    check(
      'contact_methods_interval_ordered',
      intervalOrdered('start_day', 'end_day'),
    ),
    check(
      'contact_methods_value_redaction_paired',
      sql`("value" IS NULL) = ("redacted_at" IS NOT NULL)`,
    ),
    check(
      'contact_methods_normalized_paired',
      sql`("value" IS NULL) = ("value_normalized" IS NULL)`,
    ),
    // At most one preferred value per party per channel, among live rows.
    uniqueIndex('contact_methods_preferred_unq')
      .on(t.partyId, t.channel)
      .where(
        sql`"is_preferred" = 1 AND "end_day" IS NULL AND "voided_at" IS NULL`,
      ),
    // Ambiguity-aware verification reads this.
    index('contact_methods_lookup_idx').on(t.channel, t.valueNormalized),
    index('contact_methods_party_idx').on(t.partyId),
  ],
);

// ---------------------------------------------------------------------------
// Ownership and Representation
// ---------------------------------------------------------------------------

// A Person or Organization owns a Lot for a period. Non-proportional: no
// percentage, no legal subtype. Co-owners hold equal Lot Authority.
//
// `lot_id` references `properties.id` — see the naming note at the top.
export const ownerships = sqliteTable(
  'ownerships',
  {
    id: text('id').primaryKey(),
    ownerPartyId: text('owner_party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'restrict' }),
    lotId: text('lot_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    // NULL only for accepted legacy history, read as negative infinity.
    // Anticipated starts are prohibited; so are anticipated *ends*, since a
    // closing can fall through and pre-recording it would strip authority
    // early. (Representation differs — see below.)
    startDay: day('start_day'),
    endDay: day('end_day'),
    voidedAt: instant('voided_at'),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (t) => [
    check(
      'ownerships_interval_ordered',
      intervalOrdered('start_day', 'end_day'),
    ),
    // One live Ownership per party per Lot. Interval *overlap* across ended
    // rows is a transactional check; a partial index cannot express it.
    uniqueIndex('ownerships_current_unq')
      .on(t.ownerPartyId, t.lotId)
      .where(sql`"end_day" IS NULL AND "voided_at" IS NULL`),
    index('ownerships_lot_idx').on(t.lotId),
    index('ownerships_party_idx').on(t.ownerPartyId),
  ],
);

// A Person acts for an Organization without becoming an Owner. Never
// entity-to-entity: `representative_person_id` resolves to the Person subtype,
// so a chain of corporate agents is structurally impossible. When a management
// company acts for an owning LLC, the recorded Representative is the human
// agent, with the inter-entity agreement as the Roster Change's evidence.
export const representations = sqliteTable(
  'representations',
  {
    id: text('id').primaryKey(),
    representativePersonId: text('representative_person_id')
      .notNull()
      .references(() => people.partyId, { onDelete: 'restrict' }),
    organizationPartyId: text('organization_party_id')
      .notNull()
      .references(() => organizations.partyId, { onDelete: 'restrict' }),
    // 'organization' follows whatever the entity owns, now and later;
    // 'lots' names Lots explicitly and never grows. That asymmetry is the
    // definition of the two scopes, not an implementation detail.
    scopeKind: text('scope_kind', { enum: ['organization', 'lots'] }).notNull(),
    startDay: day('start_day').notNull(),
    // MAY be future-dated, unlike an Ownership end: a management agreement has
    // a written term, and a Representation the system retires on schedule is
    // safer than one running until somebody remembers.
    endDay: day('end_day'),
    voidedAt: instant('voided_at'),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (t) => [
    check(
      'representations_scope_kind_check',
      sql`"scope_kind" IN ('organization', 'lots')`,
    ),
    check(
      'representations_interval_ordered',
      intervalOrdered('start_day', 'end_day'),
    ),
    // At most one effective Representation per Person per Organization.
    // Different Representatives of one Organization may coexist with equal
    // authority within their scopes.
    uniqueIndex('representations_current_unq')
      .on(t.representativePersonId, t.organizationPartyId)
      .where(sql`"end_day" IS NULL AND "voided_at" IS NULL`),
    index('representations_organization_idx').on(t.organizationPartyId),
    index('representations_person_idx').on(t.representativePersonId),
  ],
);

// Scope rows for `scope_kind = 'lots'`. Retained and voided on correction,
// never deleted. Authority independently re-checks the Organization's Current
// Ownership at use time, so a scoped Lot the entity has since sold grants
// nothing.
export const representationLots = sqliteTable(
  'representation_lots',
  {
    representationId: text('representation_id')
      .notNull()
      .references(() => representations.id, { onDelete: 'cascade' }),
    lotId: text('lot_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    voidedAt: instant('voided_at'),
    createdAt: instant('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.representationId, t.lotId] }),
    index('representation_lots_lot_idx').on(t.lotId),
  ],
);

// ---------------------------------------------------------------------------
// Identity: verification and links
// ---------------------------------------------------------------------------

// The durable proof, separate from the Person Link it authorizes.
//
// `account_id` always means the Better Auth `user` row — never its
// credential-oriented `account` table.
export const personVerifications = sqliteTable(
  'person_verifications',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    personId: text('person_id')
      .notNull()
      .references(() => people.partyId, { onDelete: 'restrict' }),
    method: text('method', {
      enum: ['otp_email', 'otp_sms', 'manual', 'bootstrap'],
    }).notNull(),
    // Automatic proof references the uniquely-attributable contact it used.
    // The pair below is a composite FK against contact_methods(id, party_kind)
    // with the kind pinned to 'person', so an Organization's Contact Method
    // can never verify a Person — structural, not conventional (#202).
    contactMethodId: text('contact_method_id'),
    contactMethodPartyKind: text('contact_method_party_kind'),
    approverAccountId: text('approver_account_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    // A checked reason code, never free text — immutable histories carry codes
    // and reference narrative, they do not store it.
    reason: text('reason', {
      enum: [
        'automatic_contact_proof',
        'manual_board_decision',
        'migration_reverification',
        'bootstrap_first_administrator',
      ],
    }),
    verifiedAt: instant('verified_at').notNull(),
  },
  (t) => [
    check(
      'person_verifications_method_check',
      sql`"method" IN ('otp_email', 'otp_sms', 'manual', 'bootstrap')`,
    ),
    check(
      'person_verifications_reason_check',
      sql`"reason" IS NULL OR "reason" IN ('automatic_contact_proof', 'manual_board_decision', 'migration_reverification', 'bootstrap_first_administrator')`,
    ),
    // Automatic proof requires the contact it proved and no approver; manual
    // requires an approver and a reason.
    check(
      'person_verifications_automatic_shape',
      sql`"method" NOT IN ('otp_email', 'otp_sms') OR ("contact_method_id" IS NOT NULL AND "approver_account_id" IS NULL)`,
    ),
    check(
      'person_verifications_manual_shape',
      sql`"method" <> 'manual' OR ("approver_account_id" IS NOT NULL AND "reason" IS NOT NULL)`,
    ),
    // Bootstrap proves nothing by contact and answers to no approver; its
    // reason is fixed. Closes the shape gap the two checks above leave open.
    check(
      'person_verifications_bootstrap_shape',
      sql`"method" <> 'bootstrap' OR ("contact_method_id" IS NULL AND "approver_account_id" IS NULL AND "reason" = 'bootstrap_first_administrator')`,
    ),
    // The person-only contact reference (#202): kind travels with the id and
    // is pinned to 'person', and the composite FK makes a mismatched pair
    // unrecordable.
    check(
      'person_verifications_contact_person_only',
      sql`"contact_method_party_kind" IS NULL OR "contact_method_party_kind" = 'person'`,
    ),
    check(
      'person_verifications_contact_kind_paired',
      sql`("contact_method_id" IS NULL) = ("contact_method_party_kind" IS NULL)`,
    ),
    foreignKey({
      columns: [t.contactMethodId, t.contactMethodPartyKind],
      foreignColumns: [contactMethods.id, contactMethods.partyKind],
      name: 'person_verifications_contact_person_fk',
    }).onDelete('restrict'),
    index('person_verifications_person_idx').on(t.personId),
    index('person_verifications_account_idx').on(t.accountId),
  ],
);

// An Account represents a Person for a period. Instants, not Association Days:
// links begin when recorded and can be neither scheduled nor backdated.
export const personLinks = sqliteTable(
  'person_links',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    personId: text('person_id')
      .notNull()
      .references(() => people.partyId, { onDelete: 'restrict' }),
    verificationId: text('verification_id')
      .notNull()
      .references(() => personVerifications.id, { onDelete: 'restrict' }),
    startedAt: instant('started_at').notNull(),
    endedAt: instant('ended_at'),
    endedByAccountId: text('ended_by_account_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    // Self-unlink needs no reason; an administrator ending someone else's link
    // must give one.
    endReason: text('end_reason', {
      enum: [
        'self_unlink',
        'account_replaced',
        'no_longer_qualifies',
        'suspected_compromise',
        'recorded_in_error',
        'resident_request',
      ],
    }),
  },
  (t) => [
    check(
      'person_links_end_reason_check',
      sql`"end_reason" IS NULL OR "end_reason" IN ('self_unlink', 'account_replaced', 'no_longer_qualifies', 'suspected_compromise', 'recorded_in_error', 'resident_request')`,
    ),
    check(
      'person_links_interval_ordered',
      sql`"ended_at" IS NULL OR "ended_at" > "started_at"`,
    ),
    check(
      'person_links_end_fields_paired',
      sql`"ended_at" IS NOT NULL OR ("ended_by_account_id" IS NULL AND "end_reason" IS NULL)`,
    ),
    // One verification authorizes exactly one link.
    uniqueIndex('person_links_verification_unq').on(t.verificationId),
    // At most one current link per Account, and independently per Person.
    uniqueIndex('person_links_account_current_unq')
      .on(t.accountId)
      .where(sql`"ended_at" IS NULL`),
    uniqueIndex('person_links_person_current_unq')
      .on(t.personId)
      .where(sql`"ended_at" IS NULL`),
  ],
);

// ---------------------------------------------------------------------------
// Board service
// ---------------------------------------------------------------------------

// NOTE THE TABLE NAME. See rule 2 in the header comment: this becomes
// `board_terms` in phase 4, once the legacy table of that name is dropped.
//
// Three disjoint ending kinds, which behave differently and must not be
// conflated:
//   ended     — `actual_end_day`. Real service, real early end.
//   cancelled — `cancelled_day`/`cancelled_at`. Authorized, withdrawn before
//               the start day; no service ever occurred.
//   voided    — `voided_at`. Recorded in error, never a fact. Excluded from
//               composition counts, overlap checks, and every derivation.
export const boardServiceTerms = sqliteTable(
  'board_service_terms',
  {
    id: text('id').primaryKey(),
    personId: text('person_id')
      .notNull()
      .references(() => people.partyId, { onDelete: 'restrict' }),
    // NULL permitted only for accepted legacy terms that have already ended —
    // legacy recorded no qualifying Lot. A current term always names one.
    qualifyingLotId: text('qualifying_lot_id').references(() => properties.id, {
      onDelete: 'restrict',
    }),
    // Which election produced this term, when one did. Created with the table,
    // so this delete action is real — unlike the legacy `board_terms`
    // equivalent, which was ALTER-added and silently lost its action.
    electionId: text('election_id').references(() => elections.id, {
      onDelete: 'set null',
    }),
    startDay: day('start_day').notNull(),
    // Required and exclusive. The bylaws run terms to the following annual
    // meeting and contain no holdover clause, so a term lapses here; continued
    // service is recorded as a new adjacent term.
    scheduledEndDay: day('scheduled_end_day').notNull(),
    actualEndDay: day('actual_end_day'),
    cancelledDay: day('cancelled_day'),
    cancelledAt: instant('cancelled_at'),
    voidedAt: instant('voided_at'),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (t) => [
    check(
      'board_service_terms_scheduled_ordered',
      sql`"scheduled_end_day" > "start_day"`,
    ),
    // An ending equal to the start day is a cancellation, not a one-day term.
    check(
      'board_service_terms_actual_end_ordered',
      sql`"actual_end_day" IS NULL OR "actual_end_day" > "start_day"`,
    ),
    // A withdrawal after service began is an early end, not a cancellation.
    check(
      'board_service_terms_cancelled_before_start',
      sql`"cancelled_day" IS NULL OR "cancelled_day" < "start_day"`,
    ),
    check(
      'board_service_terms_cancellation_paired',
      sql`("cancelled_day" IS NULL) = ("cancelled_at" IS NULL)`,
    ),
    // The three ending kinds are mutually exclusive.
    check(
      'board_service_terms_one_ending',
      sql`(CASE WHEN "actual_end_day" IS NULL THEN 0 ELSE 1 END + CASE WHEN "cancelled_at" IS NULL THEN 0 ELSE 1 END + CASE WHEN "voided_at" IS NULL THEN 0 ELSE 1 END) <= 1`,
    ),
    // Lets an Office Assignment's composite FK pin term-and-person together.
    uniqueIndex('board_service_terms_id_person_unq').on(t.id, t.personId),
    // Non-overlap per Person and per qualifying Lot is a transactional check:
    // every term has a mandatory scheduled end, so there is no `end IS NULL`
    // predicate to index, and a partial index cannot express interval overlap.
    // These make the overlap probe cheap.
    index('board_service_terms_person_start_idx').on(t.personId, t.startDay),
    index('board_service_terms_lot_start_idx').on(
      t.qualifyingLotId,
      t.startDay,
    ),
  ],
);

// President, Vice President, Secretary/Treasurer — the offices the bylaws
// actually create (Art. V §1). Secretary and Treasurer are ONE combined
// office; the bylaws describe their duties separately but create them as one.
// Fourth and fifth members serve without an office.
//
// An assignment belongs to a single term and never carries across into a later
// one: the Board appoints its own officers, so a renewed term needs a fresh
// appointment.
export const boardOfficeAssignments = sqliteTable(
  'board_office_assignments',
  {
    id: text('id').primaryKey(),
    boardTermId: text('board_term_id')
      .notNull()
      .references(() => boardServiceTerms.id, { onDelete: 'restrict' }),
    // Duplicated from the term so the overlap indexes below can be direct.
    // The composite FK keeps the pair honest.
    personId: text('person_id')
      .notNull()
      .references(() => people.partyId, { onDelete: 'restrict' }),
    office: text('office', {
      enum: ['president', 'vice_president', 'secretary_treasurer'],
    }).notNull(),
    startDay: day('start_day').notNull(),
    endDay: day('end_day'),
    voidedAt: instant('voided_at'),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (t) => [
    check(
      'board_office_assignments_office_check',
      sql`"office" IN ('president', 'vice_president', 'secretary_treasurer')`,
    ),
    check(
      'board_office_assignments_interval_ordered',
      intervalOrdered('start_day', 'end_day'),
    ),
    foreignKey({
      columns: [t.boardTermId, t.personId],
      foreignColumns: [boardServiceTerms.id, boardServiceTerms.personId],
      name: 'board_office_assignments_term_person_fk',
    }).onDelete('restrict'),
    // Hard constraints: one current holder per office, and at most one office
    // per Board Member at a time.
    uniqueIndex('board_office_assignments_office_current_unq')
      .on(t.office)
      .where(sql`"end_day" IS NULL AND "voided_at" IS NULL`),
    uniqueIndex('board_office_assignments_person_current_unq')
      .on(t.personId)
      .where(sql`"end_day" IS NULL AND "voided_at" IS NULL`),
    index('board_office_assignments_term_idx').on(t.boardTermId),
  ],
);

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

// Board and System Administration Access are *stored* grants; Member Access is
// derived from Ownership and Representation and has no row here.
//
// Evaluation re-validates a grant's precondition rather than trusting the write
// path — the mirror of this repo's discipline of re-checking inside mutation
// SQL. A System Administration grant has no qualifying term and implies every
// Board capability without a duplicate grant.
export const accessGrants = sqliteTable(
  'access_grants',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    grantType: text('grant_type', {
      enum: ['board', 'system_admin'],
    }).notNull(),
    qualifyingBoardTermId: text('qualifying_board_term_id').references(
      () => boardServiceTerms.id,
      { onDelete: 'restrict' },
    ),
    startedAt: instant('started_at').notNull(),
    endedAt: instant('ended_at'),
    grantedByAccountId: text('granted_by_account_id').references(
      () => users.id,
      { onDelete: 'restrict' },
    ),
    grantReason: text('grant_reason', {
      enum: ['board_service', 'technical_administration', 'bootstrap'],
    }),
    endedByAccountId: text('ended_by_account_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    endReason: text('end_reason', {
      enum: [
        'term_ended',
        'term_cancelled',
        'person_link_ended',
        'revoked',
        'recorded_in_error',
      ],
    }),
  },
  (t) => [
    check(
      'access_grants_grant_type_check',
      sql`"grant_type" IN ('board', 'system_admin')`,
    ),
    // A Board grant hangs off its qualifying term; a System Administration
    // grant never does.
    check(
      'access_grants_qualifying_term_shape',
      sql`("grant_type" = 'board') = ("qualifying_board_term_id" IS NOT NULL)`,
    ),
    check(
      'access_grants_interval_ordered',
      sql`"ended_at" IS NULL OR "ended_at" > "started_at"`,
    ),
    check(
      'access_grants_end_fields_paired',
      sql`"ended_at" IS NOT NULL OR ("ended_by_account_id" IS NULL AND "end_reason" IS NULL)`,
    ),
    // One live grant per account per type.
    uniqueIndex('access_grants_current_unq')
      .on(t.accountId, t.grantType)
      .where(sql`"ended_at" IS NULL`),
    index('access_grants_term_idx').on(t.qualifyingBoardTermId),
  ],
);

// Durable singleton recording that the one-time bootstrap has been consumed.
// Bootstrap CREATES the first System Administrator's Person Link rather than
// requiring one — the circularity is escaped, not routed around — and the
// verification row, link, grant, and this consumption commit in one batch.
export const systemAdminBootstrap = sqliteTable(
  'system_admin_bootstrap',
  {
    singletonKey: text('singleton_key').primaryKey().default('singleton'),
    consumedAt: instant('consumed_at').notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    accessGrantId: text('access_grant_id')
      .notNull()
      .references(() => accessGrants.id, { onDelete: 'restrict' }),
  },
  () => [
    check(
      'system_admin_bootstrap_singleton',
      sql`"singleton_key" = 'singleton'`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Member correction requests
// ---------------------------------------------------------------------------

// Operational and finite-lived, NOT part of the immutable history (#205):
// members submit requests, never facts. `proposed_value` and `note` are free
// text that must never be copied into any ledger table — acceptance is an
// ordinary board Roster Change whose evidence cites this row's id as an opaque
// `evidence_request_id` locator, and the accepted fact, not the request, is
// what the ledger records. A declined or withdrawn request leaves no ledger
// trace at all.
export const correctionRequests = sqliteTable(
  'correction_requests',
  {
    id: text('id').primaryKey(),
    // The submitting Account and its then-linked Person, both pinned at
    // submission so a later re-link cannot repoint an open request.
    accountId: text('account_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    personId: text('person_id')
      .notNull()
      .references(() => people.partyId, { onDelete: 'restrict' }),
    // Own name or own Contact Methods only — never Ownership, Representation,
    // Lots, or anyone else's data.
    kind: text('kind', { enum: ['name', 'contact_method'] }).notNull(),
    // For `contact_method`: the existing method being corrected, or NULL to
    // propose adding a new one — in which case `channel` says what kind of
    // value `proposed_value` is. TS-enforced only (added by ALTER, where
    // SQLite cannot attach a CHECK): non-null exactly when kind is
    // `contact_method` with no target method.
    contactMethodId: text('contact_method_id').references(
      () => contactMethods.id,
      { onDelete: 'restrict' },
    ),
    channel: text('channel', { enum: ['email', 'sms'] }),
    proposedValue: text('proposed_value').notNull(),
    note: text('note'),
    status: text('status', {
      enum: ['open', 'accepted', 'declined', 'withdrawn'],
    })
      .notNull()
      .default('open'),
    createdAt: instant('created_at').notNull(),
    decidedAt: instant('decided_at'),
    // The board decider, or the member themself for a withdrawal.
    decidedByAccountId: text('decided_by_account_id').references(
      () => users.id,
      { onDelete: 'restrict' },
    ),
  },
  (t) => [
    check(
      'correction_requests_kind_check',
      sql`"kind" IN ('name', 'contact_method')`,
    ),
    check(
      'correction_requests_status_check',
      sql`"status" IN ('open', 'accepted', 'declined', 'withdrawn')`,
    ),
    // Open requests carry no decision; decided ones carry the instant and who.
    check(
      'correction_requests_decision_paired',
      sql`("status" = 'open') = ("decided_at" IS NULL)`,
    ),
    check(
      'correction_requests_decider_paired',
      sql`("decided_at" IS NULL) = ("decided_by_account_id" IS NULL)`,
    ),
    // Only a Contact Method request may target a Contact Method row.
    check(
      'correction_requests_contact_target_shape',
      sql`"kind" = 'contact_method' OR "contact_method_id" IS NULL`,
    ),
    index('correction_requests_status_idx').on(t.status),
    index('correction_requests_person_idx').on(t.personId),
  ],
);

// ---------------------------------------------------------------------------
// Person Verification operational tables (#219)
// ---------------------------------------------------------------------------

// A pending Automatic Person Verification code: the matched Person, the
// contact the code went to, and the claimed Lot, remembered between request
// and confirm. Operational and short-lived (the cleanup job sweeps consumed
// and expired rows); the durable record is `person_verifications`, written
// only on a successful confirm. Attempts count here because D1 increments are
// atomic where KV read-modify-write is not.
export const verificationCodes = sqliteTable(
  'verification_codes',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .notNull()
      .references(() => people.partyId, { onDelete: 'restrict' }),
    contactMethodId: text('contact_method_id')
      .notNull()
      .references(() => contactMethods.id, { onDelete: 'restrict' }),
    lotId: text('lot_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    channel: text('channel', { enum: ['email', 'sms'] }).notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: instant('expires_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: instant('consumed_at'),
    createdAt: instant('created_at').notNull(),
  },
  (t) => [
    check(
      'verification_codes_channel_check',
      sql`"channel" IN ('email', 'sms')`,
    ),
    index('verification_codes_account_idx').on(t.accountId),
    index('verification_codes_expires_idx').on(t.expiresAt),
  ],
);

// A verification review request. Created ONLY by an explicit applicant action
// (#201 — nothing auto-queues), with the single exception of the
// person-already-linked collision, which #201 routes to manual review under an
// internal reason code the applicant never sees. Operational and finite-lived:
// `claimed_address`/`claimed_name` are applicant free text that must never
// enter the ledger — a board acceptance is a Manual Person Verification whose
// Identity Event cites this row's id as opaque evidence, and a decline's
// Identity Event carries only the reason code and target account.
export const verificationReviewRequests = sqliteTable(
  'verification_review_requests',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    claimedAddress: text('claimed_address').notNull(),
    claimedName: text('claimed_name').notNull(),
    channel: text('channel', { enum: ['email', 'sms'] }),
    internalReason: text('internal_reason', {
      enum: ['applicant_requested', 'person_already_linked'],
    }).notNull(),
    status: text('status', { enum: ['open', 'accepted', 'declined'] })
      .notNull()
      .default('open'),
    createdAt: instant('created_at').notNull(),
    resolvedAt: instant('resolved_at'),
    resolvedByAccountId: text('resolved_by_account_id').references(
      () => users.id,
      { onDelete: 'restrict' },
    ),
  },
  (t) => [
    check(
      'verification_review_requests_internal_reason_check',
      sql`"internal_reason" IN ('applicant_requested', 'person_already_linked')`,
    ),
    check(
      'verification_review_requests_status_check',
      sql`"status" IN ('open', 'accepted', 'declined')`,
    ),
    check(
      'verification_review_requests_resolution_paired',
      sql`("status" = 'open') = ("resolved_at" IS NULL)`,
    ),
    check(
      'verification_review_requests_resolver_paired',
      sql`("resolved_at" IS NULL) = ("resolved_by_account_id" IS NULL)`,
    ),
    // One open request per account — the queue-flooding control.
    uniqueIndex('verification_review_requests_open_unq')
      .on(t.accountId)
      .where(sql`"status" = 'open'`),
    index('verification_review_requests_status_idx').on(t.status),
  ],
);
