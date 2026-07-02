import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// Re-export the Better-Auth-generated tables so one schema covers everything.
export * from './auth-schema';

export const properties = sqliteTable('properties', {
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
});

export const owners = sqliteTable('owners', {
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
});

export const userPropertyLinks = sqliteTable('user_property_links', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  propertyId: text('property_id').notNull(),
  verifiedAt: integer('verified_at', { mode: 'timestamp' }).notNull(),
  method: text('method', {
    enum: ['otp_email', 'otp_sms', 'board_manual'],
  }).notNull(),
});

export const propertyVerifications = sqliteTable('property_verifications', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  propertyId: text('property_id').notNull(),
  channel: text('channel', { enum: ['email', 'sms'] }).notNull(),
  codeHash: text('code_hash').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  consumedAt: integer('consumed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const manualApprovalQueue = sqliteTable('manual_approval_queue', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  claimedAddress: text('claimed_address').notNull(),
  reason: text('reason').notNull(),
  status: text('status', { enum: ['pending', 'approved', 'denied'] })
    .notNull()
    .default('pending'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const documents = sqliteTable('documents', {
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
});

export const announcements = sqliteTable('announcements', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  date: text('date').notNull(),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  visibility: text('visibility', { enum: ['public', 'homeowner', 'board'] })
    .notNull()
    .default('public'),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});
