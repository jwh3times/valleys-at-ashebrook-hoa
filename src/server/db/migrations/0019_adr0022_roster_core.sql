-- ADR 0022 phase 1 of 4: party roster core.
--
-- Durable Lots, parties, relationships, identity links, board service, and
-- access grants. Nothing reads these tables until phase 2 (see issue #195).
--
-- There is deliberately no `lots` table: the Lot IS `properties`, which
-- already holds every Lot with its identity intact. `lot_id` columns
-- reference `properties.id`; the physical rename waits for phase 4.
--
-- Board service is `board_service_terms`, not `board_terms`: the legacy
-- table of that name still exists with a different shape, and CREATE TABLE IF
-- NOT EXISTS under the real name would silently do nothing.
--
-- Every statement is IF NOT EXISTS so a half-applied file can be fixed by
-- running it forward again.

CREATE TABLE IF NOT EXISTS `access_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`grant_type` text NOT NULL,
	`qualifying_board_term_id` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`granted_by_account_id` text,
	`grant_reason` text,
	`ended_by_account_id` text,
	`end_reason` text,
	FOREIGN KEY (`account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`qualifying_board_term_id`) REFERENCES `board_service_terms`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`granted_by_account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`ended_by_account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "access_grants_grant_type_check" CHECK("grant_type" IN ('board', 'system_admin')),
	CONSTRAINT "access_grants_qualifying_term_shape" CHECK(("grant_type" = 'board') = ("qualifying_board_term_id" IS NOT NULL)),
	CONSTRAINT "access_grants_interval_ordered" CHECK("ended_at" IS NULL OR "ended_at" > "started_at"),
	CONSTRAINT "access_grants_end_fields_paired" CHECK("ended_at" IS NOT NULL OR ("ended_by_account_id" IS NULL AND "end_reason" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `access_grants_current_unq` ON `access_grants` (`account_id`,`grant_type`) WHERE "ended_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `access_grants_term_idx` ON `access_grants` (`qualifying_board_term_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `board_office_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`board_term_id` text NOT NULL,
	`person_id` text NOT NULL,
	`office` text NOT NULL,
	`start_day` text NOT NULL,
	`end_day` text,
	`voided_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`board_term_id`) REFERENCES `board_service_terms`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`board_term_id`,`person_id`) REFERENCES `board_service_terms`(`id`,`person_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "board_office_assignments_office_check" CHECK("office" IN ('president', 'vice_president', 'secretary_treasurer')),
	CONSTRAINT "board_office_assignments_interval_ordered" CHECK(("end_day" IS NULL OR "start_day" IS NULL OR "end_day" > "start_day"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `board_office_assignments_office_current_unq` ON `board_office_assignments` (`office`) WHERE "end_day" IS NULL AND "voided_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `board_office_assignments_person_current_unq` ON `board_office_assignments` (`person_id`) WHERE "end_day" IS NULL AND "voided_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `board_office_assignments_term_idx` ON `board_office_assignments` (`board_term_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `board_service_terms` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`qualifying_lot_id` text,
	`election_id` text,
	`start_day` text NOT NULL,
	`scheduled_end_day` text NOT NULL,
	`actual_end_day` text,
	`cancelled_day` text,
	`cancelled_at` integer,
	`voided_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`qualifying_lot_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`election_id`) REFERENCES `elections`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "board_service_terms_scheduled_ordered" CHECK("scheduled_end_day" > "start_day"),
	CONSTRAINT "board_service_terms_actual_end_ordered" CHECK("actual_end_day" IS NULL OR "actual_end_day" > "start_day"),
	CONSTRAINT "board_service_terms_cancelled_before_start" CHECK("cancelled_day" IS NULL OR "cancelled_day" < "start_day"),
	CONSTRAINT "board_service_terms_cancellation_paired" CHECK(("cancelled_day" IS NULL) = ("cancelled_at" IS NULL)),
	CONSTRAINT "board_service_terms_one_ending" CHECK((CASE WHEN "actual_end_day" IS NULL THEN 0 ELSE 1 END + CASE WHEN "cancelled_at" IS NULL THEN 0 ELSE 1 END + CASE WHEN "voided_at" IS NULL THEN 0 ELSE 1 END) <= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `board_service_terms_id_person_unq` ON `board_service_terms` (`id`,`person_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `board_service_terms_person_start_idx` ON `board_service_terms` (`person_id`,`start_day`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `board_service_terms_lot_start_idx` ON `board_service_terms` (`qualifying_lot_id`,`start_day`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `contact_methods` (
	`id` text PRIMARY KEY NOT NULL,
	`party_id` text NOT NULL,
	`channel` text NOT NULL,
	`value` text,
	`value_normalized` text,
	`is_preferred` integer DEFAULT false NOT NULL,
	`start_day` text,
	`end_day` text,
	`redacted_at` integer,
	`voided_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`party_id`) REFERENCES `parties`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "contact_methods_channel_check" CHECK("channel" IN ('email', 'sms')),
	CONSTRAINT "contact_methods_interval_ordered" CHECK(("end_day" IS NULL OR "start_day" IS NULL OR "end_day" > "start_day")),
	CONSTRAINT "contact_methods_value_redaction_paired" CHECK(("value" IS NULL) = ("redacted_at" IS NOT NULL)),
	CONSTRAINT "contact_methods_normalized_paired" CHECK(("value" IS NULL) = ("value_normalized" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `contact_methods_preferred_unq` ON `contact_methods` (`party_id`,`channel`) WHERE "is_preferred" = 1 AND "end_day" IS NULL AND "voided_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `contact_methods_lookup_idx` ON `contact_methods` (`channel`,`value_normalized`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `contact_methods_party_idx` ON `contact_methods` (`party_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `organizations` (
	`party_id` text PRIMARY KEY NOT NULL,
	`party_kind` text DEFAULT 'organization' NOT NULL,
	`legal_name` text NOT NULL,
	`display_name` text,
	`name_normalized` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`party_id`) REFERENCES `parties`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`party_id`,`party_kind`) REFERENCES `parties`(`id`,`kind`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "organizations_party_kind_check" CHECK("party_kind" = 'organization')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `organizations_name_normalized_idx` ON `organizations` (`name_normalized`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ownerships` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_party_id` text NOT NULL,
	`lot_id` text NOT NULL,
	`start_day` text,
	`end_day` text,
	`voided_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_party_id`) REFERENCES `parties`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`lot_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ownerships_interval_ordered" CHECK(("end_day" IS NULL OR "start_day" IS NULL OR "end_day" > "start_day"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ownerships_current_unq` ON `ownerships` (`owner_party_id`,`lot_id`) WHERE "end_day" IS NULL AND "voided_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ownerships_lot_idx` ON `ownerships` (`lot_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ownerships_party_idx` ON `ownerships` (`owner_party_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `parties` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`consolidated_into_party_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`consolidated_into_party_id`) REFERENCES `parties`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "parties_kind_check" CHECK("kind" IN ('person', 'organization')),
	CONSTRAINT "parties_no_self_consolidation" CHECK("consolidated_into_party_id" IS NULL OR "consolidated_into_party_id" <> "id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `parties_id_kind_unq` ON `parties` (`id`,`kind`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `parties_consolidated_into_idx` ON `parties` (`consolidated_into_party_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `people` (
	`party_id` text PRIMARY KEY NOT NULL,
	`party_kind` text DEFAULT 'person' NOT NULL,
	`full_name` text,
	`name_normalized` text,
	`name_redacted_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`party_id`) REFERENCES `parties`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`party_id`,`party_kind`) REFERENCES `parties`(`id`,`kind`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "people_party_kind_check" CHECK("party_kind" = 'person'),
	CONSTRAINT "people_name_redaction_paired" CHECK(("full_name" IS NULL) = ("name_redacted_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `people_name_normalized_idx` ON `people` (`name_normalized`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `person_links` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`person_id` text NOT NULL,
	`verification_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`ended_by_account_id` text,
	`end_reason` text,
	FOREIGN KEY (`account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`verification_id`) REFERENCES `person_verifications`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`ended_by_account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "person_links_end_reason_check" CHECK("end_reason" IS NULL OR "end_reason" IN ('self_unlink', 'account_replaced', 'no_longer_qualifies', 'suspected_compromise', 'recorded_in_error', 'resident_request')),
	CONSTRAINT "person_links_interval_ordered" CHECK("ended_at" IS NULL OR "ended_at" > "started_at"),
	CONSTRAINT "person_links_end_fields_paired" CHECK("ended_at" IS NOT NULL OR ("ended_by_account_id" IS NULL AND "end_reason" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `person_links_verification_unq` ON `person_links` (`verification_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `person_links_account_current_unq` ON `person_links` (`account_id`) WHERE "ended_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `person_links_person_current_unq` ON `person_links` (`person_id`) WHERE "ended_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `person_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`person_id` text NOT NULL,
	`method` text NOT NULL,
	`contact_method_id` text,
	`approver_account_id` text,
	`reason` text,
	`verified_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`contact_method_id`) REFERENCES `contact_methods`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`approver_account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "person_verifications_method_check" CHECK("method" IN ('otp_email', 'otp_sms', 'manual', 'bootstrap')),
	CONSTRAINT "person_verifications_reason_check" CHECK("reason" IS NULL OR "reason" IN ('automatic_contact_proof', 'manual_board_decision', 'migration_reverification', 'bootstrap_first_administrator')),
	CONSTRAINT "person_verifications_automatic_shape" CHECK("method" NOT IN ('otp_email', 'otp_sms') OR ("contact_method_id" IS NOT NULL AND "approver_account_id" IS NULL)),
	CONSTRAINT "person_verifications_manual_shape" CHECK("method" <> 'manual' OR ("approver_account_id" IS NOT NULL AND "reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `person_verifications_person_idx` ON `person_verifications` (`person_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `person_verifications_account_idx` ON `person_verifications` (`account_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `representation_lots` (
	`representation_id` text NOT NULL,
	`lot_id` text NOT NULL,
	`voided_at` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`representation_id`, `lot_id`),
	FOREIGN KEY (`representation_id`) REFERENCES `representations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lot_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `representation_lots_lot_idx` ON `representation_lots` (`lot_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `representations` (
	`id` text PRIMARY KEY NOT NULL,
	`representative_person_id` text NOT NULL,
	`organization_party_id` text NOT NULL,
	`scope_kind` text NOT NULL,
	`start_day` text NOT NULL,
	`end_day` text,
	`voided_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`representative_person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`organization_party_id`) REFERENCES `organizations`(`party_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "representations_scope_kind_check" CHECK("scope_kind" IN ('organization', 'lots')),
	CONSTRAINT "representations_interval_ordered" CHECK(("end_day" IS NULL OR "start_day" IS NULL OR "end_day" > "start_day"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `representations_current_unq` ON `representations` (`representative_person_id`,`organization_party_id`) WHERE "end_day" IS NULL AND "voided_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `representations_organization_idx` ON `representations` (`organization_party_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `representations_person_idx` ON `representations` (`representative_person_id`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `system_admin_bootstrap` (
	`singleton_key` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`consumed_at` integer NOT NULL,
	`account_id` text NOT NULL,
	`access_grant_id` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`access_grant_id`) REFERENCES `access_grants`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "system_admin_bootstrap_singleton" CHECK("singleton_key" = 'singleton')
);
