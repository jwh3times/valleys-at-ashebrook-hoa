-- One-way ADR 0022 contract. Apply with the matching deployment under the
-- write freeze, after the private legacy-note preservation and local rehearsal.
-- SQLite updates stored foreign keys and views during the two renames.
DROP TABLE `user_property_links`;
DROP TABLE `property_verifications`;
DROP TABLE `manual_approval_queue`;
DROP TABLE `owners`;
DROP TABLE `board_terms`;
DROP TABLE `board_people`;
ALTER TABLE `properties` RENAME TO `lots`;
ALTER TABLE `board_service_terms` RENAME TO `board_terms`;
DROP TABLE `cutover_shadow_mismatches`;
DELETE FROM `cutover_settings` WHERE `key` = 'cutover_mode';
-- Better Auth's admin plugin structurally requires this field, but it no
-- longer carries site authority. New Accounts also receive this neutral value.
UPDATE `users` SET `role` = 'visitor';
