-- ADR 0022 phase 1 of 4: immutable audit ledger.
--
-- A causally ordered typed Audit Event ledger. It reconstructs structure,
-- effective periods, actors, and causal consequences; it deliberately cannot
-- reconstruct erased personal values, which is what makes Roster Redaction
-- meaningful. Nothing reads these tables until phase 2 (see issue #195).
--
-- Depends on the roster core file. Every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS `access_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`access_grant_id` text,
	`target_account_id` text,
	`grant_type` text,
	`requested_action` text NOT NULL,
	`outcome` text NOT NULL,
	`reason_code` text,
	FOREIGN KEY (`event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`access_grant_id`) REFERENCES `access_grants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "access_events_grant_type_check" CHECK("grant_type" IS NULL OR "grant_type" IN ('board', 'system_admin')),
	CONSTRAINT "access_events_requested_action_check" CHECK("requested_action" IN ('grant', 'revoke', 'bootstrap', 'roster_export', 'last_administrator_change', 'grant_precondition_revalidation')),
	CONSTRAINT "access_events_outcome_check" CHECK("outcome" IN ('allowed', 'denied'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `audit_events` (
	`ledger_sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`family` text NOT NULL,
	`event_kind` text NOT NULL,
	`correlation_id` text NOT NULL,
	`correlation_sequence` integer NOT NULL,
	`causing_event_id` text,
	`actor_kind` text NOT NULL,
	`actor_account_id` text,
	`automatic_cause` text,
	`operation_key` text,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`causing_event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`actor_account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "audit_events_family_check" CHECK("family" IN ('roster_change', 'board_service_change', 'identity', 'access', 'roster_redaction', 'review', 'audit_record_correction')),
	CONSTRAINT "audit_events_actor_kind_check" CHECK("actor_kind" IN ('account', 'automatic', 'bootstrap', 'migration')),
	CONSTRAINT "audit_events_actor_account_shape" CHECK("actor_kind" NOT IN ('account', 'migration') OR ("actor_account_id" IS NOT NULL AND "automatic_cause" IS NULL)),
	CONSTRAINT "audit_events_automatic_shape" CHECK("actor_kind" <> 'automatic' OR ("automatic_cause" IS NOT NULL AND "causing_event_id" IS NOT NULL)),
	CONSTRAINT "audit_events_correlation_sequence_nonneg" CHECK("correlation_sequence" >= 0),
	CONSTRAINT "audit_events_initiating_shape" CHECK(("correlation_sequence" = 0) = ("operation_key" IS NOT NULL)),
	CONSTRAINT "audit_events_consequence_shape" CHECK("correlation_sequence" = 0 OR "causing_event_id" IS NOT NULL),
	CONSTRAINT "audit_events_root_has_no_cause" CHECK("correlation_sequence" <> 0 OR "causing_event_id" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `audit_events_id_unq` ON `audit_events` (`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `audit_events_correlation_position_unq` ON `audit_events` (`correlation_id`,`correlation_sequence`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `audit_events_operation_key_unq` ON `audit_events` (`operation_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_events_family_kind_idx` ON `audit_events` (`family`,`event_kind`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_events_causing_idx` ON `audit_events` (`causing_event_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_events_recorded_at_idx` ON `audit_events` (`recorded_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `audit_record_corrections` (
	`event_id` text PRIMARY KEY NOT NULL,
	`corrected_event_id` text NOT NULL,
	`correction_sequence` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`corrected_event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "audit_record_corrections_sequence_positive" CHECK("correction_sequence" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `audit_record_corrections_position_unq` ON `audit_record_corrections` (`corrected_event_id`,`correction_sequence`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `audit_scalar_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`field_key` text NOT NULL,
	`value_type` text NOT NULL,
	`old_text` text,
	`new_text` text,
	`old_integer` integer,
	`new_integer` integer,
	`old_boolean` integer,
	`new_boolean` integer,
	`old_day` text,
	`new_day` text,
	`old_instant` integer,
	`new_instant` integer,
	FOREIGN KEY (`event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "audit_scalar_changes_value_type_check" CHECK("value_type" IN ('text', 'integer', 'boolean', 'day', 'instant'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_scalar_changes_event_idx` ON `audit_scalar_changes` (`event_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `audit_sensitive_field_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`field_category` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "audit_sensitive_field_changes_category_check" CHECK("field_category" IN ('person_name', 'lot_address', 'email', 'phone', 'free_text'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `audit_sensitive_field_changes_event_idx` ON `audit_sensitive_field_changes` (`event_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `board_service_change_subjects` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`role` text NOT NULL,
	`board_term_id` text,
	`office_assignment_id` text,
	`lot_id` text,
	FOREIGN KEY (`event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`board_term_id`) REFERENCES `board_service_terms`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`office_assignment_id`) REFERENCES `board_office_assignments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`lot_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "board_service_change_subjects_role_check" CHECK("role" IN ('primary', 'created', 'ended', 'voided', 'replacement', 'duplicate', 'survivor', 'related')),
	CONSTRAINT "board_service_change_subjects_exactly_one" CHECK((CASE WHEN "board_term_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "office_assignment_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "lot_id" IS NULL THEN 0 ELSE 1 END) = 1)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `board_service_change_subjects_event_idx` ON `board_service_change_subjects` (`event_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `board_service_change_subjects_term_idx` ON `board_service_change_subjects` (`board_term_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `board_service_changes` (
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
	CONSTRAINT "board_service_changes_reason_code_check" CHECK("reason_code" IN ('term_expired', 'resigned', 'removed', 'declared_vacant_absences', 'eligibility_lost', 'vacancy_appointment', 'elected', 'qualifying_lot_substituted', 'office_assigned', 'office_ended', 'recorded_in_error')),
	CONSTRAINT "board_service_changes_evidence_kind_check" CHECK("evidence_kind" IN ('document', 'meeting', 'election', 'request', 'external', 'operator_observation')),
	CONSTRAINT "board_service_changes_evidence_exactly_one" CHECK((CASE WHEN "evidence_document_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "evidence_meeting_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "evidence_election_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "external_reference" IS NULL THEN 0 ELSE 1 END) = (CASE WHEN "evidence_kind" = 'operator_observation' THEN 0 ELSE 1 END))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `identity_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`person_verification_id` text,
	`person_link_id` text,
	`person_id` text,
	`target_account_id` text,
	`reason_code` text NOT NULL,
	`evidence_kind` text,
	`evidence_document_id` text,
	`evidence_meeting_id` text,
	`external_reference` text,
	FOREIGN KEY (`event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`person_verification_id`) REFERENCES `person_verifications`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`person_link_id`) REFERENCES `person_links`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`evidence_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`evidence_meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "identity_events_evidence_kind_check" CHECK("evidence_kind" IS NULL OR "evidence_kind" IN ('document', 'meeting', 'election', 'request', 'external', 'operator_observation'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `redaction_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`redaction_event_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_identifier` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`redaction_event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "redaction_tasks_target_kind_check" CHECK("target_kind" IN ('rag_corpus', 'ai_search_index', 'pseudonymizer_catalog', 'export_cache')),
	CONSTRAINT "redaction_tasks_status_check" CHECK("status" IN ('pending', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `redaction_tasks_target_unq` ON `redaction_tasks` (`redaction_event_id`,`target_kind`,`target_identifier`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `redaction_tasks_status_idx` ON `redaction_tasks` (`status`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `review_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`review_flag_id` text NOT NULL,
	`resolution_code` text,
	FOREIGN KEY (`event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "review_events_resolution_code_check" CHECK("resolution_code" IS NULL OR "resolution_code" IN ('remediated', 'confirmed_valid', 'no_effect', 'superseded'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `review_events_flag_idx` ON `review_events` (`review_flag_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `review_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`source_event_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`opened_at` integer NOT NULL,
	`resolved_at` integer,
	`resolution_code` text,
	`impacted_proxy_id` text,
	`impacted_member_attendance_id` text,
	`impacted_member_vote_id` text,
	`impacted_ballot_id` text,
	`impacted_board_term_id` text,
	`impacted_access_grant_id` text,
	`impacted_event_id` text,
	FOREIGN KEY (`source_event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`impacted_proxy_id`) REFERENCES `proxies`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`impacted_member_attendance_id`) REFERENCES `member_attendance`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`impacted_member_vote_id`) REFERENCES `member_votes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`impacted_ballot_id`) REFERENCES `ballots`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`impacted_board_term_id`) REFERENCES `board_service_terms`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`impacted_access_grant_id`) REFERENCES `access_grants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`impacted_event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "review_flags_category_check" CHECK("category" IN ('intervening_action_backdated', 'authority_lost_pending_occasion', 'vote_reset_on_transfer', 'ballot_final_after_transfer')),
	CONSTRAINT "review_flags_status_check" CHECK("status" IN ('open', 'resolved')),
	CONSTRAINT "review_flags_resolution_paired" CHECK(("status" = 'resolved') = ("resolved_at" IS NOT NULL)),
	CONSTRAINT "review_flags_impact_at_most_one" CHECK((CASE WHEN "impacted_proxy_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "impacted_member_attendance_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "impacted_member_vote_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "impacted_ballot_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "impacted_board_term_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "impacted_access_grant_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "impacted_event_id" IS NULL THEN 0 ELSE 1 END) <= 1)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `review_flags_open_idx` ON `review_flags` (`status`,`opened_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `review_flags_source_idx` ON `review_flags` (`source_event_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `roster_change_subjects` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`role` text NOT NULL,
	`lot_id` text,
	`party_id` text,
	`contact_method_id` text,
	`ownership_id` text,
	`representation_id` text,
	`person_link_id` text,
	FOREIGN KEY (`event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`lot_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`party_id`) REFERENCES `parties`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`contact_method_id`) REFERENCES `contact_methods`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`ownership_id`) REFERENCES `ownerships`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`representation_id`) REFERENCES `representations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`person_link_id`) REFERENCES `person_links`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "roster_change_subjects_role_check" CHECK("role" IN ('primary', 'created', 'ended', 'voided', 'replacement', 'duplicate', 'survivor', 'related')),
	CONSTRAINT "roster_change_subjects_exactly_one" CHECK((CASE WHEN "lot_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "party_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "contact_method_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "ownership_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "representation_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "person_link_id" IS NULL THEN 0 ELSE 1 END) = 1)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `roster_change_subjects_event_idx` ON `roster_change_subjects` (`event_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `roster_change_subjects_party_idx` ON `roster_change_subjects` (`party_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `roster_change_subjects_lot_idx` ON `roster_change_subjects` (`lot_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `roster_changes` (
	`event_id` text PRIMARY KEY NOT NULL,
	`effective_day` text,
	`effective_day_basis` text NOT NULL,
	`reason_code` text NOT NULL,
	`evidence_kind` text NOT NULL,
	`evidence_document_id` text,
	`evidence_meeting_id` text,
	`evidence_election_id` text,
	`evidence_request_id` text,
	`external_reference` text,
	FOREIGN KEY (`event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`evidence_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`evidence_meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`evidence_election_id`) REFERENCES `elections`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "roster_changes_effective_day_basis_check" CHECK("effective_day_basis" IN ('known', 'unknown', 'not_applicable')),
	CONSTRAINT "roster_changes_known_day_present" CHECK(("effective_day_basis" = 'known') = ("effective_day" IS NOT NULL)),
	CONSTRAINT "roster_changes_evidence_kind_check" CHECK("evidence_kind" IN ('document', 'meeting', 'election', 'request', 'external', 'operator_observation')),
	CONSTRAINT "roster_changes_evidence_exactly_one" CHECK((CASE WHEN "evidence_document_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "evidence_meeting_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "evidence_election_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "evidence_request_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "external_reference" IS NULL THEN 0 ELSE 1 END) = (CASE WHEN "evidence_kind" = 'operator_observation' THEN 0 ELSE 1 END))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `roster_redactions` (
	`event_id` text PRIMARY KEY NOT NULL,
	`target_person_id` text,
	`target_contact_method_id` text,
	`field_category` text NOT NULL,
	`authorized_by_account_id` text NOT NULL,
	`authority_kind` text NOT NULL,
	`authority_reference` text NOT NULL,
	`reason_code` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_contact_method_id`) REFERENCES `contact_methods`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`authorized_by_account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "roster_redactions_field_category_check" CHECK("field_category" IN ('person_name', 'email', 'phone')),
	CONSTRAINT "roster_redactions_authority_kind_check" CHECK("authority_kind" IN ('legal_requirement', 'binding_policy')),
	CONSTRAINT "roster_redactions_target_exactly_one" CHECK((CASE WHEN "target_person_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "target_contact_method_id" IS NULL THEN 0 ELSE 1 END) = 1)
);
