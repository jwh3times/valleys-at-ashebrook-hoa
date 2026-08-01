import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
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
