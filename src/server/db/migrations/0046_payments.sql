-- ADR 0025 (#295 slice 5, #538, #539): the online-payment model.
--
-- Four tables, none of which names a provider in its schema. The provider is
-- an adapter id in a plain string column, so changing provider moves no
-- schema.
--
--   payments                        one attempt by a party to pay a Lot
--   payment_events                  every verified fact received, normalized
--   payment_exceptions              the board's queue for what the automatic
--                                   path refused to decide
--   payment_exception_resolutions   how each exception was closed, appended
--
-- The raw provider payload is NOT stored anywhere: it carries payer names,
-- emails and bank details the association does not need. Only the normalized
-- columns below are kept.
--
-- `payment_events`, `payment_exceptions` and `payment_exception_resolutions`
-- are append-only, by the same convention-plus-scan discipline as the ledger
-- (`test/unit/payments-boundaries.test.ts`). `payments` is updated, but only by
-- the application path, because its `status` and `ledger_state` are
-- projections; the Dues Ledger remains the authority for money.
--
-- Additive, and safe in either order with the deploy: in this slice nothing
-- reads or writes these tables outside the application path, which no route
-- calls yet.
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`lot_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`initiated_by_person_id` text,
	`origin` text NOT NULL,
	`provider` text NOT NULL,
	`provider_payment_ref` text,
	`status` text NOT NULL,
	`ledger_state` text DEFAULT 'none' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`lot_id`) REFERENCES `lots`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`initiated_by_person_id`) REFERENCES `people`(`party_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "payments_amount_positive" CHECK("amount_cents" > 0),
	CONSTRAINT "payments_origin_check" CHECK("origin" IN ('checkout', 'board_applied')),
	-- A checkout is started by a Person; a payment the board applied from an
	-- unmatched provider fact has none, and the board's account is on the
	-- exception's resolution row instead.
	CONSTRAINT "payments_initiator_by_origin" CHECK(("origin" = 'checkout') = ("initiated_by_person_id" IS NOT NULL)),
	CONSTRAINT "payments_provider_not_blank" CHECK(length(trim("provider")) > 0),
	-- Absent is NULL, never blank: a blank reference names nothing, so it must
	-- not be a value a provider fact could match.
	CONSTRAINT "payments_ref_not_blank" CHECK("provider_payment_ref" IS NULL OR length(trim("provider_payment_ref")) > 0),
	CONSTRAINT "payments_status_check" CHECK("status" IN ('created', 'pending', 'succeeded', 'failed', 'canceled', 'expired')),
	CONSTRAINT "payments_ledger_state_check" CHECK("ledger_state" IN ('none', 'credited', 'withdrawn'))
);--> statement-breakpoint
-- The provider's reference is unique per provider, not globally: two adapters
-- are free to mint the same string. NULL until the checkout is created.
CREATE UNIQUE INDEX `payments_provider_ref_unq` ON `payments` (`provider`,`provider_payment_ref`);--> statement-breakpoint
CREATE INDEX `payments_lot_idx` ON `payments` (`lot_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `payments_status_idx` ON `payments` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `payment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_event_id` text NOT NULL,
	`payment_id` text,
	`provider_payment_ref` text,
	`type` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`via` text NOT NULL,
	`outcome` text NOT NULL,
	`ledger_entry_id` text,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`ledger_entry_id`) REFERENCES `dues_ledger_entries`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "payment_events_type_check" CHECK("type" IN ('payment_pending', 'payment_succeeded', 'payment_failed', 'payment_canceled', 'funds_withdrawn', 'funds_reinstated', 'dispute_opened')),
	CONSTRAINT "payment_events_via_check" CHECK("via" IN ('webhook', 'reconciliation', 'board')),
	CONSTRAINT "payment_events_outcome_check" CHECK("outcome" IN ('applied', 'duplicate_effect', 'unmatched', 'exception')),
	-- A magnitude, never signed: the ledger entry carries the sign.
	CONSTRAINT "payment_events_amount_not_negative" CHECK("amount_cents" >= 0),
	CONSTRAINT "payment_events_currency_shape" CHECK("currency" GLOB '[a-z][a-z][a-z]'),
	CONSTRAINT "payment_events_ref_not_blank" CHECK("provider_payment_ref" IS NULL OR length(trim("provider_payment_ref")) > 0),
	-- An event is unmatched exactly when no payment row claims it.
	CONSTRAINT "payment_events_unmatched_by_payment" CHECK(("outcome" = 'unmatched') = ("payment_id" IS NULL)),
	-- An event that produced a ledger entry was applied (or applied and
	-- flagged); a duplicate or unmatched one produced nothing.
	CONSTRAINT "payment_events_entry_by_outcome" CHECK("ledger_entry_id" IS NULL OR "outcome" IN ('applied', 'exception'))
);--> statement-breakpoint
-- Idempotency, the first of ADR 0025's two layers: a redelivered event is
-- stored once.
CREATE UNIQUE INDEX `payment_events_provider_event_unq` ON `payment_events` (`provider`,`provider_event_id`);--> statement-breakpoint
CREATE INDEX `payment_events_payment_idx` ON `payment_events` (`payment_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `payment_exceptions` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_event_id` text,
	`payment_id` text,
	`reason` text NOT NULL,
	`opened_at` integer NOT NULL,
	FOREIGN KEY (`payment_event_id`) REFERENCES `payment_events`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "payment_exceptions_reason_check" CHECK("reason" IN ('amount_mismatch', 'currency_mismatch', 'unmatched_payment', 'funds_withdrawn', 'dispute_opened', 'partial_withdrawal', 'withdrawal_without_credit', 'possible_duplicate', 'stale_pending')),
	CONSTRAINT "payment_exceptions_has_subject" CHECK("payment_event_id" IS NOT NULL OR "payment_id" IS NOT NULL)
);--> statement-breakpoint
-- `stale_pending` is opened by the daily job, not by an event, so nothing else
-- would stop it opening every day; once per payment is the rule.
CREATE UNIQUE INDEX `payment_exceptions_stale_pending_unq` ON `payment_exceptions` (`payment_id`) WHERE "reason" = 'stale_pending';--> statement-breakpoint
CREATE INDEX `payment_exceptions_payment_idx` ON `payment_exceptions` (`payment_id`);--> statement-breakpoint
CREATE TABLE `payment_exception_resolutions` (
	`id` text PRIMARY KEY NOT NULL,
	`exception_id` text NOT NULL,
	`resolution` text NOT NULL,
	`note` text,
	`acting_account_id` text,
	`resolved_at` integer NOT NULL,
	FOREIGN KEY (`exception_id`) REFERENCES `payment_exceptions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "payment_exception_resolutions_resolution_check" CHECK("resolution" IN ('reviewed_no_action', 'corrected_by_entry', 'applied_to_lot', 'funds_reinstated', 'other')),
	-- The system resolves exactly one kind of exception itself — a withdrawal
	-- answered by reinstated funds — and every other resolution names the
	-- board account that decided it.
	CONSTRAINT "payment_exception_resolutions_actor_shape" CHECK(("acting_account_id" IS NULL) = ("resolution" = 'funds_reinstated'))
);--> statement-breakpoint
-- An exception resolves once. An open exception is one with no row here.
CREATE UNIQUE INDEX `payment_exception_resolutions_exception_unq` ON `payment_exception_resolutions` (`exception_id`);--> statement-breakpoint
-- The correction to ADR 0025 recorded in its 2026-11-06 amendment (#538).
-- `0036`'s partial unique index allowed one provider-sourced entry per
-- payment, which makes the `funds_reinstated` entry the same ADR requires —
-- a second `payment` entry for the same payment — impossible to write, and a
-- provider reversal carrying its payment id would collide the same way.
-- Effect uniqueness moves to a deterministic `operation_key` per effect,
-- enforced by the existing `(operation_key, lot_id)` unique index, and every
-- provider entry keeps its `payment_id` so the trail runs from entry to
-- payment. This drops and creates an index; the table is not rebuilt.
DROP INDEX `dues_ledger_entries_payment_unq`;--> statement-breakpoint
CREATE INDEX `dues_ledger_entries_payment_idx` ON `dues_ledger_entries` (`payment_id`);
