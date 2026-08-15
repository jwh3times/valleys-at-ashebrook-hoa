CREATE TABLE IF NOT EXISTS `correction_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`person_id` text NOT NULL,
	`kind` text NOT NULL,
	`contact_method_id` text,
	`proposed_value` text NOT NULL,
	`note` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by_account_id` text,
	FOREIGN KEY (`account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`contact_method_id`) REFERENCES `contact_methods`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`decided_by_account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "correction_requests_kind_check" CHECK("kind" IN ('name', 'contact_method')),
	CONSTRAINT "correction_requests_status_check" CHECK("status" IN ('open', 'accepted', 'declined', 'withdrawn')),
	CONSTRAINT "correction_requests_decision_paired" CHECK(("status" = 'open') = ("decided_at" IS NULL)),
	CONSTRAINT "correction_requests_decider_paired" CHECK(("decided_at" IS NULL) = ("decided_by_account_id" IS NULL)),
	CONSTRAINT "correction_requests_contact_target_shape" CHECK("kind" = 'contact_method' OR "contact_method_id" IS NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `correction_requests_status_idx` ON `correction_requests` (`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `correction_requests_person_idx` ON `correction_requests` (`person_id`);--> statement-breakpoint
DROP VIEW IF EXISTS audit_event_effective_v;--> statement-breakpoint
DROP VIEW IF EXISTS audit_integrity_violations_v;--> statement-breakpoint
PRAGMA defer_foreign_keys = true;--> statement-breakpoint
CREATE TABLE `__new_board_service_changes` (
	`event_id` text PRIMARY KEY NOT NULL,
	`effective_day` text,
	`effective_day_basis` text NOT NULL,
	`reason_code` text NOT NULL,
	`evidence_kind` text NOT NULL,
	`evidence_document_id` text,
	`evidence_meeting_id` text,
	`evidence_election_id` text,
	`external_reference` text,
	FOREIGN KEY (`event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`evidence_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`evidence_meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`evidence_election_id`) REFERENCES `elections`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "board_service_changes_effective_day_basis_check" CHECK("effective_day_basis" IN ('known', 'unknown', 'not_applicable')),
	CONSTRAINT "board_service_changes_known_day_present" CHECK(("effective_day_basis" = 'known') = ("effective_day" IS NOT NULL)),
	CONSTRAINT "board_service_changes_reason_code_check" CHECK("reason_code" IN ('term_expired', 'resigned', 'removed', 'declared_vacant_absences', 'eligibility_lost', 'vacancy_appointment', 'elected', 'qualifying_lot_substituted', 'office_assigned', 'office_ended', 'recorded_in_error', 'legacy_migration_baseline')),
	CONSTRAINT "board_service_changes_evidence_kind_check" CHECK("evidence_kind" IN ('document', 'meeting', 'election', 'request', 'external', 'operator_observation')),
	CONSTRAINT "board_service_changes_evidence_exactly_one" CHECK((CASE WHEN "evidence_document_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "evidence_meeting_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "evidence_election_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "external_reference" IS NULL THEN 0 ELSE 1 END) = (CASE WHEN "evidence_kind" = 'operator_observation' THEN 0 ELSE 1 END))
);
--> statement-breakpoint
INSERT INTO `__new_board_service_changes`("event_id", "effective_day", "effective_day_basis", "reason_code", "evidence_kind", "evidence_document_id", "evidence_meeting_id", "evidence_election_id", "external_reference") SELECT "event_id", "effective_day", "effective_day_basis", "reason_code", "evidence_kind", "evidence_document_id", "evidence_meeting_id", "evidence_election_id", "external_reference" FROM `board_service_changes`;--> statement-breakpoint
DROP TABLE `board_service_changes`;--> statement-breakpoint
ALTER TABLE `__new_board_service_changes` RENAME TO `board_service_changes`;--> statement-breakpoint
PRAGMA defer_foreign_keys = false;