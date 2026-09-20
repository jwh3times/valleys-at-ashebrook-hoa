-- ADR 0024 (#291) slice 2: bound `lot_record_events.reason_code` to a code list.
--
-- `0034` left the column free text. The board picks a reason when it cures,
-- closes, reopens, or voids a Lot Record, and free text is how a column that
-- Roster Redaction does not cover ends up holding a resident's name. A bounded
-- code is also what makes the log reportable. The record's own board-only note
-- is where prose belongs; it is a column both redaction and the read helpers
-- already know about.
--
-- SQLite cannot add a CHECK to an existing table, so this is the 12-step table
-- rebuild. Safe and cheap here because the table is EMPTY everywhere — nothing
-- in the shipped code can write it yet, and `0034` has not been applied to
-- production at the time of writing (ops #35). The rebuild is written as the
-- generic sequence anyway rather than a DROP/CREATE, so that applying `0034`
-- and `0035` in one pass against a database where something DID write rows
-- preserves them rather than silently discarding them.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_lot_record_events` (
	`id` text PRIMARY KEY NOT NULL,
	`record_type` text NOT NULL,
	`record_id` text NOT NULL,
	`action` text NOT NULL,
	`acting_account_id` text NOT NULL,
	`reason_code` text,
	`recorded_at` integer NOT NULL,
	CONSTRAINT "lot_record_events_record_type_check" CHECK("record_type" IN ('lot_violations')),
	CONSTRAINT "lot_record_events_action_check" CHECK("action" IN ('created', 'cured', 'closed', 'reopened', 'voided', 'edited')),
	CONSTRAINT "lot_record_events_reason_code_check" CHECK("reason_code" IS NULL OR "reason_code" IN ('entered_in_error', 'duplicate', 'superseded', 'homeowner_corrected', 'board_decision', 'other'))
);--> statement-breakpoint
INSERT INTO `__new_lot_record_events` (`id`, `record_type`, `record_id`, `action`, `acting_account_id`, `reason_code`, `recorded_at`)
SELECT `id`, `record_type`, `record_id`, `action`, `acting_account_id`, `reason_code`, `recorded_at` FROM `lot_record_events`;--> statement-breakpoint
DROP TABLE `lot_record_events`;--> statement-breakpoint
ALTER TABLE `__new_lot_record_events` RENAME TO `lot_record_events`;--> statement-breakpoint
CREATE INDEX `lot_record_events_subject_idx` ON `lot_record_events` (`record_type`,`record_id`,`recorded_at`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
