import {
  sqliteTable,
  text,
  integer,
  index,
  check,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './auth-schema';

// Operational tables for the ADR 0022 cutover. Both drop in phase 4, except
// the write-freeze setting, which is deliberately retained — see below.
//
// Added inert in PHASE 1 ("expand") — see issue #195. Two things read them now:
// the phase-2 shadow layer writes cutover_shadow_mismatches, and the write
// freeze is enforced from src/server/authz/write-freeze.ts. `cutover_mode` is
// still read by nothing; phase 3 is what makes it decide anything.

const instant = (name: string) => integer(name, { mode: 'timestamp_ms' });

// Operator-only singletons. **Never surfaced in the admin Site panel**, unlike
// `officialMode` and `liveVotingEnabled`: the board may not toggle the
// authorization model. Values are written by the migrating operator directly.
//
//  `cutover_mode`  — 'legacy' | 'derived'. Defaults to legacy and flips in
//                    seconds with no build, which is what makes rollback
//                    credible at the moment it matters. Dropped in phase 4.
//  `write_freeze`  — 'off' | 'on'. Enforced in middleware and again per route
//                    (src/server/authz/write-freeze.ts), mirroring the
//                    deliberate two-layer convention of ADR 0013. Frozen
//                    requests return 503 (a maintenance state), never 404 (a
//                    masked-existence case). An ABSENT row means off, so a
//                    database that has never been frozen needs no seed.
//
// The freeze is KEPT after phase 4. It was built for the flip, but a
// maintenance switch that halts mutations while leaving public reads and
// sign-in live is permanently useful — the next schema migration, a suspected
// compromise, a D1 incident. Deleting working operational safety because the
// project that motivated it finished is how an association ends up rebuilding
// it under pressure a year later.
export const cutoverSettings = sqliteTable(
  'cutover_settings',
  {
    key: text('key', { enum: ['cutover_mode', 'write_freeze'] }).primaryKey(),
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

// Shadow-comparison output for phase 2. MISMATCHES ONLY — never a row per
// request — which keeps volume near zero and stays queryable in a way Workers
// Logs is not.
//
// IDs, codes, and counts. No personal values, ever.
//
// Fed by two sources: the per-request shadow path, and the offline sweep that
// derives both contexts for EVERY account. The sweep is not optional garnish —
// on a 21-Lot site organic traffic may exercise a handful of accounts, and
// "zero mismatches" across three accounts renders identically to zero across
// all of them. Dropped in phase 4.
export const cutoverShadowMismatches = sqliteTable(
  'cutover_shadow_mismatches',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    source: text('source', { enum: ['request', 'sweep'] }).notNull(),
    legacyRole: text('legacy_role'),
    derivedContentTier: text('derived_content_tier'),
    legacyLotCount: integer('legacy_lot_count').notNull(),
    derivedLotCount: integer('derived_lot_count').notNull(),
    // Set once an operator matches this row against the pre-agreed
    // explained-mismatch allow-list. A NULL here is an UNEXPLAINED mismatch,
    // and any unexplained mismatch blocks the flip.
    explainedAs: text('explained_as', {
      enum: ['accepted_member_access_loss', 'board_member_api_passthrough'],
    }),
    firstSeenAt: instant('first_seen_at').notNull(),
    lastSeenAt: instant('last_seen_at').notNull(),
    seenCount: integer('seen_count').notNull().default(1),
  },
  (t) => [
    check('cutover_shadow_source_check', sql`"source" IN ('request', 'sweep')`),
    check(
      'cutover_shadow_explained_as_check',
      sql`"explained_as" IS NULL OR "explained_as" IN ('accepted_member_access_loss', 'board_member_api_passthrough')`,
    ),
    index('cutover_shadow_account_idx').on(t.accountId),
    index('cutover_shadow_unexplained_idx').on(t.explainedAs),
  ],
);
