CREATE TABLE `ballots` (
	`id` text PRIMARY KEY NOT NULL,
	`election_id` text NOT NULL,
	`property_id` text NOT NULL,
	`weight` integer NOT NULL,
	`via_proxy` integer DEFAULT false NOT NULL,
	`cast_by_owner_id` text,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`election_id`) REFERENCES `elections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`cast_by_owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ballots_election_property_unq` ON `ballots` (`election_id`,`property_id`);--> statement-breakpoint
CREATE INDEX `ballots_election_id_idx` ON `ballots` (`election_id`);--> statement-breakpoint
CREATE TABLE `candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`election_id` text NOT NULL,
	`full_name` text NOT NULL,
	`board_person_id` text,
	`statement_md` text,
	`sequence` integer NOT NULL,
	`votes` integer,
	`won` integer DEFAULT false NOT NULL,
	`withdrawn` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`election_id`) REFERENCES `elections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`board_person_id`) REFERENCES `board_people`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `candidates_election_id_idx` ON `candidates` (`election_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `candidates_election_sequence_unq` ON `candidates` (`election_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `elections` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text,
	`title` text NOT NULL,
	`seats` integer NOT NULL,
	`election_date` text NOT NULL,
	`source` text DEFAULT 'recorded' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`visibility` text DEFAULT 'board' NOT NULL,
	`certified_at` integer,
	`certified_by` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `elections_status_idx` ON `elections` (`status`);--> statement-breakpoint
CREATE INDEX `elections_meeting_id_idx` ON `elections` (`meeting_id`);--> statement-breakpoint
ALTER TABLE `board_terms` ADD `election_id` text REFERENCES elections(id);