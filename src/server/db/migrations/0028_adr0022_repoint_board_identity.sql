-- ADR 0022 phase 4 precondition (#248, part 1 of 2): the meeting and elections
-- records stop naming a `board_people` identity and name a party-roster Person.
--
-- WHY THIS BLOCKS #212. Its removal sequence drops `board_people`, but five FK
-- columns reference it from tables phase 4 KEEPS — `board_attendance.person_id`,
-- `motions.mover_person_id`/`second_person_id`, `board_votes.person_id`, and
-- `candidates.board_person_id`. The drop cannot happen while they exist. Part 2
-- does the same for the seven `owners` columns.
--
-- `motions` COLLAPSES its two identity pairs into one. It carried
-- `mover_person_id`/`second_person_id` (board_people, board motions) AND
-- `mover_owner_id`/`second_owner_id` (owners, member motions), told apart only
-- by the parent meeting's `body`. The party roster has ONE Person concept, so
-- two FKs to the same table earn nothing: the owner pair is DROPPED and the
-- person pair is repointed. Nothing ever wrote the owner pair (phase 3b), and
-- it measured 0 rows in production on 2026-08-20.
--
-- IDENTITY THAT CANNOT BE MAPPED IS NOT INVENTED. A legacy `board_people.id` is
-- not a `people.party_id`; the backfill's mapping (`derivedId`) is a JS digest
-- that SQL cannot compute. So a value is carried over only when it already
-- resolves to a Person: nullable columns become NULL, and the two NOT NULL
-- columns drop the row rather than fabricate a link. On production this is a
-- no-op in the strictest sense — `board_people`, `board_attendance`,
-- `board_votes`, `motions`, and `candidates` all measured 0 rows before this
-- was written. The filter exists so the migration is also correct against a
-- database that is not empty, rather than leaving dangling FKs behind.
--
-- The `__new` copy dance (0024/0026 precedent), not the 0027 DROP+CREATE: these
-- tables are not provably empty everywhere, only in production. D1 supports
-- PRAGMA defer_foreign_keys, NOT PRAGMA foreign_keys. No view references any of
-- the tables rebuilt here (`audit_review_queue_v` reads
-- `review_flags.impacted_motion_id` without joining `motions`), so the
-- drop-and-recreate-views step that 0024, 0025, 0026, and 0027 each needed does
-- not apply. A fifth table, `ballot_choices`, is rebuilt at the very end for an
-- unrelated reason explained there.
--
-- `motions` is rebuilt LAST: six FKs point into it (`board_votes.motion_id`,
-- `motion_eligibility.motion_id`, `member_votes.motion_id`,
-- `meetings.approved_by_motion_id`, `resolutions.adopted_by_motion_id`,
-- `review_flags.impacted_motion_id`), and `board_votes` is itself rebuilt here,
-- so doing motions last keeps every other rename away from the window where it
-- is briefly absent.
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_board_attendance` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`person_id` text NOT NULL,
	`present` integer NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
INSERT INTO `__new_board_attendance`("id", "meeting_id", "person_id", "present") SELECT a."id", a."meeting_id", a."person_id", a."present" FROM `board_attendance` a WHERE EXISTS (SELECT 1 FROM `people` p WHERE p."party_id" = a."person_id");--> statement-breakpoint
DROP TABLE `board_attendance`;--> statement-breakpoint
ALTER TABLE `__new_board_attendance` RENAME TO `board_attendance`;--> statement-breakpoint
CREATE UNIQUE INDEX `board_attendance_meeting_person_unq` ON `board_attendance` (`meeting_id`,`person_id`);--> statement-breakpoint
CREATE TABLE `__new_board_votes` (
	`id` text PRIMARY KEY NOT NULL,
	`motion_id` text NOT NULL,
	`person_id` text NOT NULL,
	`choice` text NOT NULL,
	FOREIGN KEY (`motion_id`) REFERENCES `motions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
INSERT INTO `__new_board_votes`("id", "motion_id", "person_id", "choice") SELECT v."id", v."motion_id", v."person_id", v."choice" FROM `board_votes` v WHERE EXISTS (SELECT 1 FROM `people` p WHERE p."party_id" = v."person_id");--> statement-breakpoint
DROP TABLE `board_votes`;--> statement-breakpoint
ALTER TABLE `__new_board_votes` RENAME TO `board_votes`;--> statement-breakpoint
CREATE UNIQUE INDEX `board_votes_motion_person_unq` ON `board_votes` (`motion_id`,`person_id`);--> statement-breakpoint
CREATE TABLE `__new_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`election_id` text NOT NULL,
	`full_name` text NOT NULL,
	`person_id` text,
	`statement_md` text,
	`sequence` integer NOT NULL,
	`votes` integer,
	`won` integer DEFAULT false NOT NULL,
	`withdrawn` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`election_id`) REFERENCES `elections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
INSERT INTO `__new_candidates`("id", "election_id", "full_name", "person_id", "statement_md", "sequence", "votes", "won", "withdrawn", "created_at") SELECT c."id", c."election_id", c."full_name", CASE WHEN EXISTS (SELECT 1 FROM `people` p WHERE p."party_id" = c."board_person_id") THEN c."board_person_id" END, c."statement_md", c."sequence", c."votes", c."won", c."withdrawn", c."created_at" FROM `candidates` c;--> statement-breakpoint
DROP TABLE `candidates`;--> statement-breakpoint
ALTER TABLE `__new_candidates` RENAME TO `candidates`;--> statement-breakpoint
CREATE INDEX `candidates_election_id_idx` ON `candidates` (`election_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `candidates_election_sequence_unq` ON `candidates` (`election_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `__new_motions` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`text` text NOT NULL,
	`mover_person_id` text,
	`second_person_id` text,
	`outcome` text NOT NULL,
	`voting_state` text DEFAULT 'none' NOT NULL,
	`voting_revision` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mover_person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`second_person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
INSERT INTO `__new_motions`("id", "meeting_id", "sequence", "text", "mover_person_id", "second_person_id", "outcome", "voting_state", "voting_revision", "created_by", "created_at", "updated_at") SELECT m."id", m."meeting_id", m."sequence", m."text", CASE WHEN EXISTS (SELECT 1 FROM `people` p WHERE p."party_id" = m."mover_person_id") THEN m."mover_person_id" END, CASE WHEN EXISTS (SELECT 1 FROM `people` p WHERE p."party_id" = m."second_person_id") THEN m."second_person_id" END, m."outcome", m."voting_state", m."voting_revision", m."created_by", m."created_at", m."updated_at" FROM `motions` m;--> statement-breakpoint
DROP TABLE `motions`;--> statement-breakpoint
ALTER TABLE `__new_motions` RENAME TO `motions`;--> statement-breakpoint
CREATE INDEX `motions_meeting_id_idx` ON `motions` (`meeting_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `motions_meeting_sequence_unq` ON `motions` (`meeting_id`,`sequence`);
--> statement-breakpoint
-- `ballot_choices` is rebuilt for ONE reason: `candidate_id` moves from
-- ON DELETE RESTRICT to NO ACTION. No column is added, removed, or renamed —
-- the identity-unlinked shape ADR 0020 fixes is byte-for-byte what it was, and
-- this table still carries no ballot, property, owner, proxy, caster, or
-- timestamp column.
--
-- WHY. In SQLite, RESTRICT is checked IMMEDIATELY while NO ACTION is checked at
-- the END OF THE STATEMENT. Both refuse to delete a candidate that retained
-- choices still reference, which is the rule this FK exists to enforce. They
-- differ only when the parent ELECTION is deleted, which cascades to
-- `candidates` and `ballot_choices` alike: under RESTRICT, whichever cascade
-- SQLite happens to run first decides whether the delete succeeds, and
-- rebuilding `candidates` above is enough to flip that coin. Under NO ACTION
-- both rows are gone by the time the check runs, so the election cascade
-- always succeeds and a bare candidate delete is always refused.
--
-- The application never reaches the ambiguous case — DELETE /api/admin/elections
-- removes only a draft, and a draft conducted election has no choices — but a
-- schema whose behavior depends on table creation order is a trap for the next
-- rebuild, and part 2 of #248 rebuilds four more tables. AGENTS.md already
-- records this same RESTRICT-vs-NO-ACTION timing distinction for the
-- `mover_owner_id` column that part 1 drops.
CREATE TABLE `__new_ballot_choices` (
	`id` text PRIMARY KEY NOT NULL,
	`election_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`weight` integer NOT NULL,
	FOREIGN KEY (`election_id`) REFERENCES `elections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`candidate_id`) REFERENCES `candidates`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ballot_choices_weight_nonnegative" CHECK("weight" >= 0)
);--> statement-breakpoint
INSERT INTO `__new_ballot_choices`("id", "election_id", "candidate_id", "weight") SELECT "id", "election_id", "candidate_id", "weight" FROM `ballot_choices`;--> statement-breakpoint
DROP TABLE `ballot_choices`;--> statement-breakpoint
ALTER TABLE `__new_ballot_choices` RENAME TO `ballot_choices`;--> statement-breakpoint
CREATE INDEX `ballot_choices_election_id_idx` ON `ballot_choices` (`election_id`);
