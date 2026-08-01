CREATE TABLE `board_attendance` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`person_id` text NOT NULL,
	`present` integer NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `board_people`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `board_attendance_meeting_person_unq` ON `board_attendance` (`meeting_id`,`person_id`);--> statement-breakpoint
CREATE TABLE `board_votes` (
	`id` text PRIMARY KEY NOT NULL,
	`motion_id` text NOT NULL,
	`person_id` text NOT NULL,
	`choice` text NOT NULL,
	FOREIGN KEY (`motion_id`) REFERENCES `motions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `board_people`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `board_votes_motion_person_unq` ON `board_votes` (`motion_id`,`person_id`);--> statement-breakpoint
CREATE TABLE `meetings` (
	`id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`kind` text NOT NULL,
	`date` text NOT NULL,
	`start_time` text,
	`location` text,
	`title` text NOT NULL,
	`summary_md` text,
	`document_id` text,
	`quorum_required` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`visibility` text DEFAULT 'board' NOT NULL,
	`approved_at` integer,
	`approved_by` text,
	`approved_by_motion_id` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `meetings_status_date_idx` ON `meetings` (`status`,`date`);--> statement-breakpoint
CREATE INDEX `meetings_body_idx` ON `meetings` (`body`);--> statement-breakpoint
CREATE TABLE `motions` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`text` text NOT NULL,
	`mover_person_id` text,
	`second_person_id` text,
	`outcome` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mover_person_id`) REFERENCES `board_people`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`second_person_id`) REFERENCES `board_people`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `motions_meeting_id_idx` ON `motions` (`meeting_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `motions_meeting_sequence_unq` ON `motions` (`meeting_id`,`sequence`);