-- #294 slice 2 (ADR 0028, spec 2026-10-20 decisions 1 and 8): the Tenancy fact.
--
-- A Tenancy is its own relation. No Lot Authority reader joins it, so a tenant
-- never acts for the Lot they rent. Its column names follow `board_terms`, so
-- COALESCE(actual_end_day, scheduled_end_day) means the same thing in both.
-- The 13-month cap is checked in the mutation SQL, not here: it is a policy
-- number the board may change.
--
-- Apply BEFORE merging the code that uses it: `deriveAccess` reads `tenancies`
-- on every signed-in request, so the merged code fails every signed-in page
-- until this table exists.
CREATE TABLE IF NOT EXISTS `tenancies` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_person_id` text NOT NULL,
	`lot_id` text NOT NULL,
	`basis_ownership_id` text NOT NULL,
	`start_day` text NOT NULL,
	`scheduled_end_day` text NOT NULL,
	`actual_end_day` text,
	`end_reason` text,
	`ended_by_account_id` text,
	`renews_tenancy_id` text,
	`voided_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`lot_id`) REFERENCES `lots`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`basis_ownership_id`) REFERENCES `ownerships`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`renews_tenancy_id`) REFERENCES `tenancies`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tenancies_scheduled_ordered" CHECK("scheduled_end_day" > "start_day"),
	CONSTRAINT "tenancies_actual_end_ordered" CHECK("actual_end_day" IS NULL OR ("actual_end_day" >= "start_day" AND "actual_end_day" < "scheduled_end_day")),
	CONSTRAINT "tenancies_end_paired" CHECK(("actual_end_day" IS NULL) = ("end_reason" IS NULL)),
	CONSTRAINT "tenancies_end_reason_check" CHECK("end_reason" IS NULL OR "end_reason" IN ('owner_ended', 'board_ended', 'basis_ended', 'lot_retired')),
	CONSTRAINT "tenancies_no_self_renewal" CHECK("renews_tenancy_id" IS NULL OR "renews_tenancy_id" <> "id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tenancies_person_lot_idx` ON `tenancies` (`tenant_person_id`,`lot_id`,`start_day`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tenancies_lot_idx` ON `tenancies` (`lot_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tenancies_basis_idx` ON `tenancies` (`basis_ownership_id`);
--> statement-breakpoint
-- A Tenancy is a Roster Change subject, so `roster_change_subjects` gains a
-- `tenancy_id` column and its exactly-one CHECK widens. `__new`-copy-and-rename,
-- as in 0024 and 0026, because the table holds production history. SQLite's
-- ALTER ... RENAME reparses every view, so the two views that read the table
-- (one directly, one through the other) are dropped first and recreated after,
-- verbatim apart from the new branch.
DROP VIEW IF EXISTS audit_entity_history_v;--> statement-breakpoint
DROP VIEW IF EXISTS audit_event_subjects_v;--> statement-breakpoint
PRAGMA defer_foreign_keys = true;--> statement-breakpoint
CREATE TABLE `__new_roster_change_subjects` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`role` text NOT NULL,
	`lot_id` text,
	`party_id` text,
	`contact_method_id` text,
	`ownership_id` text,
	`representation_id` text,
	`person_link_id` text,
	`tenancy_id` text,
	FOREIGN KEY (`event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`lot_id`) REFERENCES `lots`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`party_id`) REFERENCES `parties`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`contact_method_id`) REFERENCES `contact_methods`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`ownership_id`) REFERENCES `ownerships`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`representation_id`) REFERENCES `representations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`person_link_id`) REFERENCES `person_links`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`tenancy_id`) REFERENCES `tenancies`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "roster_change_subjects_role_check" CHECK("role" IN ('primary', 'created', 'ended', 'voided', 'replacement', 'duplicate', 'survivor', 'related')),
	CONSTRAINT "roster_change_subjects_exactly_one" CHECK((CASE WHEN "lot_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "party_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "contact_method_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "ownership_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "representation_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "person_link_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "tenancy_id" IS NULL THEN 0 ELSE 1 END) = 1)
);
--> statement-breakpoint
INSERT INTO `__new_roster_change_subjects`("id", "event_id", "role", "lot_id", "party_id", "contact_method_id", "ownership_id", "representation_id", "person_link_id", "tenancy_id") SELECT "id", "event_id", "role", "lot_id", "party_id", "contact_method_id", "ownership_id", "representation_id", "person_link_id", NULL FROM `roster_change_subjects`;--> statement-breakpoint
DROP TABLE `roster_change_subjects`;--> statement-breakpoint
ALTER TABLE `__new_roster_change_subjects` RENAME TO `roster_change_subjects`;--> statement-breakpoint
PRAGMA defer_foreign_keys = false;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `roster_change_subjects_event_idx` ON `roster_change_subjects` (`event_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `roster_change_subjects_party_idx` ON `roster_change_subjects` (`party_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `roster_change_subjects_lot_idx` ON `roster_change_subjects` (`lot_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `roster_change_subjects_tenancy_idx` ON `roster_change_subjects` (`tenancy_id`);
--> statement-breakpoint
-- Recreated from 0023. CASE plus COALESCE, not a UNION per column: D1 caps a
-- compound SELECT at five terms.
CREATE VIEW IF NOT EXISTS audit_event_subjects_v AS
SELECT
  event_id,
  CASE
    WHEN lot_id IS NOT NULL THEN 'lot'
    WHEN party_id IS NOT NULL THEN 'party'
    WHEN contact_method_id IS NOT NULL THEN 'contact_method'
    WHEN ownership_id IS NOT NULL THEN 'ownership'
    WHEN representation_id IS NOT NULL THEN 'representation'
    WHEN person_link_id IS NOT NULL THEN 'person_link'
    WHEN tenancy_id IS NOT NULL THEN 'tenancy'
  END AS subject_kind,
  COALESCE(
    lot_id, party_id, contact_method_id, ownership_id, representation_id,
    person_link_id, tenancy_id
  ) AS subject_id,
  role
FROM roster_change_subjects
UNION ALL
SELECT
  event_id,
  CASE
    WHEN board_term_id IS NOT NULL THEN 'board_term'
    WHEN office_assignment_id IS NOT NULL THEN 'office_assignment'
    WHEN lot_id IS NOT NULL THEN 'lot'
  END AS subject_kind,
  COALESCE(board_term_id, office_assignment_id, lot_id) AS subject_id,
  role
FROM board_service_change_subjects;
--> statement-breakpoint
CREATE VIEW IF NOT EXISTS audit_entity_history_v AS
SELECT
  s.subject_kind,
  s.subject_id,
  s.role,
  e.ledger_sequence,
  e.id AS event_id,
  e.family,
  e.event_kind,
  e.correlation_id,
  e.recorded_at
FROM audit_event_subjects_v s
JOIN audit_events e ON e.id = s.event_id;
