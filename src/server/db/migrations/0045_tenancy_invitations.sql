-- #294 slice 4 (ADR 0028, spec 2026-10-20 decision 4): the claim credential an
-- approved tenant follows to link their Account to the tenant Person.
--
-- The token is a 256-bit random value sent in a link; only its HMAC under
-- BETTER_AUTH_SECRET is stored, so a leaked backup holds nothing that claims.
-- An invitation is good for 14 days and ends one of two ways: consumed by the
-- Account that claims it, or superseded by a newer invitation for the same
-- Tenancy. `tenancy_invitations_single_end` keeps those apart.
--
-- The contact is a Person's, by the same composite reference
-- `person_verifications` uses, because the claim records it there.
--
-- The daily cleanup job deletes invitations that expired more than 30 days
-- ago; nothing references this table.
--
-- Apply BEFORE merging the code that uses it: approval writes this table.
CREATE TABLE IF NOT EXISTS `tenancy_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenancy_id` text NOT NULL,
	`contact_method_id` text NOT NULL,
	`contact_method_party_kind` text DEFAULT 'person' NOT NULL,
	`channel` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`consumed_by_account_id` text,
	`superseded_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenancy_id`) REFERENCES `tenancies`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`contact_method_id`,`contact_method_party_kind`) REFERENCES `contact_methods`(`id`,`party_kind`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tenancy_invitations_party_kind_check" CHECK("contact_method_party_kind" = 'person'),
	CONSTRAINT "tenancy_invitations_channel_check" CHECK("channel" IN ('email', 'sms')),
	CONSTRAINT "tenancy_invitations_expiry_ordered" CHECK("expires_at" > "created_at"),
	CONSTRAINT "tenancy_invitations_consumer_paired" CHECK(("consumed_at" IS NULL) = ("consumed_by_account_id" IS NULL)),
	CONSTRAINT "tenancy_invitations_single_end" CHECK("consumed_at" IS NULL OR "superseded_at" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tenancy_invitations_token_hash_unq` ON `tenancy_invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tenancy_invitations_tenancy_idx` ON `tenancy_invitations` (`tenancy_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tenancy_invitations_expires_idx` ON `tenancy_invitations` (`expires_at`);
