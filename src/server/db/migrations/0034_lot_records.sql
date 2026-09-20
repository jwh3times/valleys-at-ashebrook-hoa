-- ADR 0024 (#291): the first Lot Record type, and the audience's shared event log.
--
-- A Lot Record's audience is the parties holding Lot Authority over ONE Lot,
-- plus Board Access. It is deliberately NOT a fourth value of `visibility`:
-- these tables carry no `visibility` column at all, because a tier says how
-- sensitive a shared row is, while a Lot Record's audience is decided by its
-- `lot_id` joined against the roster. Putting the two on one axis would let a
-- future `visibility = 'homeowner'` edit publish one Lot's record to every
-- member.
--
-- Storage is typed per record type — there is no generic `lot_records` table
-- with a JSON payload, matching the ADR 0022 ledger's refusal of arbitrary
-- JSON. What the types share is the audience: the scoping predicate, the
-- gates, the 404 posture, and the structural tests.
--
-- `lot_id` references `properties(id)` — the Lot, until ADR 0022 phase 4
-- (#212) renames that table to `lots` — with ON DELETE RESTRICT, the action
-- every record table that must outlive an editing mistake already uses
-- (`ballots`, `proxies`, `member_votes`). Deleting a Lot that carries
-- enforcement history is refused rather than silently cascading it away.
--
-- Rows never key to `user`, an Account, `user_property_links`, or a Person as
-- their audience. `created_by` is the acting ACCOUNT, provenance only, plain
-- text with no FK — the same audit-trail-only pattern `reports.created_by`
-- and `setting_changes.acting_account_id` use. No Person name or Contact
-- Method value is copied into these tables, so Roster Redaction never has to
-- reach them.
CREATE TABLE `lot_violations` (
	`id` text PRIMARY KEY NOT NULL,
	`lot_id` text NOT NULL,
	`category` text NOT NULL,
	`effective_day` text NOT NULL,
	`summary` text NOT NULL,
	`internal_note` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`lot_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "lot_violations_category_check" CHECK("category" IN ('architectural', 'maintenance', 'landscaping', 'parking', 'trash', 'pets', 'noise', 'other')),
	CONSTRAINT "lot_violations_status_check" CHECK("status" IN ('open', 'cured', 'closed', 'voided')),
	CONSTRAINT "lot_violations_effective_day_shape" CHECK("effective_day" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "lot_violations_summary_not_blank" CHECK(length(trim("summary")) > 0)
);
--> statement-breakpoint
-- The homeowner read is always "this Lot, from the start of my authority
-- onward, newest first", and the board read is always "this Lot". Both are
-- served by one composite index, and `effective_day` is a sortable
-- `YYYY-MM-DD` Association Day so the index orders the read as well as
-- filtering it.
CREATE INDEX `lot_violations_lot_effective_day_idx` ON `lot_violations` (`lot_id`,`effective_day`);--> statement-breakpoint
-- Every create, transition, and void of any Lot Record type appends here.
-- Append-only by convention, as ADR 0022's ledger is: D1 has one binding and
-- this codebase forbids triggers, so the discipline is pinned by tests that
-- no route issues UPDATE or DELETE against this table.
--
-- The subject is `(record_type, record_id)` with NO foreign key, because one
-- table serves several subject tables — SQLite cannot express a FK whose
-- target depends on another column's value. `record_type` is CHECK-bounded to
-- the Lot Record types that exist, which is what keeps the pair meaningful;
-- ADR 0025's `dues_ledger_entries` (#295) widens this CHECK when it lands.
--
-- Per-record board READS are not logged. A bulk export, if one is ever added,
-- is a recorded act the way `POST /api/admin/roster-export` already is.
CREATE TABLE `lot_record_events` (
	`id` text PRIMARY KEY NOT NULL,
	`record_type` text NOT NULL,
	`record_id` text NOT NULL,
	`action` text NOT NULL,
	`acting_account_id` text NOT NULL,
	`reason_code` text,
	`recorded_at` integer NOT NULL,
	CONSTRAINT "lot_record_events_record_type_check" CHECK("record_type" IN ('lot_violations')),
	CONSTRAINT "lot_record_events_action_check" CHECK("action" IN ('created', 'cured', 'closed', 'reopened', 'voided', 'edited'))
);
--> statement-breakpoint
CREATE INDEX `lot_record_events_subject_idx` ON `lot_record_events` (`record_type`,`record_id`,`recorded_at`);
