CREATE TABLE `board_people` (
	`id` text PRIMARY KEY NOT NULL,
	`full_name` text NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `board_terms` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`title` text,
	`term_start` text NOT NULL,
	`term_end` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `board_people`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `board_terms_person_id_idx` ON `board_terms` (`person_id`);--> statement-breakpoint
CREATE INDEX `board_terms_term_end_idx` ON `board_terms` (`term_end`);