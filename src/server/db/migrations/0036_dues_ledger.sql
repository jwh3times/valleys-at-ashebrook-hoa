-- ADR 0025 (#295) slice 1: the per-Lot dues ledger, and the second Lot Record
-- type.
--
-- Append-only and balance-forward. The balance is DERIVED — `SUM(amount_cents)`
-- over a Lot's entries — so there is no balance column to drift, a positive
-- balance is owed and a negative one is a credit. Money is integer cents,
-- never a float and never a string.
--
-- The signs are fixed by CHECK so that sum is meaningful without interpreting
-- `kind`: a charge is positive, a payment negative, an adjustment non-zero, a
-- reversal non-zero. Two rules CANNOT be same-row CHECKs and are enforced
-- inside the `INSERT … SELECT` that writes a reversal instead (ADR 0025): a
-- reversal's amount is exactly the negation of the entry it reverses, and a
-- reversal may not itself be reversed. `reverses_entry_id` is UNIQUE, so an
-- entry can be reversed at most once, and it is present exactly when
-- `kind = 'reversal'`.
--
-- `category` belongs to charges and `method` to payments; each is NULL for the
-- other kinds, which the shape CHECKs enforce rather than leaving to a writer.
-- `reference` is board-only — a check number — and is projected out of the
-- homeowner read the way `lot_violations.internal_note` is.
--
-- `recorded_by` is the acting ACCOUNT and is NULL exactly for provider-sourced
-- rows, which no person records. `operation_key` is UNIQUE so a double submit
-- — or a redelivered provider event — posts nothing twice.
--
-- `payment_id` has no foreign key and no table behind it yet: the `payments`
-- table arrives with the rail in a later slice. It is here because a ledger
-- row written from a verified provider event must carry the payment it came
-- from, and adding a column to this table later would mean rebuilding it.
CREATE TABLE `dues_ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`lot_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`effective_day` text NOT NULL,
	`description` text NOT NULL,
	`category` text,
	`method` text,
	`reference` text,
	`source` text NOT NULL,
	`payment_id` text,
	`reverses_entry_id` text,
	`recorded_by` text,
	`recorded_at` integer NOT NULL,
	`operation_key` text NOT NULL,
	FOREIGN KEY (`lot_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reverses_entry_id`) REFERENCES `dues_ledger_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "dues_ledger_entries_kind_check" CHECK("kind" IN ('charge', 'payment', 'adjustment', 'reversal')),
	CONSTRAINT "dues_ledger_entries_source_check" CHECK("source" IN ('board', 'provider')),
	CONSTRAINT "dues_ledger_entries_effective_day_shape" CHECK("effective_day" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "dues_ledger_entries_description_not_blank" CHECK(length(trim("description")) > 0),
	CONSTRAINT "dues_ledger_entries_sign_by_kind" CHECK(
		("kind" = 'charge' AND "amount_cents" > 0)
		OR ("kind" = 'payment' AND "amount_cents" < 0)
		OR ("kind" IN ('adjustment', 'reversal') AND "amount_cents" <> 0)
	),
	CONSTRAINT "dues_ledger_entries_category_check" CHECK("category" IS NULL OR "category" IN ('assessment', 'special_assessment', 'late_fee', 'fine', 'other')),
	CONSTRAINT "dues_ledger_entries_method_check" CHECK("method" IS NULL OR "method" IN ('online', 'check', 'cash', 'other')),
	CONSTRAINT "dues_ledger_entries_category_on_charges" CHECK(("kind" = 'charge') = ("category" IS NOT NULL)),
	CONSTRAINT "dues_ledger_entries_method_on_payments" CHECK(("kind" = 'payment') = ("method" IS NOT NULL)),
	CONSTRAINT "dues_ledger_entries_reverses_on_reversals" CHECK(("kind" = 'reversal') = ("reverses_entry_id" IS NOT NULL)),
	CONSTRAINT "dues_ledger_entries_recorded_by_shape" CHECK(("source" = 'provider') = ("recorded_by" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dues_ledger_entries_operation_key_unq` ON `dues_ledger_entries` (`operation_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `dues_ledger_entries_reverses_unq` ON `dues_ledger_entries` (`reverses_entry_id`);--> statement-breakpoint
-- The homeowner read is "this Lot, ordered by day", and the balance is a sum
-- over the same rows, so one composite index serves both.
CREATE INDEX `dues_ledger_entries_lot_effective_day_idx` ON `dues_ledger_entries` (`lot_id`,`effective_day`);--> statement-breakpoint
-- The shared event log now serves a second subject table, so its CHECK widens.
-- The rebuild carries no foreign-key PRAGMA: `lot_record_events` has no FK of
-- its own — its subject is `(record_type, record_id)`, which no FK can express
-- — nothing references it, and no view reads it. (`PRAGMA foreign_keys` is
-- unsupported on remote D1 and silently accepted by Miniflare, so it must not
-- appear in a migration at all; `0024`-`0029` use `defer_foreign_keys` where a
-- rebuild genuinely has constraints to defer.)
CREATE TABLE `__new_lot_record_events` (
	`id` text PRIMARY KEY NOT NULL,
	`record_type` text NOT NULL,
	`record_id` text NOT NULL,
	`action` text NOT NULL,
	`acting_account_id` text NOT NULL,
	`reason_code` text,
	`recorded_at` integer NOT NULL,
	CONSTRAINT "lot_record_events_record_type_check" CHECK("record_type" IN ('lot_violations', 'dues_ledger_entries')),
	CONSTRAINT "lot_record_events_action_check" CHECK("action" IN ('created', 'cured', 'closed', 'reopened', 'voided', 'edited')),
	CONSTRAINT "lot_record_events_reason_code_check" CHECK("reason_code" IS NULL OR "reason_code" IN ('entered_in_error', 'duplicate', 'superseded', 'homeowner_corrected', 'board_decision', 'other'))
);--> statement-breakpoint
INSERT INTO `__new_lot_record_events` (`id`, `record_type`, `record_id`, `action`, `acting_account_id`, `reason_code`, `recorded_at`)
SELECT `id`, `record_type`, `record_id`, `action`, `acting_account_id`, `reason_code`, `recorded_at` FROM `lot_record_events`;--> statement-breakpoint
DROP TABLE `lot_record_events`;--> statement-breakpoint
ALTER TABLE `__new_lot_record_events` RENAME TO `lot_record_events`;--> statement-breakpoint
CREATE INDEX `lot_record_events_subject_idx` ON `lot_record_events` (`record_type`,`record_id`,`recorded_at`);
