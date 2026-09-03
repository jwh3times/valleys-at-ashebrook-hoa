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

D1 tables are defined in `src/server/db/schema.ts`. They include `announcements`,
`documents` (metadata including nullable indexed `content_hash`, plus nullable `keep_verified_at`
and `keep_verified_by`, set when a board member explicitly keeps a document during duplicate
review; the document library uses 16 `DOCUMENT_CATEGORIES`, see `src/lib/types.ts`), `settings`
(key/value singletons `dues` and `site`; the site JSON includes `officialMode` and the
fail-closed/default-false `liveVotingEnabled` flag), `reports` (saved AI-generated
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
delete-cascade and `properties` on delete-restrict, is unique per `(election_id, property_id)`, and
records only turnout: a `weight` snapshot, nullable actionless `proxy_id`, nullable
`cast_by_person_id` referencing `people(party_id)` on delete-set-null (repointed from `owners` by
#248 part 2), and `recorded_at`.
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

## Document storage (R2)

Every document has two R2 representations keyed by its D1 uuid, per
[ADR 0009](../adr/0009-rag-index-separate-from-download-library.md): the human-readable original
at `documents/<uuid>/<filename>`, served by `GET /api/files/<id>` with tier checks, and a derived
Markdown twin at `rag/<uuid>.md` that AI Search indexes (see **Cloudflare bindings** and the
board-only document assistant above). `docIdFromFolder` (`src/server/ai/sources.ts`) resolves a
document's uuid from either key shape so citations always point back to the real, tier-checked
download. The document library (444 human documents, 429 Markdown twins) is (re)built by the
operator-run `scripts/import-corpus.ts` as a clean replace; see SETUP.md §7.
