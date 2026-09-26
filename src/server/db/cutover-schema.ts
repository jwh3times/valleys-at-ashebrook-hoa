import { sqliteTable, text, integer, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './auth-schema';

// The operator-only write freeze outlives the ADR 0022 cutover. The physical
// table retains its historical name and constraints; no serving code reads
// the retired mode key, whose row migration 0037 removes.
const instant = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const cutoverSettings = sqliteTable(
  'cutover_settings',
  {
    key: text('key', { enum: ['write_freeze'] }).primaryKey(),
    value: text('value').notNull(),
    updatedAt: instant('updated_at').notNull(),
    updatedByAccountId: text('updated_by_account_id').references(
      () => users.id,
      { onDelete: 'restrict' },
    ),
  },
  () => [
    check(
      'cutover_settings_key_check',
      sql`"key" IN ('cutover_mode', 'write_freeze')`,
    ),
    check(
      'cutover_settings_value_check',
      sql`("key" = 'cutover_mode' AND "value" IN ('legacy', 'derived')) OR ("key" = 'write_freeze' AND "value" IN ('off', 'on'))`,
    ),
  ],
);
