-- Property-first lookup indexes on the two member-record tables (#237).
--
-- Both tables already carry a unique index whose FIRST column is the occasion
-- — member_attendance_meeting_property_unq (meeting_id, property_id) and
-- member_votes_motion_property_unq (motion_id, property_id) — so neither can
-- serve a query that knows the LOT and not the occasion. Three such queries
-- exist, all in the roster's transfer-effects engine
-- (src/server/roster/transfer-effects.ts): the open-motion vote reset for a
-- departing Lot, and the two retrospective backdated-action sweeps over
-- member_attendance and member_votes.
--
-- Additive and safe in either order with any deploy: an index changes no
-- shape and no behavior, only the plan SQLite picks.
CREATE INDEX IF NOT EXISTS member_attendance_property_id_idx ON member_attendance (property_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS member_votes_property_id_idx ON member_votes (property_id);
