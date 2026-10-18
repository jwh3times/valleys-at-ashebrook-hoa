-- #290 slice 2 (ADR 0027, spec 2026-10-18 decision 1): the association's one
-- Google Drive connection. A single-row table so every write can be a
-- compare-and-swap on `revision`; no row means disconnected, and a broken
-- connection keeps its row (credential cleared) so a reconnect can enforce the
-- same-account rule. The refresh token is stored only sealed (AES-256-GCM under
-- the DRIVE_TOKEN_KEY Worker secret). `connected_by` is plain text with no FK,
-- like every actor column.
-- Safe in either order with the deploy: every Drive route answers 404, and the
-- keepalive skips, until all five DRIVE_* secrets are set.
CREATE TABLE `drive_connection` (
	`id` integer PRIMARY KEY NOT NULL CHECK (`id` = 1),
	`status` text NOT NULL CHECK (`status` IN ('connected', 'broken')),
	`google_sub` text NOT NULL,
	`google_email` text NOT NULL,
	`refresh_token_sealed` text,
	`key_version` integer DEFAULT 1 NOT NULL,
	`granted_scope` text NOT NULL,
	`connected_by` text NOT NULL,
	`connected_at` integer NOT NULL,
	`last_used_at` integer,
	`last_refreshed_at` integer,
	`broken_at` integer,
	`broken_reason` text,
	`revision` integer DEFAULT 1 NOT NULL,
	CHECK ((`status` = 'connected') = (`refresh_token_sealed` IS NOT NULL)),
	CHECK ((`status` = 'broken') = (`broken_at` IS NOT NULL))
);
