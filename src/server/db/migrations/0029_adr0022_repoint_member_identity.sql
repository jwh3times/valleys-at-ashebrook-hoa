-- ADR 0022 phase 4 precondition (#248, part 2 of 2): the member meeting,
-- elections, and proxies records stop naming a legacy `owners` identity and
-- name a party-roster Person. Part 1 (migration 0028) did the same for the
-- five `board_people` columns.
--
-- WHY THIS BLOCKS #212. Its removal sequence drops `owners`, but five FK
-- columns reference it from tables phase 4 KEEPS:
--
--   member_attendance.represented_by_owner_id  (set null)
--   member_votes.cast_by_owner_id              (set null)
--   ballots.cast_by_owner_id                   (set null)
--   proxies.grantor_owner_id                   (NOT NULL, restrict)
--   proxies.holder_owner_id                    (set null)
--
-- The four `set null` columns are why this is not merely tidiness: dropping
-- `owners` underneath them would SUCCEED and silently erase who acted,
-- leaving the record looking complete. After this migration each column is
-- `*_person_id`, references `people(party_id)`, and keeps its ON DELETE
-- action bit-for-bit.
--
-- IDENTITY THAT CANNOT BE MAPPED IS NOT INVENTED (the 0028 rule). A legacy
-- `owners.id` is not a `people.party_id`; the backfill's mapping (`derivedId`)
-- is a JS digest SQL cannot compute. A value is carried over only when it
-- already resolves to a Person: the four nullable columns become NULL, and
-- `proxies.grantor_person_id` — NOT NULL — drops the row rather than
-- fabricate a grantor. Because `member_attendance`, `member_votes`, and
-- `ballots` cite `proxies` through their actionless `proxy_id` FK, each of
-- their rebuilds nulls any `proxy_id` whose proxy row this same file is about
-- to drop, so no dangling reference survives to fail the deferred FK check.
-- On production this is a no-op in the strictest sense — all five columns
-- measured 0 non-null values on 2026-08-20, before the #212 exercise
-- checklist (which is what fills them) has run. The mapping branches exist so
-- the migration is also correct against a database that is not empty.
--
-- The `__new` copy dance (0024/0026/0028 precedent), not the 0027
-- DROP+CREATE: these tables are only provably empty in production. D1
-- supports PRAGMA defer_foreign_keys, NOT PRAGMA foreign_keys. No view
-- references any of the four tables rebuilt here, so the
-- drop-and-recreate-views step that 0024–0027 each needed does not apply.
--
-- `proxies` is rebuilt LAST: three FKs point into it (`member_attendance.
-- proxy_id`, `member_votes.proxy_id`, `ballots.proxy_id`), and all three
-- citing tables are themselves rebuilt here, so doing proxies last keeps
-- every other rebuild away from the window where it is briefly absent — the
-- same reasoning that put `motions` last in 0028. Those three `proxy_id` FKs
-- are deliberately recreated WITHOUT an ON DELETE action (NO ACTION): that is
-- what the ALTER-added columns have carried since 0014, deletes are governed
-- by the route's pre-check (ADR 0018), and NO ACTION's end-of-statement
-- timing is also what keeps a meeting or election delete — which cascades to
-- proxies and the citing record alike — independent of which cascade SQLite
-- runs first (the RESTRICT coin-flip 0028 documents on ballot_choices).
--
-- DEPLOY ORDERING: like 0028 and unlike every migration before it, this file
-- is NOT safe in either order. The merged code reads and writes only the
-- renamed columns, and Workers Builds deploys on merge while deploys never
-- apply migrations — so the operator applies this with `db:migrate:remote`
-- before or together with the deploy, ideally under the write freeze.
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_member_attendance` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`property_id` text NOT NULL,
	`present` integer NOT NULL,
	`represented_by_person_id` text,
	`proxy_id` text,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`represented_by_person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`proxy_id`) REFERENCES `proxies`(`id`)
);--> statement-breakpoint
INSERT INTO `__new_member_attendance`("id", "meeting_id", "property_id", "present", "represented_by_person_id", "proxy_id") SELECT a."id", a."meeting_id", a."property_id", a."present", CASE WHEN EXISTS (SELECT 1 FROM `people` p WHERE p."party_id" = a."represented_by_owner_id") THEN a."represented_by_owner_id" END, CASE WHEN a."proxy_id" IS NOT NULL AND EXISTS (SELECT 1 FROM `proxies` px INNER JOIN `people` p ON p."party_id" = px."grantor_owner_id" WHERE px."id" = a."proxy_id") THEN a."proxy_id" END FROM `member_attendance` a;--> statement-breakpoint
DROP TABLE `member_attendance`;--> statement-breakpoint
ALTER TABLE `__new_member_attendance` RENAME TO `member_attendance`;--> statement-breakpoint
CREATE UNIQUE INDEX `member_attendance_meeting_property_unq` ON `member_attendance` (`meeting_id`,`property_id`);--> statement-breakpoint
CREATE TABLE `__new_member_votes` (
	`id` text PRIMARY KEY NOT NULL,
	`motion_id` text NOT NULL,
	`property_id` text NOT NULL,
	`cast_by_person_id` text,
	`weight` integer NOT NULL,
	`choice` text NOT NULL,
	`proxy_id` text,
	FOREIGN KEY (`motion_id`) REFERENCES `motions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`cast_by_person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`proxy_id`) REFERENCES `proxies`(`id`)
);--> statement-breakpoint
INSERT INTO `__new_member_votes`("id", "motion_id", "property_id", "cast_by_person_id", "weight", "choice", "proxy_id") SELECT v."id", v."motion_id", v."property_id", CASE WHEN EXISTS (SELECT 1 FROM `people` p WHERE p."party_id" = v."cast_by_owner_id") THEN v."cast_by_owner_id" END, v."weight", v."choice", CASE WHEN v."proxy_id" IS NOT NULL AND EXISTS (SELECT 1 FROM `proxies` px INNER JOIN `people` p ON p."party_id" = px."grantor_owner_id" WHERE px."id" = v."proxy_id") THEN v."proxy_id" END FROM `member_votes` v;--> statement-breakpoint
DROP TABLE `member_votes`;--> statement-breakpoint
ALTER TABLE `__new_member_votes` RENAME TO `member_votes`;--> statement-breakpoint
CREATE UNIQUE INDEX `member_votes_motion_property_unq` ON `member_votes` (`motion_id`,`property_id`);--> statement-breakpoint
CREATE TABLE `__new_ballots` (
	`id` text PRIMARY KEY NOT NULL,
	`election_id` text NOT NULL,
	`property_id` text NOT NULL,
	`weight` integer NOT NULL,
	`cast_by_person_id` text,
	`recorded_at` integer NOT NULL,
	`proxy_id` text,
	FOREIGN KEY (`election_id`) REFERENCES `elections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`cast_by_person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`proxy_id`) REFERENCES `proxies`(`id`)
);--> statement-breakpoint
INSERT INTO `__new_ballots`("id", "election_id", "property_id", "weight", "cast_by_person_id", "recorded_at", "proxy_id") SELECT b."id", b."election_id", b."property_id", b."weight", CASE WHEN EXISTS (SELECT 1 FROM `people` p WHERE p."party_id" = b."cast_by_owner_id") THEN b."cast_by_owner_id" END, b."recorded_at", CASE WHEN b."proxy_id" IS NOT NULL AND EXISTS (SELECT 1 FROM `proxies` px INNER JOIN `people` p ON p."party_id" = px."grantor_owner_id" WHERE px."id" = b."proxy_id") THEN b."proxy_id" END FROM `ballots` b;--> statement-breakpoint
DROP TABLE `ballots`;--> statement-breakpoint
ALTER TABLE `__new_ballots` RENAME TO `ballots`;--> statement-breakpoint
CREATE UNIQUE INDEX `ballots_election_property_unq` ON `ballots` (`election_id`,`property_id`);--> statement-breakpoint
CREATE INDEX `ballots_election_id_idx` ON `ballots` (`election_id`);--> statement-breakpoint
CREATE TABLE `__new_proxies` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`grantor_person_id` text NOT NULL,
	`holder_name` text NOT NULL,
	`holder_person_id` text,
	`meeting_id` text,
	`election_id` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`grantor_person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`holder_person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`election_id`) REFERENCES `elections`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "proxies_one_occasion" CHECK(("meeting_id" IS NOT NULL) <> ("election_id" IS NOT NULL))
);--> statement-breakpoint
INSERT INTO `__new_proxies`("id", "property_id", "grantor_person_id", "holder_name", "holder_person_id", "meeting_id", "election_id", "created_by", "created_at", "updated_at") SELECT x."id", x."property_id", x."grantor_owner_id", x."holder_name", CASE WHEN EXISTS (SELECT 1 FROM `people` p WHERE p."party_id" = x."holder_owner_id") THEN x."holder_owner_id" END, x."meeting_id", x."election_id", x."created_by", x."created_at", x."updated_at" FROM `proxies` x WHERE EXISTS (SELECT 1 FROM `people` p WHERE p."party_id" = x."grantor_owner_id");--> statement-breakpoint
DROP TABLE `proxies`;--> statement-breakpoint
ALTER TABLE `__new_proxies` RENAME TO `proxies`;--> statement-breakpoint
CREATE UNIQUE INDEX `proxies_property_meeting_unq` ON `proxies` (`property_id`,`meeting_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `proxies_property_election_unq` ON `proxies` (`property_id`,`election_id`);--> statement-breakpoint
CREATE INDEX `proxies_meeting_id_idx` ON `proxies` (`meeting_id`);--> statement-breakpoint
CREATE INDEX `proxies_election_id_idx` ON `proxies` (`election_id`);
