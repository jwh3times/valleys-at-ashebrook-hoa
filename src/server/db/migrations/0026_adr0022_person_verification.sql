-- ADR 0022 phase 3c (#219): Person Verification foundations.
--
-- Four pieces:
--   1. `contact_methods` is REBUILT to carry `party_kind`, kept honest by a
--      composite FK to parties(id, kind) and exposed through a unique
--      (id, party_kind) index — the target that lets `person_verifications`
--      structurally require a PERSON's contact (#202).
--   2. `person_verifications` is REBUILT: `contact_method_party_kind` pinned
--      to 'person' via CHECK plus the composite FK, and a bootstrap shape
--      CHECK closing the gap the automatic/manual shapes left open.
--   3. `identity_events` is REBUILT (provably empty — it has never had a
--      writer): gains the opaque `evidence_request_id` locator and the
--      exactly-one evidence CHECK mirroring roster_changes; the 'election'
--      evidence kind is dropped. `reason_code` stays deliberately unchecked
--      (0024's board_service_changes rebuild is the recorded lesson that
--      reason-code CHECKs become flip-blockers).
--   4. Two new operational tables: `verification_codes` (pending automatic
--      codes) and `verification_review_requests` (explicit applicant review
--      requests; free text that never enters the ledger).
--
-- SQLite's ALTER TABLE ... RENAME reparses every view, so the two views that
-- reference `identity_events` — audit_event_effective_v and
-- audit_integrity_violations_v — are dropped first and recreated verbatim at
-- the end (the 0024/0025 precedent, this time in one file). D1 supports
-- PRAGMA defer_foreign_keys, NOT PRAGMA foreign_keys.
DROP VIEW IF EXISTS audit_event_effective_v;--> statement-breakpoint
DROP VIEW IF EXISTS audit_integrity_violations_v;--> statement-breakpoint
PRAGMA defer_foreign_keys = true;--> statement-breakpoint
CREATE TABLE `__new_contact_methods` (
	`id` text PRIMARY KEY NOT NULL,
	`party_id` text NOT NULL,
	`party_kind` text NOT NULL,
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
	FOREIGN KEY (`party_id`,`party_kind`) REFERENCES `parties`(`id`,`kind`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "contact_methods_channel_check" CHECK("channel" IN ('email', 'sms')),
	CONSTRAINT "contact_methods_party_kind_check" CHECK("party_kind" IN ('person', 'organization')),
	CONSTRAINT "contact_methods_interval_ordered" CHECK(("end_day" IS NULL OR "start_day" IS NULL OR "end_day" > "start_day")),
	CONSTRAINT "contact_methods_value_redaction_paired" CHECK(("value" IS NULL) = ("redacted_at" IS NOT NULL)),
	CONSTRAINT "contact_methods_normalized_paired" CHECK(("value" IS NULL) = ("value_normalized" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_contact_methods`("id", "party_id", "party_kind", "channel", "value", "value_normalized", "is_preferred", "start_day", "end_day", "redacted_at", "voided_at", "created_at", "updated_at") SELECT cm."id", cm."party_id", p."kind", cm."channel", cm."value", cm."value_normalized", cm."is_preferred", cm."start_day", cm."end_day", cm."redacted_at", cm."voided_at", cm."created_at", cm."updated_at" FROM `contact_methods` cm JOIN `parties` p ON p."id" = cm."party_id";--> statement-breakpoint
DROP TABLE `contact_methods`;--> statement-breakpoint
ALTER TABLE `__new_contact_methods` RENAME TO `contact_methods`;--> statement-breakpoint
CREATE UNIQUE INDEX `contact_methods_id_kind_unq` ON `contact_methods` (`id`,`party_kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `contact_methods_preferred_unq` ON `contact_methods` (`party_id`,`channel`) WHERE "is_preferred" = 1 AND "end_day" IS NULL AND "voided_at" IS NULL;--> statement-breakpoint
CREATE INDEX `contact_methods_lookup_idx` ON `contact_methods` (`channel`,`value_normalized`);--> statement-breakpoint
CREATE INDEX `contact_methods_party_idx` ON `contact_methods` (`party_id`);--> statement-breakpoint
CREATE TABLE `__new_person_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`person_id` text NOT NULL,
	`method` text NOT NULL,
	`contact_method_id` text,
	`contact_method_party_kind` text,
	`approver_account_id` text,
	`reason` text,
	`verified_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`approver_account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`contact_method_id`,`contact_method_party_kind`) REFERENCES `contact_methods`(`id`,`party_kind`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "person_verifications_method_check" CHECK("method" IN ('otp_email', 'otp_sms', 'manual', 'bootstrap')),
	CONSTRAINT "person_verifications_reason_check" CHECK("reason" IS NULL OR "reason" IN ('automatic_contact_proof', 'manual_board_decision', 'migration_reverification', 'bootstrap_first_administrator')),
	CONSTRAINT "person_verifications_automatic_shape" CHECK("method" NOT IN ('otp_email', 'otp_sms') OR ("contact_method_id" IS NOT NULL AND "approver_account_id" IS NULL)),
	CONSTRAINT "person_verifications_manual_shape" CHECK("method" <> 'manual' OR ("approver_account_id" IS NOT NULL AND "reason" IS NOT NULL)),
	CONSTRAINT "person_verifications_bootstrap_shape" CHECK("method" <> 'bootstrap' OR ("contact_method_id" IS NULL AND "approver_account_id" IS NULL AND "reason" = 'bootstrap_first_administrator')),
	CONSTRAINT "person_verifications_contact_person_only" CHECK("contact_method_party_kind" IS NULL OR "contact_method_party_kind" = 'person'),
	CONSTRAINT "person_verifications_contact_kind_paired" CHECK(("contact_method_id" IS NULL) = ("contact_method_party_kind" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_person_verifications`("id", "account_id", "person_id", "method", "contact_method_id", "contact_method_party_kind", "approver_account_id", "reason", "verified_at") SELECT "id", "account_id", "person_id", "method", "contact_method_id", CASE WHEN "contact_method_id" IS NULL THEN NULL ELSE 'person' END, "approver_account_id", "reason", "verified_at" FROM `person_verifications`;--> statement-breakpoint
DROP TABLE `person_verifications`;--> statement-breakpoint
ALTER TABLE `__new_person_verifications` RENAME TO `person_verifications`;--> statement-breakpoint
CREATE INDEX `person_verifications_person_idx` ON `person_verifications` (`person_id`);--> statement-breakpoint
CREATE INDEX `person_verifications_account_idx` ON `person_verifications` (`account_id`);--> statement-breakpoint
CREATE TABLE `__new_identity_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`person_verification_id` text,
	`person_link_id` text,
	`person_id` text,
	`target_account_id` text,
	`reason_code` text NOT NULL,
	`evidence_kind` text,
	`evidence_document_id` text,
	`evidence_meeting_id` text,
	`evidence_request_id` text,
	`external_reference` text,
	FOREIGN KEY (`event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`person_verification_id`) REFERENCES `person_verifications`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`person_link_id`) REFERENCES `person_links`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`target_account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`evidence_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`evidence_meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "identity_events_evidence_kind_check" CHECK("evidence_kind" IS NULL OR "evidence_kind" IN ('document', 'meeting', 'request', 'external', 'operator_observation')),
	CONSTRAINT "identity_events_evidence_exactly_one" CHECK((CASE WHEN "evidence_document_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "evidence_meeting_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "evidence_request_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "external_reference" IS NULL THEN 0 ELSE 1 END) = (CASE WHEN "evidence_kind" IS NULL OR "evidence_kind" = 'operator_observation' THEN 0 ELSE 1 END))
);
--> statement-breakpoint
INSERT INTO `__new_identity_events`("event_id", "person_verification_id", "person_link_id", "person_id", "target_account_id", "reason_code", "evidence_kind", "evidence_document_id", "evidence_meeting_id", "evidence_request_id", "external_reference") SELECT "event_id", "person_verification_id", "person_link_id", "person_id", "target_account_id", "reason_code", "evidence_kind", "evidence_document_id", "evidence_meeting_id", NULL, "external_reference" FROM `identity_events`;--> statement-breakpoint
DROP TABLE `identity_events`;--> statement-breakpoint
ALTER TABLE `__new_identity_events` RENAME TO `identity_events`;--> statement-breakpoint
PRAGMA defer_foreign_keys = false;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `verification_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`person_id` text NOT NULL,
	`contact_method_id` text NOT NULL,
	`lot_id` text NOT NULL,
	`channel` text NOT NULL,
	`code_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`contact_method_id`) REFERENCES `contact_methods`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`lot_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "verification_codes_channel_check" CHECK("channel" IN ('email', 'sms'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `verification_codes_account_idx` ON `verification_codes` (`account_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `verification_codes_expires_idx` ON `verification_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `verification_review_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`claimed_address` text NOT NULL,
	`claimed_name` text NOT NULL,
	`channel` text,
	`internal_reason` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`resolved_by_account_id` text,
	FOREIGN KEY (`account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`resolved_by_account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "verification_review_requests_internal_reason_check" CHECK("internal_reason" IN ('applicant_requested', 'person_already_linked')),
	CONSTRAINT "verification_review_requests_status_check" CHECK("status" IN ('open', 'accepted', 'declined')),
	CONSTRAINT "verification_review_requests_resolution_paired" CHECK(("status" = 'open') = ("resolved_at" IS NULL)),
	CONSTRAINT "verification_review_requests_resolver_paired" CHECK(("resolved_at" IS NULL) = ("resolved_by_account_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `verification_review_requests_open_unq` ON `verification_review_requests` (`account_id`) WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `verification_review_requests_status_idx` ON `verification_review_requests` (`status`);--> statement-breakpoint
-- Recreate the two dropped views verbatim from 0025 (their definitions are
-- unchanged by this migration; identity_events kept every column they read).
CREATE VIEW IF NOT EXISTS audit_event_effective_v AS
SELECT
  e.ledger_sequence,
  e.id,
  e.family,
  e.event_kind,
  e.correlation_id,
  e.correlation_sequence,
  e.causing_event_id,
  e.actor_kind,
  e.actor_account_id,
  e.automatic_cause,
  e.operation_key,
  e.recorded_at,
  COALESCE(rc.effective_day, bsc.effective_day) AS effective_day,
  COALESCE(rc.effective_day_basis, bsc.effective_day_basis) AS effective_day_basis,
  COALESCE(rc.reason_code, bsc.reason_code, ie.reason_code, ae.reason_code, rr.reason_code) AS reason_code,
  COALESCE(rc.evidence_kind, bsc.evidence_kind, ie.evidence_kind) AS evidence_kind,
  -- Latest correction wins; the full chain stays queryable on the table.
  (SELECT arc.event_id FROM audit_record_corrections arc
     WHERE arc.corrected_event_id = e.id
     ORDER BY arc.correction_sequence DESC LIMIT 1) AS latest_correction_event_id,
  (SELECT COUNT(*) FROM audit_record_corrections arc
     WHERE arc.corrected_event_id = e.id) AS correction_count
FROM audit_events e
LEFT JOIN roster_changes rc ON rc.event_id = e.id
LEFT JOIN board_service_changes bsc ON bsc.event_id = e.id
LEFT JOIN identity_events ie ON ie.event_id = e.id
LEFT JOIN access_events ae ON ae.event_id = e.id
LEFT JOIN roster_redactions rr ON rr.event_id = e.id;
--> statement-breakpoint
-- THIS VIEW IS AT D1'S FIVE-TERM COMPOUND SELECT CEILING (see 0025).
CREATE VIEW IF NOT EXISTS audit_integrity_violations_v AS
-- Missing or duplicated typed detail.
SELECT e.id AS event_id, 'detail_cardinality' AS violation FROM audit_events e
WHERE ((SELECT COUNT(*) FROM roster_changes d WHERE d.event_id = e.id)
     + (SELECT COUNT(*) FROM board_service_changes d WHERE d.event_id = e.id)
     + (SELECT COUNT(*) FROM identity_events d WHERE d.event_id = e.id)
     + (SELECT COUNT(*) FROM access_events d WHERE d.event_id = e.id)
     + (SELECT COUNT(*) FROM roster_redactions d WHERE d.event_id = e.id)
     + (SELECT COUNT(*) FROM review_events d WHERE d.event_id = e.id)
     + (SELECT COUNT(*) FROM audit_record_corrections d WHERE d.event_id = e.id)) <> 1
UNION ALL
-- Causation crossing correlations, or pointing forward in local order.
SELECT e.id, 'causal_order' FROM audit_events e
JOIN audit_events c ON e.causing_event_id = c.id
WHERE c.correlation_id <> e.correlation_id
   OR c.correlation_sequence >= e.correlation_sequence
UNION ALL
-- A correction that does not point at a real event.
SELECT a.event_id, 'orphan_correction' FROM audit_record_corrections a
WHERE NOT EXISTS (SELECT 1 FROM audit_events e WHERE e.id = a.corrected_event_id)
UNION ALL
-- A redaction without its evidence or without cleanup work.
SELECT e.id, 'redaction_incomplete' FROM audit_events e
WHERE e.family = 'roster_redaction'
  AND (NOT EXISTS (SELECT 1 FROM roster_redactions r WHERE r.event_id = e.id)
    OR NOT EXISTS (SELECT 1 FROM redaction_tasks t WHERE t.redaction_event_id = e.id))
UNION ALL
-- A flag that no Review Event ever opened.
SELECT f.id, 'flag_without_opening_event' FROM review_flags f
WHERE NOT EXISTS (SELECT 1 FROM review_events v WHERE v.review_flag_id = f.id);
