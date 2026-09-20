# Data model

D1 tables, their columns, and the constraints that carry meaning. Read the entry for a table
before changing its shape or writing to it — several columns encode invariants that the
application relies on and that a plain `ALTER` would silently break.

Schema lives in `src/server/db/schema.ts`, with the ADR 0022 roster, audit, and cutover tables in
`roster-schema.ts`, `audit-schema.ts`, and `cutover-schema.ts`, all merged by `getDb` in
`client.ts` and registered in `drizzle.config.ts`. For applying and authoring migrations see
[`migrations.md`](./migrations.md); for the roster tables' operational model see
[`roster-and-access.md`](./roster-and-access.md).

**Two naming rules hold until ADR 0022 phase 4** and are worth knowing before touching any of
this: there is no `lots` table — the Lot remains `properties`, and every `lot_id` column
references `properties.id` — and board service lives in `board_service_terms`, not `board_terms`,
because the legacy `board_terms` table still exists with a different shape and every phase-1
`CREATE TABLE` is `IF NOT EXISTS`, so creating under the real name would silently no-op.

## Core tables

Auth throttling uses `rate_limits`: a unique request key, request count, and
`last_request` epoch milliseconds, with an opaque text primary key. Better Auth
performs guarded atomic increments through the Drizzle adapter. Expired counters
are pruned opportunistically when an existing bucket starts a new window.
These are operational counters, not account or roster records.

D1 tables are defined in `src/server/db/schema.ts`. They include `announcements`,
`documents` (metadata including nullable indexed `content_hash`, plus nullable `keep_verified_at`
and `keep_verified_by`, set when a board member explicitly keeps a document during duplicate
review; the document library uses 16 `DOCUMENT_CATEGORIES`, see `src/lib/types.ts`), `settings`
(key/value singletons `dues` and `site`; the site JSON includes `officialMode` and the
fail-closed/default-false `liveVotingEnabled` flag — per #363/ADR 0024 both are transition-only:
`PUT /api/admin/site` preserves whatever is already stored for every key in `SITE_GATE_KEYS`
regardless of the request body, and a gate changes only through the audited compare-and-swap
described in [`http-endpoints.md`](./http-endpoints.md)), `setting_changes` (the append-only audit
ledger for that compare-and-swap: `id`, `key`, `old_value`/`new_value` as literal `'true'`/`'false'`
text, `acting_account_id` with no FK, indexed `recorded_at`; no route may `UPDATE` or `DELETE` a
row here, only `INSERT` — a static scan in `test/unit/setting-changes-append-only.test.ts` holds
that. Deliberately separate from `audit_events`: that table's `family` CHECK is the party roster's
ledger, and a site setting has no Party, Lot, or roster fact to attach to), `reports` (saved AI-generated
governing-documents
reports: `topic`, nullable `template_key` — null means freeform — `content_md` (final
de-anonymized markdown), `sources_json` (a `{id, title, category}` snapshot), indexed
`created_at`, and `created_by` as a plain-text board-user-id audit column with no FK; only a
completed generation is saved, so a failed or client-disconnected generation leaves no row;
after 90 days or any authorized roster name/contact redaction, `topic`, `content_md`, and
`sources_json` are replaced with a fixed non-PII removal state while the other metadata remains),
`board_people` and `board_terms` (the board roster's identity layer, per
[ADR 0012](../adr/0012-board-record-as-structured-rows.md): `board_people` records a person,
with a nullable `user_id` link to a Better Auth `user` row kept for display only and never for
authorization; `board_terms` records a term of service — `person_id`, nullable `title`,
`term_start`, nullable `term_end` — so a member who serves, leaves, and returns keeps one identity
across terms; deleting a person with a term on record is refused with `409`), `meetings`,
`board_attendance`, `motions`, `board_votes`, `member_attendance`, and `member_votes` (the meeting
record — board and member meetings; proxies may be board-recorded or granted online by homeowners,
with the default-off live-voting lifecycle foundation described in ADR 0020 — per
[ADR 0014](../adr/0014-meeting-record-status-gate.md) and
[ADR 0015](../adr/0015-weighted-member-voting.md), and
[ADR 0020](../adr/0020-digital-ballot-box.md): `meetings` has `body` (`board`/`member`, the
column that decides which voter model applies), `kind` (`regular`/`special`/`annual`), `date`,
`start_time`, `location`, `title`, `summary_md`, `document_id` referencing `documents` on
delete-set-null, `quorum_required`, `status` (`draft`/`approved`, default `draft`), `visibility`
(default `board`), approval provenance `approved_at`/`approved_by`/`approved_by_motion_id` (the
last references `motions` on delete-set-null), and `created_by`; `board_attendance` is one
present/absent row per meeting per `people(party_id)` row (repointed from `board_people` by #248,
ADR 0022 phase 4's precondition — see the legacy-FK-columns paragraph under Phase 4 below),
unique per pair; `motions` records one motion per meeting with a server-assigned `sequence` unique
per meeting and board mover/second referencing `people(party_id)` on delete-restrict. Until #248
this was two parallel pairs — `mover_person_id`/`second_person_id` referencing `board_people` for
board motions, plus `mover_owner_id`/`second_owner_id` referencing `owners` for member motions,
told apart only by the parent meeting's `body` — but the owner pair was never written (phase 3b)
and measured 0 rows in production, so #248 dropped it and repointed the person pair at the party
roster's single Person concept; the mover/second pickers stay hidden on member meetings, and a
board-entered
`outcome` (`passed`/`failed`/`withdrawn`/`tabled`). Member motions also carry `voting_state`
(`none`/`open`/`closed`) and a monotonic `voting_revision`: every open, close, and successful
member vote-set replacement advances the revision, so a stale correction cannot overwrite an
intervening live session even when the lifecycle state returns to `closed`; `motion_eligibility`
is unique per `(motion_id, property_id)`, cascades with its motion, restricts property deletion,
and freezes each active property's non-negative weight at first open for unchanged reuse on reopen.
`board_votes` is one roll-call vote per motion per `people(party_id)` row (repointed from
`board_people` by #248; `choice`:
`yes`/`no`/`abstain`/`recused`/`absent`), unique per pair;
`member_attendance` is one present/absent row per meeting per `properties` row, unique per pair,
with nullable `represented_by_person_id` (referencing `people(party_id)` on delete-set-null,
repointed from `owners` by #248 part 2) and a nullable `proxy_id` referencing `proxies` (see below;
carries no `ON DELETE` action, deliberately); `member_votes` is one vote per
motion per `properties` row — that uniqueness is what enforces one vote per lot — with nullable
`cast_by_person_id` (the same Person FK) and the same nullable, actionless `proxy_id`, a `weight` column snapshotting
`properties.vote_weight` as stamped from the current property before first open or from the
immutable `motion_eligibility` record-date row afterward (so correcting a property's weight later
cannot rewrite a past live-voting tally), and `choice` restricted to `yes`/`no`/`abstain`
(`recused`/`absent` are board
roll-call concepts and are excluded). `member_attendance.proxy_id` and `member_votes.proxy_id`
replaced a `via_proxy` boolean each carried until migration `0015`; `viaProxy` on both is now
derived at read time (`proxy_id IS NOT NULL`), never a stored fact a caller could set
independently — see the `proxies` paragraph below and
[ADR 0018](../adr/0018-proxies-record-via-proxy-consolidation.md). A motion's displayed tally
is always derived from
`board_votes` or `member_votes` by the single `tallyVotes` in `src/lib/types.ts`, which sums each
vote's `weight` (defaulting to 1, so board votes — which carry none — tally exactly as before, with
no separate weighted/unweighted mode); `motions.outcome` itself is board-entered and never
computed, because passage thresholds vary and quorum is not modelled), roster/verification tables
(`properties` — including `vote_weight`, an integer `NOT NULL DEFAULT 1` that weights a lot's
member-meeting vote and is rejected at zero, see ADR 0015, and nullable `retired_day`/`retired_at`
added by ADR 0022 migration `0022`, read only by the ADR 0022 phase-2 shadow derivation
(`src/server/authz/derive.ts`), never by legacy authorization — `owners`,
`user_property_links`, `property_verifications`, `manual_approval_queue`), and Better Auth tables
(`user`, `session`, `account`, `verification`).

## The party roster, audit ledger, and cutover tables

[ADR 0022](../adr/0022-party-roster-derived-access.md) adds a durable party roster, an immutable
audit ledger, and cutover-operational tables across `roster-schema.ts`, `audit-schema.ts`, and
`cutover-schema.ts`. Migrations `0019`-`0022` create all 29 tables plus the two `properties`
columns above; migration `0023` adds eight server-side views over them. What those tables mean,
who writes them, and the invariants they must satisfy are in
[`roster-and-access.md`](./roster-and-access.md).

## Resolutions

`resolutions` (the resolutions book — standing rules the board adopts, per
[ADR 0016](../adr/0016-resolutions-supersession-chain.md)) is a durable record: amending one
creates a new resolution rather than editing the old one in place. It has a unique `number`,
`title`, `body_md`, `status` (`draft`/`in_force`/`superseded`/`repealed`, default `draft`),
`visibility` (default `board`), nullable `effective_date`, `adopted_by_motion_id` referencing
`motions` on delete-set-null, a self-referencing `supersedes_id` on delete-restrict with a unique
index so two resolutions cannot both supersede one predecessor (RESTRICT rather than SET NULL: a
superseded resolution must not become deletable out from under the chain it participates in), and
`created_at`/`updated_at`/`created_by`. Status is transition-only: only the `adopt`, `supersede`,
and `repeal` actions on `/api/admin/resolutions` move a resolution between statuses, each with its
own preconditions, and `PATCH` cannot write `status`, `supersedes_id`, or `adopted_by_motion_id`.
Because deleting a motion or its meeting could otherwise silently null a resolution's adoption
provenance via the `set null` cascade, `DELETE /api/admin/motions` and `DELETE /api/admin/meetings`
both return `409` if a resolution cites one of the motions being removed as its adopting motion.

## Elections, candidates, ballots, and ballot choices

`elections`, `election_eligibility`, `candidates`, `ballots`, and `ballot_choices` (the recorded
paper-election workflow plus the default-off conducted-election foundation — per
[ADR 0017](../adr/0017-elections-secret-by-construction.md) and
[ADR 0020](../adr/0020-digital-ballot-box.md)): `elections` has a nullable `meeting_id`
referencing `meetings` on delete-set-null (an election may stand alone), `title`, `seats`,
`election_date`, create-immutable `source` (`recorded`/`conducted`, default `recorded`), `status`
(`draft`/`open`/`closed`/`certified`/`void`, default `draft`), `visibility` (default `board`),
certification provenance `certified_at`/`certified_by`, and `created_by`.
`election_eligibility` is unique per `(election_id, property_id)`, cascades with its election,
restricts property deletion, and stores the non-negative property weight frozen when a conducted
election first opens. `candidates` references `elections` on delete-cascade, with a nullable
`person_id` referencing `people(party_id)` on delete-restrict (repointed from
`board_person_id`/`board_people` by #248 — ADR 0022 phase 4's precondition; identity continuity
across terms for a returning board member is now carried by the Party itself, not backfilled by
`certify`, per ADR 0012), a
server-assigned `sequence` unique per election, a nullable `votes` (`NULL` = not yet recorded,
`0` = recorded as zero — and always `NULL` while a conducted election is open), `won`, and
`withdrawn`; it deliberately carries no `updated_at`. `ballots` references `elections` on
delete-cascade and `properties` on delete-restrict, is unique per `(election_id, property_id)`
(`ballots_election_property_unq`), and records only turnout: a `weight` snapshot, nullable
actionless `proxy_id`, nullable `cast_by_person_id` referencing `people(party_id)` on
delete-set-null (repointed from `owners` by #248 part 2), and `recorded_at`. `id` and `recorded_at`
are facts about the ballot, not about whichever `setBallots` call most recently touched the
election's register: since #302 slice 1, `setBallots` is set-convergent
(`INSERT ... ON CONFLICT (election_id, property_id) DO UPDATE`) rather than delete-and-reinsert, so
a lot that stays on the register through an amendment keeps its original `id` and `recorded_at` —
only `weight`/`proxy_id`/`cast_by_person_id` are overwritten — and only a newly-entered lot's
`recorded_at` is the amendment instant. See [`http-endpoints.md`](./http-endpoints.md) for the
statement shape and why: `review_flags.impacted_ballot_id`'s `ON DELETE SET NULL` and
`roster/transfer-effects.ts`'s `recorded_at`-keyed discovery window both depend on it.
`ballot_choices` is the identity-unlinked retained digital ballot box: `id`, `election_id` on
delete-cascade, `candidate_id` on delete-`no action` (changed from `restrict` by #248's `candidates`
rebuild — RESTRICT is checked immediately and NO ACTION at end-of-statement, and only the latter
makes a deleted election's cascade into both `candidates` and `ballot_choices` order-independent;
a bare candidate delete is refused identically either way), and non-negative `weight`, indexed only
by election. It deliberately has no ballot/property/owner/proxy/caster/timestamp/shared-receipt field
or other explicit identity/correlation column; none may be added, and supported reads never join a
choice to a turnout row. This is not mathematical anonymity: because turnout and choice rows retain
the same snapshotted weight, a rare or unique weight may identify or narrow a property's
selections, while SQLite insertion order and D1 Time Travel add temporal inference risk. A
conducted `POST /api/vote` cast writes the per-lot turnout row and every independent choice row in
one checked D1 batch, taking both weights from `election_eligibility`. The supported caller read
returns only `hasCast`, so a conducted ballot is final; conducted close derives final candidate
totals from the retained rows. The boundary is pinned by a three-legged enforcement suite that #206 says outlives the
migration — see [`voting-and-ballots.md`](./voting-and-ballots.md).
The legacy `board_terms` table still carries a nullable `election_id` referencing `elections` on
delete-set-null, but as of phase 3b nothing writes it: certification's provenance now lands on
`board_service_terms.election_id`, and the legacy board-roster routes are retired (#218).

## Proxies

`proxies` (the proxies record — either entered from paper by the board or granted online by a
homeowner for a lot they control, per
[ADR 0018](../adr/0018-proxies-record-via-proxy-consolidation.md) and
[ADR 0019](../adr/0019-homeowner-writes-official-mode-gate.md)): one Person
(`grantor_person_id`, referencing `people(party_id)` on delete-restrict — repointed from `owners`
by #248 part 2) authorising one named holder
(`holder_name`, required — a holder need not hold authority anywhere) to act for one lot
(`property_id`,
referencing `properties` on delete-restrict) at exactly one occasion, a nullable `meeting_id` or
`election_id` (each referencing its table on delete-cascade), never both, never neither — enforced
by a schema `CHECK` (`proxies_one_occasion`) rather than left to application code alone, so it holds
even against a direct write that bypasses the route. A unique index per occasion kind
(`proxies_property_meeting_unq`, `proxies_property_election_unq`) enforces one proxy per lot per
occasion, the same NULLs-are-distinct trick `resolutions_supersedes_unq` already relies on. An
optional `holder_person_id` (referencing `people(party_id)` on delete-set-null) is recorded when
the holder is on the roster, plus `created_by`/`created_at`/`updated_at`. `member_attendance.proxy_id`,
`member_votes.proxy_id`, and `ballots.proxy_id` each reference `proxies.id` but carry no `ON DELETE`
action at all. That began as the drizzle-kit trap — they were added by `ALTER TABLE` against tables
that predate this feature, and drizzle-kit silently drops any `ON DELETE` action on an ALTER-added
FK column, the same trap on record for `properties.vote_weight` and `board_terms.election_id`;
`proxy-schema.test.ts` pins that the generated `0014` SQL carries none. Since migration `0029`
rebuilt all three tables it is a DECISION: NO ACTION is re-declared on purpose, because deletion is
the whole revocation model (the route pre-checks instead) and because NO ACTION's
end-of-statement timing keeps a meeting or election delete — which cascades into `proxies` and the
citing table alike — independent of which cascade SQLite runs first, the same RESTRICT coin-flip
`0028` fixed on `ballot_choices`. Because that FK can't enforce a refusal itself, `DELETE
/api/admin/proxies` pre-checks all three citing tables and returns `409` naming which of
`attendance`/`votes`/`ballots` still reference the proxy; an uncited proxy is simply deleted —
deletion is the entire revocation model, there is no `revoked_at`. `viaProxy` on
`MemberAttendanceRow`/`MemberVoteRow`/`BallotRow` is derived (`proxy_id IS NOT NULL`) rather than a
second, independently-settable fact; the real `proxyId` is attached to `MemberAttendanceRow`/
`MemberVoteRow` only for the admin caller (`BallotRow.proxyId`, already board-only, carries it
always) — see the `assembleMeetingDetail`/`includeProxyIds` note in [`module-map.md`](./module-map.md).

## Lot records

`lot_violations` and `lot_record_events` (migration `0034`, ADR 0024, #291 slice 1) are the first of
a family whose audience is not a content tier
but a Lot: whoever holds Lot Authority over that one Lot, plus Board Access. Storage is typed per
record type — there is no generic `lot_records` table with a JSON payload, matching the ADR 0022
ledger's refusal of arbitrary JSON — and neither table carries a `visibility` column, deliberately,
so a future tier edit can never publish one Lot's record to every member. Both tables are gated by
`lotRecordsEnabled`, a new member of `SITE_GATE_KEYS` alongside `officialMode` and
`liveVotingEnabled`: a Lot Record surface requires both `officialMode` and `lotRecordsEnabled`
literally `true`, since presenting the site officially and publishing Lot-level financial and
enforcement detail are separate decisions (`src/server/lot-records/gate.ts`).

Board data entry landed in #291 slice 2 (v1.2.7):
`POST /api/admin/lot-violations` creates and transitions `lot_violations` rows and appends their
`lot_record_events`, and `GET /api/admin/lot-violations` is the board's unscoped read — see
[`http-endpoints.md`](./http-endpoints.md). Slice 3 (v1.2.8) added the board's own screen, the
admin `LotViolationsManager` panel, over that same route — see [`module-map.md`](./module-map.md).
Slice 4 (v1.2.9, ADR 0024) completed the feature with the homeowner-facing surface: the
server-rendered `/lot-records` page reads `fetchMemberLotViolations` (scoped by `personId` and
`lotAuthorityCoversRecordDay`, never by a caller-supplied lot list) and the address-only
`fetchMemberLotAddresses`. Both flags still default off, so the family stays unreachable in
production until an operator turns `lotRecordsEnabled` on.

`dues_ledger_entries` (migration `0036`, ADR 0025, #295 slice 1) is the second Lot Record type: the
per-Lot dues ledger, read-only in this slice — no write route, no payment rail, no surface, and it
still rides the default-off `lotRecordsEnabled` gate above. It is append-only and balance-forward:
the balance is `SUM(amount_cents)` over a Lot's rows, never a stored column, so a positive balance
is owed and a negative one is a credit, and there is nothing to drift. Columns: `lot_id` referencing
`properties(id)` on delete-restrict; `kind` (CHECK-bounded to `DUES_LEDGER_KINDS` —
`charge`/`payment`/`adjustment`/`reversal`); `amount_cents`, integer cents, signed, with its sign
fixed per `kind` by CHECK (`charge` positive, `payment` negative, `adjustment`/`reversal`
nonzero) so the sum is meaningful without interpreting `kind`; `effective_day` (`YYYY-MM-DD`,
GLOB-shaped); `description` (CHECK non-blank, homeowner-visible); `category` (CHECK-bounded to
`DUES_CHARGE_CATEGORIES`, present on a `charge` and NULL otherwise, enforced by an equality CHECK
rather than left to a writer); `method` (CHECK-bounded to `DUES_PAYMENT_METHODS`, present on a
`payment` and NULL otherwise, same equality-CHECK shape); `reference` (board-only, e.g. a check
number, projected out of the homeowner read the way `lot_violations.internal_note` is); `source`
(CHECK-bounded to `DUES_ENTRY_SOURCES` — `board`/`provider`); `payment_id` (no FK — the `payments`
table arrives with the payment rail in a later slice — CHECK-restricted to `source = 'provider'`);
`reverses_entry_id` (self-referencing on delete-restrict, UNIQUE so an entry is reversed at most
once, present exactly when `kind = 'reversal'`); `recorded_by` (the acting account, NULL exactly
when `source = 'provider'`); `recorded_at`; `operation_key`. Two rules cannot be same-row CHECKs and
are enforced by the `INSERT … SELECT` that writes a reversal instead (ADR 0025): a reversal's amount
is exactly the negation of the entry it reverses, and a reversal may not itself be reversed.

Two idempotency indexes, each shaped for a different double-submit: **`(operation_key, lot_id)`
UNIQUE**, not `operation_key` alone, because ADR 0025's bulk action posts one assessment to every
Lot under ONE key — a bare unique on the key would make that impossible, since the second lot's row
would collide with the first — while the composite still makes a resubmission a no-op per Lot; and a
**partial UNIQUE on `payment_id WHERE source = 'provider'`**, the per-effect layer so a webhook and
a reconciliation pull can never both credit one settlement (the predicate exists because `payment_id`
is NULL on every board-entered row, which a bare unique would otherwise collide on). An index on
`(lot_id, effective_day)` serves the admin per-lot read and its ordering.

`lot_record_events` now serves two subject tables, and gained a **pair rule** with the widened
CHECK: `record_type IN ('lot_violations', 'dues_ledger_entries')` plus
`lot_record_events_action_for_subject`, which requires `action = 'created'` whenever
`record_type = 'dues_ledger_entries'`. A ledger entry has no lifecycle — it is appended and, if
wrong, corrected by a further entry — so the widened `action` vocabulary (`cured`/`closed`/
`reopened`/`voided`/`edited`) stays reachable only by a violation. Migration `0036` widened the
CHECK by the same `__new`-copy-and-rename rebuild `0035` used, with no FK PRAGMA (see
[`migrations.md`](./migrations.md)).

`src/server/lot-records/reads.ts`'s `fetchMemberDuesLedger` and `fetchAdminLotDuesLedger` are the
reads (see [`module-map.md`](./module-map.md)); `fetchMemberDuesLedger` is where ADR 0024's rule for
a running figure is implemented — entries from before the reader's own period of authority are
collapsed into `openingBalanceCents` rather than dropped, so a caller with an earlier owner's
history behind them still sees a whole balance rather than a partial one.

`lot_violations` has `lot_id` referencing `properties(id)` on delete-restrict (the same
outlive-an-editing-mistake action `ballots`/`proxies`/`member_votes` use), `category` (CHECK-bounded
to the eight `LOT_VIOLATION_CATEGORIES` in `src/lib/types.ts`), `effective_day` (a `YYYY-MM-DD`
Association Day, CHECK-shaped and indexed together with `lot_id` since every read is "this Lot,
newest first"), `summary` (CHECK non-blank), a board-only `internal_note`, `status`
(`open`/`cured`/`closed`/`voided`, default `open`), and plain-text `created_by`/`created_at` with no
FK — the same audit-trail-only pattern `reports.created_by` and `setting_changes.acting_account_id`
use. No Person name or Contact Method value is copied into the table, so Roster Redaction never has
to reach it. A `voided` row stays visible to the board and disappears from the homeowner surface by
construction (excluded in the read's own scoping predicate), never by a caller-side filter.

`lot_record_events` is the append-only log every Lot Record type shares, subject to
`(record_type, record_id)` with **no foreign key** — SQLite cannot express an FK whose target
depends on another column's value — `record_type` CHECK-bounded to `LOT_RECORD_TYPES`
(`lot_violations` and, since migration `0036`, ADR 0025's `dues_ledger_entries`, #295 — see below),
`action` CHECK-bounded to `LOT_RECORD_ACTIONS`, and — since migration `0035` (#291 slice 2) rebuilt
the table — `reason_code` CHECK-bounded to `LOT_RECORD_REASON_CODES` rather than free text, so a
board-typed reason can never accumulate resident-identifying prose in a column Roster Redaction
does not cover; prose that belongs on the record itself goes in the record's own `internal_note`.
Append-only is by convention, the same discipline
the ADR 0022 ledger and `setting_changes` use, since D1 has one binding and this codebase forbids
triggers. Per-record board reads are not logged; only a bulk export, if one is ever added, would be.

`src/server/roster/authority.ts`'s `lotAuthorityCoversRecordDay` is the read-time sibling of
`lotAuthorityExists`, sharing one SQL builder with it: it additionally bounds a Lot Record read to
the caller's own period of authority (a buyer holds Lot Authority today, but sees nothing the
seller's period produced), and it is what `src/server/lot-records/reads.ts`'s homeowner reads embed
in their `WHERE` clause. See [`roster-and-access.md`](./roster-and-access.md).

## Document storage (R2)

Every document has two R2 representations keyed by its D1 uuid, per
[ADR 0009](../adr/0009-rag-index-separate-from-download-library.md): the human-readable original
at `documents/<uuid>/<filename>`, served by `GET /api/files/<id>` with tier checks, and a derived
Markdown twin at `rag/<uuid>.md` that AI Search indexes (see **Cloudflare bindings** and the
board-only document assistant above). `docIdFromFolder` (`src/server/ai/sources.ts`) resolves a
document's uuid from either key shape so citations always point back to the real, tier-checked
download. The document library (444 human documents, 429 Markdown twins) is (re)built by the
operator-run `scripts/import-corpus.ts` as a clean replace; see SETUP.md §7.
