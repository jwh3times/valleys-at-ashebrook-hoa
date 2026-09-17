# ADR 0024: Lot Records Are a Per-Lot Private Audience, Not a Fourth Content Tier

**Status:** Proposed
**Date:** 2026-09-17

## Context

Every record the site holds today has an audience chosen from one ordered ladder. A content row
carries a `visibility` of `public`, `homeowner`, or `board` (ADR 0002), and the read helpers in
`src/server/content/reads.ts` filter it against the caller's `contentTier` through `tierAllows` /
`visibleTiers`. The ladder answers "how sensitive is this row"; it cannot answer "whose row is
this". A homeowner-tier row is visible to every Association Member at once.

The board approved #291 at its 2026-08-11 meeting: records that belong to one Lot rather than to
the association — dues balances and violations first — taking effect once the site is officially
adopted (#361). Adoption is not a build blocker: the feature is built now behind its own gate and
stays dark until enabled. #295 (online dues payments, ADR 0025) builds its ledger on top of this
audience.

Three facts about the current code shape the decision:

- **Authority is per Lot, not per person.** #291 describes an audience of "exactly one person".
  Under ADR 0022 that is not the model production runs. Lot Authority is held equally by every
  individual Current Owner and every current Representative of an organizational Current Owner,
  with no primary person (`CONTEXT.md`). A Lot owned by two spouses and a Lot owned by an LLC with
  two Representatives each have two parties with identical standing. Anything addressed to "the
  owner" is addressed to the Lot.
- **The caller's Lots are derived per request.** `LOT_SQL` in `src/server/authz/derive.ts` computes
  `AuthContext.lotIds` from the linked Person's Current Ownerships and in-scope Representations on
  the request's Association Day, excluding retired Lots. `src/server/roster/authority.ts` is the
  single definition of Lot Authority, carried both as Drizzle readers and as the raw-SQL
  `lotAuthorityExists` fragment for mutation-boundary predicates. Under `cutover_mode = legacy`,
  `personId` is `null` and `lotIds` comes from `user_property_links` — which login was verified for
  a property, not who holds authority.
- **A primitive was reserved for this and is not sufficient.** `requirePropertyAccess` in
  `src/server/authz/guards.ts` says it is reserved for "per-owner private data (dues balances /
  violations, ROADMAP item 2)" and has no caller. It is an in-memory preflight over `ctx.lotIds`.
  It is a fine early refusal, but it is not a query-level boundary, and it can only express
  current authority.

## Decision

### The audience is a Lot, expressed as row scope, not as a tier

A **Lot Record** is a record whose audience is the parties holding Lot Authority over one Lot, plus
Board Access. It is not a fourth value of `Visibility`, and Lot Record tables carry no
`visibility` column. `tierAllows`, `visibleTiers`, and `contentTier` are unchanged. A tier asks how
sensitive a shared row is; a Lot Record's audience is decided by the row's `lot_id` joined against
the roster. Putting the two on one axis would let a future `visibility = 'homeowner'` edit on one
row publish a Lot's balance to every member.

Every Lot Record row is keyed by `lot_id`, which references `properties.id` (the Lot, until phase 4
renames it). Rows never key to `user`, an Account, `user_property_links`, or a Person as their
audience. Where a record names a Person — for example, who recorded a payment — it references
`people(party_id)` as provenance, never as the audience. Rows store no copies of Person names or
Contact Method values, so Roster Redaction never has to reach these tables.

The domain term goes into `CONTEXT.md` when the first slice lands: **Lot Record** — _avoid_:
owner record, homeowner data, private tier.

### Who qualifies: current Lot Authority, with detail limited to the caller's own period

A caller may read a Lot's records only when all of these hold on the request's Association Day:

1. The caller's Account has a current Person Link (`ctx.personId` is non-null). Under
   `cutover_mode = legacy` nobody qualifies, the same deliberate refusal
   `/api/member/roster-self` gives, because legacy has no Person to scope by.
2. That Person holds Lot Authority over the Lot today — a Current Ownership, or a current
   Representation of an organizational Current Owner whose scope covers the Lot. That is exactly
   the `roster/authority.ts` rule. There is no separate "record contact" or "primary owner" field.
3. For record detail, the record's `effective_day` is on or after the start of the caller's
   current authority over that Lot. For a direct owner, that start is their Current Ownership's
   `start_day`. For a Representative, it is the later of the Representation's and the
   Organization's Ownership `start_day`. A `NULL` `start_day` is legacy history ADR 0022 explicitly
   permits, and it means the start is unknown rather than recent. Detail is then visible from the
   beginning. The roster's `create` action requires a start day, so every transfer recorded
   through the site carries one.

Earlier records are not silently dropped. Where a record type has a running figure (the dues
balance in ADR 0025), the figure stays whole, and entries before the caller's period collapse into
one line such as "balance before <day>". A partial balance would be wrong in exactly the way #295
warns about. Record types with no running figure (violations) simply omit earlier rows.

**A prior owner loses all access once their authority ends.** That includes records from their
own period. This is the fail-closed default: a former owner has no Member Access, no Lot
Authority, and often no current Person Link basis. Whether a former owner should keep read access
to records from their own ownership period — to dispute a balance after a sale, say — is policy,
not engineering, and is listed below. If the board says yes, it is a narrow addition: condition 2
becomes "held Lot Authority over the Lot at any time", and condition 3 bounds detail to the
intersection with that past period. `authority.ts`'s history readers already answer the question.

Board Access (`capabilities.has('board')`) reads every Lot's records through the admin surface
only. A board admin who holds Lot Authority sees their own Lot on the homeowner surface under the
same three conditions as anyone else.

### Scoping lives inside the query

Lot Record reads live in their own server module (`src/server/lot-records/`), not in `reads.ts`.
Homeowner reads take `(env, personId, associationDay, …)` — never an array of lot ids handed in by
the caller — and embed `lotAuthorityExists({ value: personId }, { column: '<table>.lot_id' }, day)`
plus the period condition in the `WHERE` clause. The server never loads a wider set and filters it
in TypeScript, and never sends a row the caller may not read and relies on the client to hide it.
`requirePropertyAccess` may still serve as a cheap early refusal before the query. It is not the
boundary and is never the only check.

Board reads are named `fetchAdminLot*` and are reachable only from `requireBoard`-gated routes.
This follows the naming convention `test/server/reads-all-scoped.test.ts` enforces. The module
gets its own sibling of that suite, and every export must be classified as authority-scoped or
admin-only, or the suite fails.

A record the caller may not read renders the generic 404 on pages and answers `404` from APIs.
That covers another Lot's record id, a record before the caller's period, a voided record on the
homeowner surface, and every Lot Record surface while its flags are off. The response never
confirms that such a record exists.

### Storage is typed per record type; the audience is shared

There is no generic `lot_records` table with a JSON payload. Each record type gets its own table
with typed columns and CHECK constraints, matching the ADR 0022 ledger's refusal of arbitrary
JSON. What the types share is the audience: the scoping predicate, the gate, the 404 posture, the
flag, the AI exclusion, and the structural tests. A `LOT_RECORD_TYPES` enumeration in the module
names every Lot Record table, and the structural suites iterate it, so a new type added without
its scoping test fails the build.

The first two types:

- **Dues ledger** — `dues_ledger_entries`, specified by ADR 0025.
- **Violation** — `lot_violations`: `lot_id`, a governing-document `category` from a CHECK-bounded
  list, `effective_day` (the Association Day observed), a homeowner-visible `summary`, an optional
  board-only `internal_note`, `status` (`open` / `cured` / `closed` / `voided`), `created_by`,
  `created_at`. Status is transition-only through named actions, never through `PATCH`, the same
  rule resolutions and elections follow. A fine that results from a violation is a charge in the
  ADR 0025 ledger. Linking the two is deferred until the board uses fines through the site.

A board-only field on a Lot Record is projected out by the read helper for the homeowner caller,
following the admin-only-field pattern of ADR 0017 and ADR 0018. It is `null` on the homeowner
read, never merely hidden in the UI.

### Two flags, both required, both fail-closed

A new site setting, `lotRecordsEnabled`, defaults to `false`. It is normalized in
`normalizeSiteSettings` as `r.lotRecordsEnabled === true`, like `liveVotingEnabled`. Every Lot
Record surface requires **both** `officialMode` and `lotRecordsEnabled` to be literal JSON `true`.
Mutation SQL re-checks both inside the statement with a predicate shaped like
`LIVE_VOTING_ENABLED_SQL` in `src/server/content/voting-state.ts`. A board edit that lands while
the flags are being turned off therefore returns `409` rather than writing.

`officialMode` alone must not turn this on. Adopting the site is a decision about presentation and
homeowner business. Publishing Lot-level financial and enforcement records is a separate decision
with its own readiness steps: data loaded, balances checked, notice given. This mirrors
`liveVotingEnabled` exactly.

The new flag is **not** written by the whole-blob `PUT /api/admin/site`. That route replaces the
stored settings with whatever the admin form sends. A stale tab saving the tagline would re-send
an old flag value and silently toggle the feature. The generic `PUT` preserves the stored value of
`lotRecordsEnabled`. The flag changes only through a dedicated `board`-gated action that takes the
expected current value, compare-and-swaps it, and appends a row to a new append-only
`setting_changes` table (key, old value, new value, acting account, recorded at). A publication
decision this consequential must leave a record, and the ADR 0022 `audit_events` family CHECK is
the roster's ledger, not a settings log. ADR 0025's payments flag uses the same path.

The board surfaces are dark too. While either flag is off, admin Lot Record routes answer `404`
after `requireBoard`. Real Lot-level financial and enforcement data therefore cannot accumulate on
a site that still disclaims being the HOA.

### Gate order

- **Admin routes** (`/api/admin/lot-*`): `requireBoard` first (freeze on mutating verbs, `401`,
  `403`), then both flags (`404`), then the handler. Board-first keeps the codes identical to the
  middleware `/api/admin/*` backstop, which answers `401`/`403` before any route runs. It also
  keeps `admin-routes-all-gated.test.ts`, which expects exactly `401` for an anonymous caller with
  no settings seeded, valid without change. Existence is not a secret from anonymous callers on a
  namespace that already answers `401` uniformly.
- **Homeowner surfaces**: following ADR 0019's order, both flags first (`404`), then the write
  freeze, then `401`, then `403` without `member`. Scoping then happens in the query as above. The
  homeowner page renders server-side in its frontmatter with no client directive, per the
  rendering model. It sits outside `/homeowner/*`, because middleware redirects that prefix to
  `/login` before a page could answer `404`. A JSON read for client refresh, if one is needed,
  lives under `/api/member/`, and its per-route guard is `requireMemberApi`'s order with
  `lotRecordsEnabled` added beside `officialMode`. The `/api/member/*` middleware backstop checks
  only `officialMode` today. It gains the same flag check for the Lot Record paths, so both layers
  agree on existence, as the voting branch already does for `liveVotingEnabled`.

### Board CRUD, corrections, and audit

Board writes go through `POST` action buses. Every write records `created_by` (the acting account)
and `created_at`. State changes go only through named transitions. Nothing is hard-deleted:
a mistaken record is **voided** with a reason, stays visible to the board, and disappears from the
homeowner surface. Every create, transition, and void appends a row to `lot_record_events`
(record type, record id, action, acting account, reason code, recorded at). This follows the
ADR 0022 discipline: append-only by convention, since D1 has one binding and this codebase
forbids triggers, pinned by integration tests that no route updates or deletes an event row.
`lot_record_events` references its subject by `(record_type, record_id)` without a foreign key,
because one table serves several subject tables. `record_type` is CHECK-bounded to
`LOT_RECORD_TYPES`. Per-record board reads are not logged. A bulk export, if one is ever added, is
a recorded act, as `POST /api/admin/roster-export` is.

### Coverage by the existing guards

- **Write freeze.** No change needed. `freezePolicyFor` is deny-by-default: admin Lot Record
  mutations are `mutations`-class and any `/api/member/` route is `everything`-class.
  `freeze-coverage.test.ts` passes without an entry, and no exemption is warranted. The
  server-rendered homeowner page is a `GET` render, so homeowners can still read their records
  during a freeze.
- **`admin-routes-all-gated.test.ts`** covers new admin routes automatically by glob, unchanged.
- **`member-routes-all-gated.test.ts`** globs `/api/member/**` and seeds only `officialMode` and
  `liveVotingEnabled`. A Lot Record member route would answer `404` with `lotRecordsEnabled` unset
  and fail the suite's `401`/`403` expectations. The suite gains a per-route flag set in the same
  way it already special-cases the voting route.
- **`permission-matrix.test.ts`** likewise seeds only the two existing flags. It must seed
  `lotRecordsEnabled` so the board caller reaches the gate being asserted. Its callers are
  capability sets with a synthetic `lotIds`, which proves the gate, not the scope. So a new
  **cross-Lot suite** runs every homeowner read and route with seeded roster facts: a caller with
  authority over Lot A must get `404` or an absent row for every Lot B record. The matrix covers a
  co-owner, a Representative (organization-wide and Lot-scoped), a former owner after an `end`, a
  new owner's pre-period records, a board caller who owns no Lot, an unlinked account, and
  `cutover_mode = legacy`.

### What the AI assistant and document pipeline must never ingest

Lot Records are not documents. They are never inserted into `documents`, never written to R2 under
`documents/` or `rag/`, and so never reach the AI Search index, which is scoped to `rag/` and is
not tier-aware (SECURITY.md). `src/server/ai/` never reads a Lot Record table. The assistant, the
report generator, and the pseudonymizer's `loadRosterEntries` dictionary are all included. An
import-and-raw-SQL scan in the style of `test/unit/legacy-roster-consumers.test.ts` pins this for
every table in `LOT_RECORD_TYPES` and for `lot_record_events`.

Attachments, such as a violation notice or a photo, are deferred. When they come, they use a
separate R2 prefix outside `documents/` and `rag/`, served only by a Lot Record download route that
re-runs the scoping query. They never go through `/api/files/[id]`, whose check is a tier check.

### Data minimization and retention

Each record type stores only the fields its table names. The homeowner-visible summary and the
board-only note are separate columns, so board working notes never share a field with what the
Lot sees. Payment-method details beyond a coarse method and a board-only reference, such as a
check number, are never stored (ADR 0025). No automatic purge ships in the first slice, because
how long the association keeps closed violations and settled ledger history is policy. The
`src/server/scheduled.ts` job list can take a retention sweep as another independent job once the
board sets a period.

## Consequences

- The tier ladder stays a statement about sensitivity. Per-Lot visibility becomes a second axis
  with its own read module, gate, flag, and tests, rather than a special case of `visibility`.
- Co-owners and Representatives see identical Lot Records. Nothing on this surface can be
  addressed to one of them privately. A board that wants to write to one co-owner does so outside
  the site.
- A sale cuts the former owner off completely by default, and the buyer sees the Lot's running
  balance but not the seller's itemized history. Both follow from roster facts the board already
  records, so a backdated transfer changes visibility from the next request, with no stored access
  state to repair.
- The site cannot serve Lot Records until production runs `derived` authorization with Person
  Links. That is already true, so this is a dependency, not a blocker.
- Nothing is visible, and no board data entry is possible, until the board adopts the site and
  separately enables `lotRecordsEnabled`. Development and review proceed against local D1 with
  synthetic data only.
- The generic `PUT /api/admin/site` gains a preserve-this-key rule, and settings flags gain a
  change log. `officialMode` and `liveVotingEnabled` keep their current write path. Moving them
  onto the same audited action is tracked as #363, which should land before the `officialMode`
  flip in #361.

## Open questions for the board

1. **Former owners.** After a sale, should a former owner keep read access to the Lot Records from
   their own ownership period — for example, to settle a balance dispute — or lose all access at
   transfer (the default)?
2. **What a buyer sees.** Should a new owner see the Lot's running dues balance, including anything
   carried over from before their purchase, as a single "balance before <day>" line (the default)?
   Or should they see only activity from their own period? Or the full itemized history? Counsel
   may have a view where unpaid assessments run with the Lot.
3. **Violations before purchase.** Should an open violation recorded before a sale be visible to
   the buyer? The default is no, because its `effective_day` predates their period. Should the
   board instead be able to carry it forward explicitly?
4. **Retention.** How long does the association keep closed violations and settled ledger history
   for a Lot, before and after a transfer?
5. **Which record types come after dues and violations.** Architectural review requests and
   correspondence are candidates. Each is a new typed table under this ADR, not a new audience.

## Related decisions

- [ADR 0002: Tiered Content and Document Storage](./0002-tiered-content-and-document-storage.md)
- [ADR 0005: Resident Mode and Official Mode](./0005-resident-mode-and-official-mode.md)
- [ADR 0008: AI Assistant Privacy Gate](./0008-ai-assistant-privacy-gate.md)
- [ADR 0013: The Admin API Is Gated in Middleware, Not Only Per Route](./0013-admin-api-gated-in-middleware.md)
- [ADR 0019: Homeowner Writes Are Official-Mode Gated](./0019-homeowner-writes-official-mode-gate.md)
- [ADR 0022: A Party Roster Separates Identity, Ownership, Representation, Service, and Access](./0022-party-roster-derived-access.md)
- [ADR 0025: A Per-Lot Dues Ledger, with Online Payments Reconciled from Verified Provider Events](./0025-dues-ledger-and-online-payments.md)
