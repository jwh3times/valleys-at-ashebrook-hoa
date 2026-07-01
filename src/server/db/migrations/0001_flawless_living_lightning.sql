CREATE TABLE `announcements` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`date` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`visibility` text DEFAULT 'public' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`visibility` text DEFAULT 'board' NOT NULL,
	`r2_key` text NOT NULL,
	`filename` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`content_type` text NOT NULL,
	`uploaded_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
