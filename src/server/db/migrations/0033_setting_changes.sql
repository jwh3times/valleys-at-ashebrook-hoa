-- #363: an append-only audit ledger for site feature gates.
--
-- `officialMode` and `liveVotingEnabled` used to change only as part of the
-- whole-blob `PUT /api/admin/site`, which left no record of who flipped a
-- gate or when, and could silently revert one under a stale-tab lost update.
-- ADR 0024 ("Two flags, both required, both fail-closed") specifies the fix
-- for its own new `lotRecordsEnabled` flag and says #363 should build it for
-- the two gates that already exist, so ADR 0024/0025 can add their flags to
-- the same mechanism later.
--
-- This is deliberately NOT `audit_events`: that table's `family` CHECK
-- (roster_change / board_service_change / identity / access /
-- roster_redaction / review / audit_record_correction) is the party
-- roster's ledger, not a settings log, and a site-settings row has no Party,
-- Lot, or roster fact to attach to. `setting_changes` is its own small,
-- append-only table: no route may UPDATE or DELETE a row here, only INSERT
-- (see the static scan in test/unit/setting-changes-append-only.test.ts).
--
-- `key`/`old_value`/`new_value` are plain text rather than typed booleans:
-- the table logs the setting key by name and its literal 'true'/'false'
-- values, the same representation `voting-state.ts`'s
-- `LIVE_VOTING_ENABLED_SQL` compares against with `json_type(...) = 'true'`.
-- `acting_account_id` is plain text with no FK, the same audit-trail-only
-- pattern `reports.created_by` and `documents.keep_verified_by` already use.
CREATE TABLE `setting_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`old_value` text NOT NULL,
	`new_value` text NOT NULL,
	`acting_account_id` text NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `setting_changes_key_recorded_at_idx` ON `setting_changes` (`key`,`recorded_at`);
