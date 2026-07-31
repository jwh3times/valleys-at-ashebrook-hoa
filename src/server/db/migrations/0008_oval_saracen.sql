CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`template_key` text,
	`content_md` text NOT NULL,
	`sources_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `reports_created_at_idx` ON `reports` (`created_at`);