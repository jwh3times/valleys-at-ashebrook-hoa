CREATE TABLE `resolutions` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`title` text NOT NULL,
	`body_md` text NOT NULL,
	`effective_date` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`adopted_by_motion_id` text,
	`supersedes_id` text,
	`visibility` text DEFAULT 'board' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`adopted_by_motion_id`) REFERENCES `motions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`supersedes_id`) REFERENCES `resolutions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `resolutions_number_unq` ON `resolutions` (`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `resolutions_supersedes_unq` ON `resolutions` (`supersedes_id`);--> statement-breakpoint
CREATE INDEX `resolutions_status_idx` ON `resolutions` (`status`);