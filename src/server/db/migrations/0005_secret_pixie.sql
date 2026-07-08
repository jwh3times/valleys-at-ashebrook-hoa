CREATE TABLE `__new_manual_approval_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`claimed_address` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_manual_approval_queue`("id", "user_id", "claimed_address", "reason", "status", "created_at") SELECT "id", "user_id", "claimed_address", "reason", "status", "created_at" FROM `manual_approval_queue`;--> statement-breakpoint
DROP TABLE `manual_approval_queue`;--> statement-breakpoint
ALTER TABLE `__new_manual_approval_queue` RENAME TO `manual_approval_queue`;--> statement-breakpoint
CREATE INDEX `manual_approval_queue_status_idx` ON `manual_approval_queue` (`status`);--> statement-breakpoint
CREATE TABLE `__new_owners` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`full_name` text NOT NULL,
	`phone` text,
	`email` text,
	`status` text DEFAULT 'active' NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_owners`("id", "property_id", "full_name", "phone", "email", "status", "notes", "created_at", "updated_at") SELECT "id", "property_id", "full_name", "phone", "email", "status", "notes", "created_at", "updated_at" FROM `owners`;--> statement-breakpoint
DROP TABLE `owners`;--> statement-breakpoint
ALTER TABLE `__new_owners` RENAME TO `owners`;--> statement-breakpoint
CREATE INDEX `owners_property_id_idx` ON `owners` (`property_id`);--> statement-breakpoint
CREATE TABLE `__new_property_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`property_id` text NOT NULL,
	`channel` text NOT NULL,
	`code_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_property_verifications`("id", "user_id", "property_id", "channel", "code_hash", "expires_at", "attempts", "consumed_at", "created_at") SELECT "id", "user_id", "property_id", "channel", "code_hash", "expires_at", "attempts", "consumed_at", "created_at" FROM `property_verifications`;--> statement-breakpoint
DROP TABLE `property_verifications`;--> statement-breakpoint
ALTER TABLE `__new_property_verifications` RENAME TO `property_verifications`;--> statement-breakpoint
CREATE INDEX `property_verifications_user_id_idx` ON `property_verifications` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_user_property_links` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`property_id` text NOT NULL,
	`verified_at` integer NOT NULL,
	`method` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_user_property_links`("id", "user_id", "property_id", "verified_at", "method") SELECT "id", "user_id", "property_id", "verified_at", "method" FROM `user_property_links`;--> statement-breakpoint
DROP TABLE `user_property_links`;--> statement-breakpoint
ALTER TABLE `__new_user_property_links` RENAME TO `user_property_links`;--> statement-breakpoint
CREATE UNIQUE INDEX `user_property_links_user_property_unq` ON `user_property_links` (`user_id`,`property_id`);
