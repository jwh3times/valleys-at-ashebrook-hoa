import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// Re-export the Better-Auth-generated tables so one schema covers everything.
export * from './auth-schema';

export const owners = sqliteTable('owners', {
  id: text('id').primaryKey(),
  fullName: text('full_name').notNull(),
  address: text('address').notNull(),
  addressNormalized: text('address_normalized').notNull(),
  unit: text('unit'),
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
  ownerId: text('owner_id').notNull(),
  verifiedAt: integer('verified_at', { mode: 'timestamp' }).notNull(),
  method: text('method', {
    enum: ['otp_email', 'otp_sms', 'board_manual'],
  }).notNull(),
});

export const propertyVerifications = sqliteTable('property_verifications', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  ownerId: text('owner_id').notNull(),
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
