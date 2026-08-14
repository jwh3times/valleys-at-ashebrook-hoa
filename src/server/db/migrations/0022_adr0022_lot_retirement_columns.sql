-- ADR 0022 phase 1 of 4: Lot retirement columns on `properties`.
--
-- Isolated into its own file on purpose. SQLite has no
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS, so these are the only two
-- statements in phase 1 that are not re-runnable. Keeping them alone bounds
-- the blast radius of a half-apply to two statements a human can hand-fix,
-- instead of stranding a 300-line file.
--
-- Both are nullable and additive, so this is behaviorally inert. `retired_day`
-- may be NULL while `retired_at` is set, for accepted legacy rows only:
-- `status = 'inactive'` carries no date, and stamping the migration day would
-- assert a retirement that did not happen that day.

ALTER TABLE `properties` ADD `retired_day` text;
--> statement-breakpoint
ALTER TABLE `properties` ADD `retired_at` integer;
