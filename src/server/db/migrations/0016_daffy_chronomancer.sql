CREATE TABLE `ballot_choices` (
	`id` text PRIMARY KEY NOT NULL,
	`election_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`weight` integer NOT NULL,
	FOREIGN KEY (`election_id`) REFERENCES `elections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidates`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ballot_choices_weight_nonnegative" CHECK("ballot_choices"."weight" >= 0)
);
--> statement-breakpoint
CREATE INDEX `ballot_choices_election_id_idx` ON `ballot_choices` (`election_id`);--> statement-breakpoint
CREATE TABLE `election_eligibility` (
	`election_id` text NOT NULL,
	`property_id` text NOT NULL,
	`weight` integer NOT NULL,
	FOREIGN KEY (`election_id`) REFERENCES `elections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "election_eligibility_weight_nonnegative" CHECK("election_eligibility"."weight" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `election_eligibility_parent_property_unq` ON `election_eligibility` (`election_id`,`property_id`);--> statement-breakpoint
CREATE TABLE `motion_eligibility` (
	`motion_id` text NOT NULL,
	`property_id` text NOT NULL,
	`weight` integer NOT NULL,
	FOREIGN KEY (`motion_id`) REFERENCES `motions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "motion_eligibility_weight_nonnegative" CHECK("motion_eligibility"."weight" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `motion_eligibility_parent_property_unq` ON `motion_eligibility` (`motion_id`,`property_id`);--> statement-breakpoint
ALTER TABLE `motions` ADD `voting_state` text DEFAULT 'none' NOT NULL;