import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

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
    propertyId: text('property_id').notNull(),
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
    userId: text('user_id').notNull(),
    propertyId: text('property_id').notNull(),
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
    userId: text('user_id').notNull(),
    propertyId: text('property_id').notNull(),
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
    userId: text('user_id').notNull(),
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
    uploadedAt: integer('uploaded_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  // Public/tier reads filter by visibility.
  (t) => [index('documents_visibility_idx').on(t.visibility)],
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
