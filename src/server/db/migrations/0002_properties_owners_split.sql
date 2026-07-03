DROP TABLE IF EXISTS `owners`;
--> statement-breakpoint
DROP TABLE IF EXISTS `property_verifications`;
--> statement-breakpoint
DROP TABLE IF EXISTS `user_property_links`;
--> statement-breakpoint
CREATE TABLE `properties` (
	`id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`address_normalized` text NOT NULL,
	`unit` text,
	`status` text DEFAULT 'active' NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `owners` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`full_name` text NOT NULL,
	`phone` text,
	`email` text,
	`status` text DEFAULT 'active' NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_property_links` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`property_id` text NOT NULL,
	`verified_at` integer NOT NULL,
	`method` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `property_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`property_id` text NOT NULL,
	`channel` text NOT NULL,
	`code_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL
);
