ALTER TABLE `meetings` RENAME COLUMN `approved_by_motion_id` TO `approved_by_motion_id_legacy`;--> statement-breakpoint
ALTER TABLE `meetings` ADD COLUMN `approved_by_motion_id` text REFERENCES `motions`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
UPDATE `meetings`
SET `approved_by_motion_id` = `approved_by_motion_id_legacy`
WHERE `approved_by_motion_id_legacy` IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM `motions`
    WHERE `motions`.`id` = `meetings`.`approved_by_motion_id_legacy`
  );--> statement-breakpoint
ALTER TABLE `meetings` DROP COLUMN `approved_by_motion_id_legacy`;
