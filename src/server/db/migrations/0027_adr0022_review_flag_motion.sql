-- ADR 0022 phase 3d (#220): the review-flag machinery gains its first writer.
--
-- `review_flags` is REBUILT (provably empty — created by 0020, no writer until
-- this phase) to add `impacted_motion_id`: a `vote_reset_on_transfer` flag must
-- name the motion whose vote was reset, because the reset DELETES the
-- member_votes row and the existing `impacted_member_vote_id` FK can no longer
-- reference it. RESTRICT is safe — motion deletion already refuses while any
-- live-voting history exists.
--
-- The never-written table takes the 0026 `identity_events` precedent: plain
-- DROP + CREATE, no __new copy dance. `audit_review_queue_v` references the
-- table, so it is dropped first and recreated at the end with the new impacted
-- kind (the 0024/0025/0026 view precedent). D1 supports
-- PRAGMA defer_foreign_keys, NOT PRAGMA foreign_keys — and with no rows and no
-- incoming FK on `review_flags`, neither is needed here.
DROP VIEW IF EXISTS audit_review_queue_v;--> statement-breakpoint
DROP TABLE IF EXISTS `review_flags`;--> statement-breakpoint
CREATE TABLE `review_flags` (
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
	`impacted_motion_id` text,
	`impacted_ballot_id` text,
	`impacted_board_term_id` text,
	`impacted_access_grant_id` text,
	`impacted_event_id` text,
	FOREIGN KEY (`source_event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`impacted_proxy_id`) REFERENCES `proxies`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`impacted_member_attendance_id`) REFERENCES `member_attendance`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`impacted_member_vote_id`) REFERENCES `member_votes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`impacted_motion_id`) REFERENCES `motions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`impacted_ballot_id`) REFERENCES `ballots`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`impacted_board_term_id`) REFERENCES `board_service_terms`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`impacted_access_grant_id`) REFERENCES `access_grants`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`impacted_event_id`) REFERENCES `audit_events`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "review_flags_category_check" CHECK("category" IN ('intervening_action_backdated', 'authority_lost_pending_occasion', 'vote_reset_on_transfer', 'ballot_final_after_transfer')),
	CONSTRAINT "review_flags_status_check" CHECK("status" IN ('open', 'resolved')),
	CONSTRAINT "review_flags_resolution_paired" CHECK(("status" = 'resolved') = ("resolved_at" IS NOT NULL)),
	CONSTRAINT "review_flags_impact_at_most_one" CHECK((CASE WHEN "impacted_proxy_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "impacted_member_attendance_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "impacted_member_vote_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "impacted_motion_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "impacted_ballot_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "impacted_board_term_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "impacted_access_grant_id" IS NULL THEN 0 ELSE 1 END + CASE WHEN "impacted_event_id" IS NULL THEN 0 ELSE 1 END) <= 1)
);
--> statement-breakpoint
CREATE INDEX `review_flags_open_idx` ON `review_flags` (`status`,`opened_at`);--> statement-breakpoint
CREATE INDEX `review_flags_source_idx` ON `review_flags` (`source_event_id`);--> statement-breakpoint

-- Recreated from 0023 with the one addition of the motion impacted kind. Open
-- flags with their cause and typed impact. A flag never rewrites or
-- invalidates the action it references; this is a work queue, not a verdict.
CREATE VIEW IF NOT EXISTS audit_review_queue_v AS
SELECT
  f.id AS flag_id,
  f.category,
  f.status,
  f.opened_at,
  f.source_event_id,
  e.event_kind AS source_event_kind,
  e.correlation_id,
  e.recorded_at AS source_recorded_at,
  CASE
    WHEN f.impacted_proxy_id IS NOT NULL THEN 'proxy'
    WHEN f.impacted_member_attendance_id IS NOT NULL THEN 'member_attendance'
    WHEN f.impacted_member_vote_id IS NOT NULL THEN 'member_vote'
    WHEN f.impacted_motion_id IS NOT NULL THEN 'motion'
    WHEN f.impacted_ballot_id IS NOT NULL THEN 'ballot'
    WHEN f.impacted_board_term_id IS NOT NULL THEN 'board_term'
    WHEN f.impacted_access_grant_id IS NOT NULL THEN 'access_grant'
    WHEN f.impacted_event_id IS NOT NULL THEN 'audit_event'
  END AS impacted_kind,
  COALESCE(
    f.impacted_proxy_id, f.impacted_member_attendance_id, f.impacted_member_vote_id,
    f.impacted_motion_id, f.impacted_ballot_id, f.impacted_board_term_id,
    f.impacted_access_grant_id, f.impacted_event_id
  ) AS impacted_id
FROM review_flags f
JOIN audit_events e ON e.id = f.source_event_id
WHERE f.status = 'open';
