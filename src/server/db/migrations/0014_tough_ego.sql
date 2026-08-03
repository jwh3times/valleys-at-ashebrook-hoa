CREATE TABLE `proxies` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`grantor_owner_id` text NOT NULL,
	`holder_name` text NOT NULL,
	`holder_owner_id` text,
	`meeting_id` text,
	`election_id` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`grantor_owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`holder_owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`election_id`) REFERENCES `elections`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "proxies_one_occasion" CHECK(("proxies"."meeting_id" IS NOT NULL) <> ("proxies"."election_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proxies_property_meeting_unq` ON `proxies` (`property_id`,`meeting_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `proxies_property_election_unq` ON `proxies` (`property_id`,`election_id`);--> statement-breakpoint
CREATE INDEX `proxies_meeting_id_idx` ON `proxies` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `proxies_election_id_idx` ON `proxies` (`election_id`);--> statement-breakpoint
ALTER TABLE `ballots` ADD `proxy_id` text REFERENCES proxies(id);--> statement-breakpoint
ALTER TABLE `member_attendance` ADD `proxy_id` text REFERENCES proxies(id);--> statement-breakpoint
ALTER TABLE `member_votes` ADD `proxy_id` text REFERENCES proxies(id);