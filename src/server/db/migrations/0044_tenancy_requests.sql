-- #294 slice 3 (ADR 0028, spec 2026-10-20 decisions 1 and 3): an owner's
-- request for a Tenancy, which the board approves or refuses.
--
-- A request is not a roster fact. The tenant's name and contact live here only
-- while the request is open: approval moves them into `people` and
-- `contact_methods`, where Roster Redaction and the AI pseudonymizer already
-- reach them, and refusal or withdrawal clears them. `tenancy_requests_contact_
-- shape` enforces it, so the table never holds a name or contact the roster
-- doesn't. A renewal names no tenant: the Tenancy it renews already does.
--
-- `contact_normalized` is the form `contact_methods.value_normalized` takes,
-- so the open-request index compares contacts the way the roster does.
--
-- The 13-month cap and every Lot Authority re-check live in the mutation SQL.
--
-- Apply BEFORE merging the code that uses it: the member route and the
-- Tenants panel read this table.
CREATE TABLE IF NOT EXISTS `tenancy_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`lot_id` text NOT NULL,
	`requested_by_account_id` text NOT NULL,
	`requested_by_person_id` text NOT NULL,
	`basis_ownership_id` text NOT NULL,
	`kind` text NOT NULL,
	`renews_tenancy_id` text,
	`tenant_name` text,
	`channel` text,
	`contact_value` text,
	`contact_normalized` text,
	`scheduled_end_day` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by_account_id` text,
	`refusal_reason` text,
	`tenancy_id` text,
	FOREIGN KEY (`lot_id`) REFERENCES `lots`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`requested_by_person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`basis_ownership_id`) REFERENCES `ownerships`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`renews_tenancy_id`) REFERENCES `tenancies`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`tenancy_id`) REFERENCES `tenancies`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tenancy_requests_kind_check" CHECK("kind" IN ('new', 'renewal')),
	CONSTRAINT "tenancy_requests_status_check" CHECK("status" IN ('open', 'approved', 'refused', 'withdrawn')),
	CONSTRAINT "tenancy_requests_channel_check" CHECK("channel" IS NULL OR "channel" IN ('email', 'sms')),
	CONSTRAINT "tenancy_requests_renewal_paired" CHECK(("kind" = 'renewal') = ("renews_tenancy_id" IS NOT NULL)),
	CONSTRAINT "tenancy_requests_contact_shape" CHECK(CASE WHEN "status" = 'open' AND "kind" = 'new' THEN "tenant_name" IS NOT NULL AND "channel" IS NOT NULL AND "contact_value" IS NOT NULL AND "contact_normalized" IS NOT NULL ELSE "tenant_name" IS NULL AND "channel" IS NULL AND "contact_value" IS NULL AND "contact_normalized" IS NULL END),
	CONSTRAINT "tenancy_requests_decision_paired" CHECK(("status" = 'open') = ("decided_at" IS NULL)),
	CONSTRAINT "tenancy_requests_decider_paired" CHECK(("decided_at" IS NULL) = ("decided_by_account_id" IS NULL)),
	CONSTRAINT "tenancy_requests_refusal_reason_paired" CHECK(("status" = 'refused') = ("refusal_reason" IS NOT NULL)),
	CONSTRAINT "tenancy_requests_tenancy_paired" CHECK(("status" = 'approved') = ("tenancy_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tenancy_requests_open_contact_idx` ON `tenancy_requests` (`lot_id`,`contact_normalized`) WHERE "status" = 'open' AND "kind" = 'new';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `tenancy_requests_open_renewal_idx` ON `tenancy_requests` (`renews_tenancy_id`) WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tenancy_requests_lot_status_idx` ON `tenancy_requests` (`lot_id`,`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `tenancy_requests_status_idx` ON `tenancy_requests` (`status`);
