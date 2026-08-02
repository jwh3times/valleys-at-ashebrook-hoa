import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/sqlite-core';
import { users } from './auth-schema';

// Re-export the Better-Auth-generated tables so one schema covers everything.
export * from './auth-schema';

export const properties = sqliteTable(
  'properties',
  {
    id: text('id').primaryKey(),
    address: text('address').notNull(),
    addressNormalized: text('address_normalized').notNull(),
    unit: text('unit'),
    status: text('status', { enum: ['active', 'inactive'] })
      .notNull()
      .default('active'),
    // Votes at member meetings are per property, and associations sometimes
    // weight them by lot size or ownership share. Always present, defaulting
    // to 1, so weighted and unweighted share one code path: every tally and
    // quorum check does SUM(weight), which equals COUNT(*) when all weights
    // are 1. Integer "shares" rather than a float — floating-point tallies
    // accumulate error; fractional shares are expressed by scaling the whole
    // scheme up.
    voteWeight: integer('vote_weight').notNull().default(1),
    notes: text('notes'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  // One home per normalized address: it's the OTP verification matching key, so
  // a duplicate would make findActivePropertyByAddress pick an arbitrary row.
  (t) => [
    uniqueIndex('properties_address_normalized_unq').on(t.addressNormalized),
  ],
);

export const owners = sqliteTable(
  'owners',
  {
    id: text('id').primaryKey(),
    propertyId: text('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    fullName: text('full_name').notNull(),
    phone: text('phone'),
    email: text('email'),
    status: text('status', { enum: ['active', 'inactive'] })
      .notNull()
      .default('active'),
    notes: text('notes'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  // Owners are read per home (roster nesting, verification fan-out).
  (t) => [index('owners_property_id_idx').on(t.propertyId)],
);

export const userPropertyLinks = sqliteTable(
  'user_property_links',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    propertyId: text('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    verifiedAt: integer('verified_at', { mode: 'timestamp' }).notNull(),
    method: text('method', {
      enum: ['otp_email', 'otp_sms', 'board_manual'],
    }).notNull(),
  },
  // One link per (user, home) — re-verifying the same home must not accumulate
  // duplicate rows. Also serves the by-user lookup (getAuthContext) as the
  // leftmost-prefix of the composite, so no separate user_id index is needed.
  (t) => [
    uniqueIndex('user_property_links_user_property_unq').on(
      t.userId,
      t.propertyId,
    ),
  ],
);

export const propertyVerifications = sqliteTable(
  'property_verifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    propertyId: text('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: ['email', 'sms'] }).notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: integer('consumed_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  // The request/confirm flow reads and deletes pending codes by user.
  (t) => [index('property_verifications_user_id_idx').on(t.userId)],
);

export const manualApprovalQueue = sqliteTable(
  'manual_approval_queue',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    claimedAddress: text('claimed_address').notNull(),
    reason: text('reason').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'denied'] })
      .notNull()
      .default('pending'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  // The members panel reads the pending queue (WHERE status = 'pending').
  (t) => [index('manual_approval_queue_status_idx').on(t.status)],
);

// The board record's identity layer. A person and a term of service are
// separate rows: votes, motions, and attendance (PR 2) reference the *person*,
// so a member who serves, leaves, and returns keeps one identity and one
// voting history across both terms. Deliberately independent of Better Auth
// `user` rows — demoting a site account must not rewrite who served, and a
// member may serve with no login at all.
export const boardPeople = sqliteTable('board_people', {
  id: text('id').primaryKey(),
  fullName: text('full_name').notNull(),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const boardTerms = sqliteTable(
  'board_terms',
  {
    id: text('id').primaryKey(),
    personId: text('person_id')
      .notNull()
      // Service history is the record; deleting a person who has served is
      // refused. The route pre-checks and 409s, with this as defense in depth.
      .references(() => boardPeople.id, { onDelete: 'restrict' }),
    title: text('title'),
    // Provenance: which election produced this term. Null for a term entered
    // by hand. This is also how `uncertify` finds the terms certification
    // created.
    //
    // TRAP: this is an ALTER TABLE ADD COLUMN, and drizzle-kit emits FK
    // actions only on CREATE TABLE. The live column will get NO ACTION
    // regardless of the annotation below. Inert without deferred constraints,
    // but do not trust the annotation for this column. Pinned by a test in
    // test/server/election-schema.test.ts rather than hand-patched.
    electionId: text('election_id').references(() => elections.id, {
      onDelete: 'set null',
    }),
    termStart: text('term_start').notNull(),
    termEnd: text('term_end'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  // Terms are read per person (roster nesting); the open-term lookup is
  // "who is serving now" = WHERE term_end IS NULL.
  (t) => [
    index('board_terms_person_id_idx').on(t.personId),
    index('board_terms_term_end_idx').on(t.termEnd),
  ],
);

// A meeting of one of the association's two deliberative bodies. `body` is the
// load-bearing column: it decides which voter model applies (board members cast
// roll-call votes; members vote one per property, PR 3). `kind` is descriptive
// and orthogonal — an annual *member* meeting and a special *board* meeting are
// both real combinations.
export const meetings = sqliteTable(
  'meetings',
  {
    id: text('id').primaryKey(),
    body: text('body', { enum: ['board', 'member'] }).notNull(),
    kind: text('kind', { enum: ['regular', 'special', 'annual'] }).notNull(),
    date: text('date').notNull(),
    startTime: text('start_time'),
    location: text('location'),
    title: text('title').notNull(),
    summaryMd: text('summary_md'),
    documentId: text('document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),
    // Declared for this meeting rather than computed: quorum rules vary by body
    // and by the association's own bylaws, so the number is entered, not derived.
    quorumRequired: integer('quorum_required'),
    status: text('status', { enum: ['draft', 'approved'] })
      .notNull()
      .default('draft'),
    visibility: text('visibility', { enum: ['public', 'homeowner', 'board'] })
      .notNull()
      .default('board'),
    approvedAt: integer('approved_at', { mode: 'timestamp' }),
    approvedBy: text('approved_by'),
    // Minutes are approved by a motion at the FOLLOWING meeting. Circular
    // reference with `motions` is fine — SQLite resolves FK targets at DML time,
    // not at CREATE TABLE time, and both tables land in this migration.
    approvedByMotionId: text('approved_by_motion_id'),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  // Public reads filter on status then order by date; the admin list filters by body.
  (t) => [
    index('meetings_status_date_idx').on(t.status, t.date),
    index('meetings_body_idx').on(t.body),
  ],
);

export const boardAttendance = sqliteTable(
  'board_attendance',
  {
    id: text('id').primaryKey(),
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .notNull()
      .references(() => boardPeople.id, { onDelete: 'restrict' }),
    present: integer('present', { mode: 'boolean' }).notNull(),
  },
  // One attendance row per person per meeting; also serves the per-meeting read.
  (t) => [
    uniqueIndex('board_attendance_meeting_person_unq').on(
      t.meetingId,
      t.personId,
    ),
  ],
);

export const motions = sqliteTable(
  'motions',
  {
    id: text('id').primaryKey(),
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    text: text('text').notNull(),
    // A board meeting's mover is a board person. PR 3 adds nullable owner
    // counterparts for member meetings; the parent meeting's `body` disambiguates.
    moverPersonId: text('mover_person_id').references(() => boardPeople.id, {
      onDelete: 'restrict',
    }),
    secondPersonId: text('second_person_id').references(() => boardPeople.id, {
      onDelete: 'restrict',
    }),
    // A member meeting's mover is an owner, not a board person. The parent
    // meeting's `body` disambiguates which pair is populated, so these stay
    // nullable rather than forming a checked constraint.
    //
    // NOTE: drizzle-kit's SQLite `ALTER TABLE ADD COLUMN` generator drops the
    // `onDelete` action — only its `CREATE TABLE` path emits FK actions. The
    // migration this produced (0011) adds these two columns with a bare
    // `REFERENCES owners(id)`, so the live database enforces SQLite's default
    // `NO ACTION` here, not `RESTRICT`, even though this declaration says
    // `restrict`. Do not trust this annotation as ground truth for these two
    // columns. In practice it is behaviorally inert: every FK in this
    // codebase is non-deferred (no `PRAGMA defer_foreign_keys` anywhere), and
    // `NO ACTION` vs `RESTRICT` reject an in-use-row delete identically under
    // non-deferred constraints. That equivalence would break if deferred
    // constraints were ever introduced — see the "refuses to delete an owner
    // who moved a motion" test in member-schema.test.ts, which pins today's
    // actual (NO ACTION) behavior rather than the declared one.
    moverOwnerId: text('mover_owner_id').references(() => owners.id, {
      onDelete: 'restrict',
    }),
    secondOwnerId: text('second_owner_id').references(() => owners.id, {
      onDelete: 'restrict',
    }),
    outcome: text('outcome', {
      enum: ['passed', 'failed', 'withdrawn', 'tabled'],
    }).notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  // Motions are read per meeting in order; the unique constraint stops a partial
  // reorder from silently leaving two motions at the same position.
  (t) => [
    index('motions_meeting_id_idx').on(t.meetingId),
    uniqueIndex('motions_meeting_sequence_unq').on(t.meetingId, t.sequence),
  ],
);

export const boardVotes = sqliteTable(
  'board_votes',
  {
    id: text('id').primaryKey(),
    motionId: text('motion_id')
      .notNull()
      .references(() => motions.id, { onDelete: 'cascade' }),
    personId: text('person_id')
      .notNull()
      .references(() => boardPeople.id, { onDelete: 'restrict' }),
    choice: text('choice', {
      enum: ['yes', 'no', 'abstain', 'recused', 'absent'],
    }).notNull(),
  },
  // One vote per person per motion — re-recording a roll call must replace, not
  // accumulate. Also the leftmost prefix for the per-motion tally read.
  (t) => [
    uniqueIndex('board_votes_motion_person_unq').on(t.motionId, t.personId),
  ],
);

// Member-meeting attendance is per PROPERTY, not per person, because that is
// what quorum counts. `represented_by_owner_id` records which owner actually
// showed up when known — a sign-in sheet does not always say.
export const memberAttendance = sqliteTable(
  'member_attendance',
  {
    id: text('id').primaryKey(),
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    propertyId: text('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    present: integer('present', { mode: 'boolean' }).notNull(),
    representedByOwnerId: text('represented_by_owner_id').references(
      () => owners.id,
      { onDelete: 'set null' },
    ),
    viaProxy: integer('via_proxy', { mode: 'boolean' })
      .notNull()
      .default(false),
  },
  // One row per property per meeting — re-recording attendance replaces
  // rather than accumulates.
  (t) => [
    uniqueIndex('member_attendance_meeting_property_unq').on(
      t.meetingId,
      t.propertyId,
    ),
  ],
);

export const memberVotes = sqliteTable(
  'member_votes',
  {
    id: text('id').primaryKey(),
    motionId: text('motion_id')
      .notNull()
      .references(() => motions.id, { onDelete: 'cascade' }),
    propertyId: text('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    castByOwnerId: text('cast_by_owner_id').references(() => owners.id, {
      onDelete: 'set null',
    }),
    viaProxy: integer('via_proxy', { mode: 'boolean' })
      .notNull()
      .default(false),
    // Snapshot of properties.vote_weight when this vote was recorded.
    // Correcting a property's weight later must not silently rewrite past
    // tallies — same reasoning as reports.sources_json.
    weight: integer('weight').notNull(),
    // Member motions are yes/no/abstain. `recused` and `absent` are board
    // roll-call concepts and are deliberately absent here.
    choice: text('choice', { enum: ['yes', 'no', 'abstain'] }).notNull(),
  },
  // One vote per lot — this index is what enforces it.
  (t) => [
    uniqueIndex('member_votes_motion_property_unq').on(
      t.motionId,
      t.propertyId,
    ),
  ],
);

export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    category: text('category').notNull(),
    visibility: text('visibility', { enum: ['public', 'homeowner', 'board'] })
      .notNull()
      .default('board'),
    r2Key: text('r2_key').notNull(),
    filename: text('filename').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    contentType: text('content_type').notNull(),
    contentHash: text('content_hash'),
    // Set when a board member explicitly keeps this file during duplicate
    // review. Non-null ⇒ verified/kept; reset to null when a matching new
    // document is uploaded so the group resurfaces. keep_verified_by is the
    // resolving board user id (audit trail).
    keepVerifiedAt: integer('keep_verified_at', { mode: 'timestamp' }),
    keepVerifiedBy: text('keep_verified_by'),
    // Outcome of RAG-twin generation on upload: 'ok' (rag/<id>.md written,
    // searchable at the next AI Search sync) or 'unsupported' (scan/unsupported
    // format — downloadable but not assistant-searchable). Null for documents
    // loaded by the offline corpus importer, which already have twins.
    ragStatus: text('rag_status', { enum: ['ok', 'unsupported'] }),
    uploadedAt: integer('uploaded_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  // Public/tier reads filter by visibility; dedup looks up by content hash.
  (t) => [
    index('documents_visibility_idx').on(t.visibility),
    index('documents_content_hash_idx').on(t.contentHash),
  ],
);

export const announcements = sqliteTable(
  'announcements',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    date: text('date').notNull(),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    visibility: text('visibility', { enum: ['public', 'homeowner', 'board'] })
      .notNull()
      .default('public'),
  },
  // Public/tier reads filter by visibility and order by date.
  (t) => [index('announcements_visibility_date_idx').on(t.visibility, t.date)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const reports = sqliteTable(
  'reports',
  {
    id: text('id').primaryKey(),
    topic: text('topic').notNull(),
    templateKey: text('template_key'),
    contentMd: text('content_md').notNull(),
    sourcesJson: text('sources_json').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    // Requesting board member's user id. Plain text (no FK) — audit trail only,
    // same pattern as documents.keep_verified_by.
    createdBy: text('created_by').notNull(),
  },
  // History list reads order by createdAt desc.
  (t) => [index('reports_created_at_idx').on(t.createdAt)],
);

// A standing resolution. First-class and durable rather than a flag on a
// motion: amending creates a NEW resolution that supersedes the old one, which
// makes "what rule is in force today" a single indexed query instead of a
// replay of every motion ever passed. Keeping motions separate also preserves
// what the board DECLINED to do, which a resolutions-only model discards.
export const resolutions = sqliteTable(
  'resolutions',
  {
    id: text('id').primaryKey(),
    // Board-entered, e.g. R-2026-03. Unique catches collisions; the admin form
    // suggests the next number as a hint. Auto-generation would need a counter
    // row and a race story for no real benefit at this volume.
    number: text('number').notNull(),
    title: text('title').notNull(),
    bodyMd: text('body_md').notNull(),
    // Null while draft — a resolution being typed up before adoption has no
    // effective date to invent.
    effectiveDate: text('effective_date'),
    status: text('status', {
      enum: ['draft', 'in_force', 'superseded', 'repealed'],
    })
      .notNull()
      .default('draft'),
    adoptedByMotionId: text('adopted_by_motion_id').references(
      () => motions.id,
      { onDelete: 'set null' },
    ),
    // Self-reference. RESTRICT, not SET NULL: a resolution that something else
    // supersedes must not be deletable out from under the chain, because the
    // chain is what makes the history readable. Declared as a plain column
    // here; the FK itself is added below via foreignKey() because Drizzle
    // cannot express a self-reference inline in the same table literal.
    supersedesId: text('supersedes_id'),
    visibility: text('visibility', { enum: ['public', 'homeowner', 'board'] })
      .notNull()
      .default('board'),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  // `number` unique: two resolutions cannot share a citation.
  // `supersedes_id` unique: two resolutions cannot both claim to replace the
  // same predecessor, which would fork the chain. SQLite treats NULLs as
  // distinct, so unlinked resolutions are unaffected.
  // `status` indexed: the public read and "what's in force" both filter on it.
  (t) => [
    uniqueIndex('resolutions_number_unq').on(t.number),
    uniqueIndex('resolutions_supersedes_unq').on(t.supersedesId),
    index('resolutions_status_idx').on(t.status),
    foreignKey({
      columns: [t.supersedesId],
      foreignColumns: [t.id],
      name: 'resolutions_supersedes_id_resolutions_id_fk',
    }).onDelete('restrict'),
  ],
);

export const elections = sqliteTable(
  'elections',
  {
    id: text('id').primaryKey(),
    // SET NULL, never CASCADE: an election may stand alone, and deleting a
    // draft meeting must never destroy a certified election.
    meetingId: text('meeting_id').references(() => meetings.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    seats: integer('seats').notNull(),
    electionDate: text('election_date').notNull(),
    // Decides which tally write path is legal. `recorded`: the board types
    // tallies from a paper count. `conducted` (PR 6): tallies are
    // increment-only and the board can never type one. Create-immutable —
    // mutating it would BE the bypass of every guard built on it.
    source: text('source', { enum: ['recorded', 'conducted'] })
      .notNull()
      .default('recorded'),
    status: text('status', {
      enum: ['draft', 'closed', 'certified', 'void'],
    })
      .notNull()
      .default('draft'),
    visibility: text('visibility', { enum: ['public', 'homeowner', 'board'] })
      .notNull()
      .default('board'),
    certifiedAt: integer('certified_at', { mode: 'timestamp' }),
    certifiedBy: text('certified_by'),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    index('elections_status_idx').on(t.status),
    index('elections_meeting_id_idx').on(t.meetingId),
  ],
);

export const candidates = sqliteTable(
  'candidates',
  {
    id: text('id').primaryKey(),
    electionId: text('election_id')
      .notNull()
      .references(() => elections.id, { onDelete: 'cascade' }),
    // Required: a first-time candidate has no board_people row yet.
    fullName: text('full_name').notNull(),
    // Nullable, and BACKFILLED BY CERTIFY when a winner had none — without
    // that backfill a re-run mints a duplicate identity, violating ADR 0012's
    // rule that a member who serves, leaves, and returns keeps one identity.
    boardPersonId: text('board_person_id').references(() => boardPeople.id, {
      onDelete: 'restrict',
    }),
    statementMd: text('statement_md'),
    sequence: integer('sequence').notNull(),
    // NULLABLE ON PURPOSE. NULL = not recorded; 0 = recorded as zero. Same
    // distinction tallyVotes.recorded protects for motions, where a motion
    // with no roll call must never render as a 0-0 tally.
    votes: integer('votes'),
    // Written by certify. Without it a certified election cannot answer "who
    // won" — and deriving winners from tallies is illegitimate here, since
    // this design refuses to derive them (tie-break rules vary by bylaws).
    won: integer('won', { mode: 'boolean' }).notNull().default(false),
    // A withdrawal is part of the record; deleting the candidate would erase
    // both it and any votes already tallied for them.
    withdrawn: integer('withdrawn', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    // NOTE: there is deliberately NO updatedAt on this table, breaking the
    // convention every other table follows. In PR 6, casting increments
    // `votes`; if that touched an updatedAt, the last ballot's choice would be
    // recoverable from persisted data alone by matching it against the newest
    // ballots.recorded_at. Do not "fix" this omission.
  },
  (t) => [
    index('candidates_election_id_idx').on(t.electionId),
    uniqueIndex('candidates_election_sequence_unq').on(
      t.electionId,
      t.sequence,
    ),
  ],
);

export const ballots = sqliteTable(
  'ballots',
  {
    id: text('id').primaryKey(),
    electionId: text('election_id')
      .notNull()
      .references(() => elections.id, { onDelete: 'cascade' }),
    propertyId: text('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'restrict' }),
    // Snapshot of properties.vote_weight, per ADR 0015, so correcting a lot's
    // weight later cannot rewrite a past turnout figure.
    weight: integer('weight').notNull(),
    viaProxy: integer('via_proxy', { mode: 'boolean' })
      .notNull()
      .default(false),
    castByOwnerId: text('cast_by_owner_id').references(() => owners.id, {
      onDelete: 'set null',
    }),
    recordedAt: integer('recorded_at', { mode: 'timestamp' }).notNull(),
  },
  // One ballot per lot per election. This row records ONLY that a lot returned
  // a ballot — it is turnout, and nothing else. There is no link from here to
  // a candidate, and none may ever be added.
  (t) => [
    uniqueIndex('ballots_election_property_unq').on(t.electionId, t.propertyId),
    index('ballots_election_id_idx').on(t.electionId),
  ],
);
