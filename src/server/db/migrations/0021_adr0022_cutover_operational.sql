-- ADR 0022 phase 1 of 4: cutover operational tables.
--
-- Operator-only cutover mode and write-freeze settings, plus the bounded
-- shadow-mismatch table. NEVER surfaced in the admin Site panel: the board may
-- not toggle the authorization model. Nothing reads these until phase 2.
--
-- `cutover_settings.write_freeze` outlives the migration; the rest drops in
-- phase 4. Every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS `cutover_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_account_id` text,
	FOREIGN KEY (`updated_by_account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "cutover_settings_key_check" CHECK("key" IN ('cutover_mode', 'write_freeze')),
	CONSTRAINT "cutover_settings_value_check" CHECK(("key" = 'cutover_mode' AND "value" IN ('legacy', 'derived')) OR ("key" = 'write_freeze' AND "value" IN ('off', 'on')))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `cutover_shadow_mismatches` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`source` text NOT NULL,
	`legacy_role` text,
	`derived_content_tier` text,
	`legacy_lot_count` integer NOT NULL,
	`derived_lot_count` integer NOT NULL,
	`explained_as` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`seen_count` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "cutover_shadow_source_check" CHECK("source" IN ('request', 'sweep')),
	CONSTRAINT "cutover_shadow_explained_as_check" CHECK("explained_as" IS NULL OR "explained_as" IN ('accepted_member_access_loss', 'board_member_api_passthrough'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `cutover_shadow_account_idx` ON `cutover_shadow_mismatches` (`account_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `cutover_shadow_unexplained_idx` ON `cutover_shadow_mismatches` (`explained_as`);
