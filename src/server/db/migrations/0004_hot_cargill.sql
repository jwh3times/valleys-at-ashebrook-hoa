ALTER TABLE `documents` ADD `content_hash` text;--> statement-breakpoint
CREATE INDEX `documents_content_hash_idx` ON `documents` (`content_hash`);