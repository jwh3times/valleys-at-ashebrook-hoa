CREATE UNIQUE INDEX `properties_address_normalized_unq` ON `properties` (`address_normalized`);
--> statement-breakpoint
CREATE INDEX `owners_property_id_idx` ON `owners` (`property_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_property_links_user_property_unq` ON `user_property_links` (`user_id`,`property_id`);
--> statement-breakpoint
CREATE INDEX `property_verifications_user_id_idx` ON `property_verifications` (`user_id`);
--> statement-breakpoint
CREATE INDEX `manual_approval_queue_status_idx` ON `manual_approval_queue` (`status`);
--> statement-breakpoint
CREATE INDEX `documents_visibility_idx` ON `documents` (`visibility`);
--> statement-breakpoint
CREATE INDEX `announcements_visibility_date_idx` ON `announcements` (`visibility`,`date`);
