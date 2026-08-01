CREATE TABLE `member_attendance` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`property_id` text NOT NULL,
	`present` integer NOT NULL,
	`represented_by_owner_id` text,
	`via_proxy` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`represented_by_owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_attendance_meeting_property_unq` ON `member_attendance` (`meeting_id`,`property_id`);--> statement-breakpoint
CREATE TABLE `member_votes` (
	`id` text PRIMARY KEY NOT NULL,
	`motion_id` text NOT NULL,
	`property_id` text NOT NULL,
	`cast_by_owner_id` text,
	`via_proxy` integer DEFAULT false NOT NULL,
	`weight` integer NOT NULL,
	`choice` text NOT NULL,
	FOREIGN KEY (`motion_id`) REFERENCES `motions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`cast_by_owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_votes_motion_property_unq` ON `member_votes` (`motion_id`,`property_id`);--> statement-breakpoint
ALTER TABLE `motions` ADD `mover_owner_id` text REFERENCES owners(id);--> statement-breakpoint
ALTER TABLE `motions` ADD `second_owner_id` text REFERENCES owners(id);--> statement-breakpoint
ALTER TABLE `properties` ADD `vote_weight` integer DEFAULT 1 NOT NULL;