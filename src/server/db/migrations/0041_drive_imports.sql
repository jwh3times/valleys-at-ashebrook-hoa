-- #290 slice 3 (spec 2026-10-18 decision 6): where each imported document came
-- from in the association's Google Drive. One row per imported document,
-- removed with it (ON DELETE CASCADE), so deleting an import frees that Drive
-- version to be imported again.
--
-- The unique index is the Drive-duplicate rule inside the write (spec review
-- Q5): two board admins importing the same unchanged version at once get one
-- import and one refusal. `export_format` is NULL for a file Drive stores as-is
-- and that was downloaded unchanged.
-- Safe in either order with the deploy: nothing reads or writes it until the
-- DRIVE_* secrets are set.
CREATE TABLE `drive_imports` (
	`document_id` text PRIMARY KEY NOT NULL REFERENCES `documents`(`id`) ON DELETE CASCADE,
	`drive_file_id` text NOT NULL,
	`drive_mime_type` text NOT NULL,
	`drive_modified_time` text NOT NULL,
	`export_format` text CHECK (`export_format` IN ('pdf', 'xlsx')),
	`google_sub` text NOT NULL,
	`imported_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drive_imports_file_version` ON `drive_imports` (`drive_file_id`, `drive_modified_time`);
