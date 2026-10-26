# Tenant Access — Design

- **Date:** 2026-10-20
- **Status:** Accepted 2026-10-20, after maintainer review ([decisions](#review-decisions-2026-10-20))
- **Issue:** [#294](https://github.com/jwh3times/valleys-at-ashebrook-hoa/issues/294)
- **ADR:** [0028](../adr/0028-tenant-access.md)

## Purpose

Tenants live in the neighborhood without owning a Lot, and today the site has nowhere to put them.
[ADR 0028](../adr/0028-tenant-access.md) records the design, built on the board's 2026-08-11
decisions:

- A **Tenancy** is its own relation, which no Lot Authority reader joins.
- An owner requests it, the board approves it, and the tenant claims it.
- It ends when the owning party's Ownership ends, or at an end day at most 13 months out.
- Tenants see the public site plus homeowner documents the board marks **Tenant-Visible**.
- The feature is gated by `officialMode` plus its own audited `tenantAccessEnabled` flag.

This spec turns that into tables, routes, screens, tests and delivery slices.
[Departures from ADR 0028](#departures-from-adr-0028) lists the one place it departs from the ADR, which the maintainer accepted.

## Goals

- Any current holder of Lot Authority can request a Tenancy for a named person, and can see,
  renew, re-invite and end the Tenancies of their Lots.
- The board approves or refuses each request, and can end or void any Tenancy, from one admin
  panel.
- An approved tenant claims access with an invitation sent to the contact the board approved,
  using their own Account.
- A tenant reads public content plus Tenant-Visible documents, and nothing else.
- Every Tenancy fact is a Roster Change in the existing ledger.

## Non-goals

- Tenants writing anything: no proxies, voting, Lot Records, correction requests or directory.
- Announcements, meetings or any other content type marked for tenants. The board limited tenants
  to documents.
- Leases as documents. The site records an end day, never the lease.
- Notifying the board of new requests. The panel shows the queue; email alerts can come later.
- Tenancies of an Ownerless or retired Lot.

## Code facts this design rests on

Each fact was checked against `main` at `baac12e` on 2026-10-20.

1. **Migrations.** The highest migration is `0041_drive_imports.sql`. Migrations are written by
   hand, need a journal entry for `lint:migrations`, and do not deploy with the code. A table
   rebuild uses the `__new`-copy-and-rename technique and recreates the views that reference it
   (`docs/agents/migrations.md`).
2. **Columns.** `day()` is ISO-day text, `instant()` is integer milliseconds, and
   `intervalOrdered()` is the ordering CHECK (`roster-schema.ts:19-24`).
3. **The audit ledger.** A Tenancy stays in the `roster_change` family. `event_kind` and
   `reason_code` are unchecked text, so new kinds need no migration. **Subjects need one:**
   `roster_change_subjects` has one FK column per subject kind with an exactly-one CHECK
   (`audit-schema.ts:521-563`), so adding a `tenancy_id` subject means rebuilding that table and
   recreating `audit_event_subjects_v` (from `0023`). The TS allow-lists `RosterSubjectColumn` and
   `ROSTER_SUBJECT_COLUMNS` (`roster/audit.ts:206-234`) grow with it.
4. **The consequence hook points.** Ownership `end` and `void` (`api/admin/roster-ownerships.ts`)
   and `transfer` (`roster/ownership-transfer.ts`) all build one batch in the same order:
   1. the primary statement;
   2. `lossConsequences`;
   3. `transferEffects`;
   4. `correlation.statements`;
   5. flags;
   6. `assertInBatch`.

   Lot retirement (`roster-lots.ts` `retireLot`) ends each current Ownership itself and calls
   neither engine. The transfer preview (`OwnershipTransferPreview`, `src/lib/ownership-transfer.ts`)
   names every consequence, and its token covers the tables in `snapshotTables`.

5. **The non-overlap guard.** A conditional `INSERT … SELECT … WHERE NOT EXISTS (overlapping row)`
   is the pattern, in its two-sided form at `roster-representations.ts:425-434`. The invariant gate
   (`db/invariants.ts`) has 17 checks, and its `intervalCheck` helper takes the end column as a
   parameter. `audit_integrity_violations_v` is at D1's five-term compound-SELECT ceiling.
6. **Person and Contact Method creation** are route-local functions: `createPerson`
   (`roster-parties.ts:106-148`) and `addContactMethod` (`roster-contact-methods.ts:90-180`). There
   are no shared builders.
7. **Verification codes are keyed to the requesting Account.** `verification_codes.account_id` is
   NOT NULL, and a request deletes that Account's other open codes. Codes are 6 digits, with a
   10-minute TTL and 5 attempts (`verification/codes.ts`), plus KV send limits per Account, Lot
   and Person (`verification/rate-limit.ts`).
8. **A Person Link proven by contact fits the existing CHECKs.** `person_verifications` accepts
   method `otp_email`/`otp_sms` with a `contact_method_id`, no approver, and reason
   `automatic_contact_proof` (`0026`:60-80). `identity_events.reason_code` is unchecked.
   `confirmPersonVerification` (`roster/verification.ts:395-519`) is the one-batch writer to copy.
9. **The request-and-review pattern.** Member requests that the board decides already exist:
   `correction_requests` (`0024`), and its member route with a `409` on a duplicate open request
   and a masked `404` out of scope. **No admin panel lists them.** `AdminApp.tsx` has no queue
   panel, so this feature adds the first one.
10. **Guards.**
    - `requireMemberApi` checks `officialMode` (`404`), then the freeze (`503`), then `401`, then
      `403` without `member`.
    - `requireBoard` checks the freeze on mutating verbs, then `401`, then `403`.
    - `/api/verify/*` gets only the freeze from middleware.
    - `lotAuthorityExists(person, lot, day)` is the mutation-SQL Lot Authority fragment.
    - `LOT_RECORDS_ENABLED_SQL` (`lot-records/gate.ts`) is the both-flags SQL predicate to copy.
11. **Site gates.** A gate key added to `SiteSettings`, `DEFAULT_SITE_SETTINGS`,
    `normalizeSiteSettings` and `SITE_GATE_KEYS` (`src/lib/types.ts`) gets the audited
    compare-and-swap `setGate` action and PUT preservation with no further code. `SiteManager.tsx`
    needs a `GATE_COPY` entry.
12. **Documents.**
    - `documents` has no CHECK constraints.
    - `fetchDocumentsFor(env, role)` (`content/reads.ts:62-77`) is the only list read, used by
      `/documents` and `/api/content/documents`.
    - `/api/files/[id]` is the only download, gated by `tierAllows`, and returns `404` when hidden.
    - `meetings/[id]` links a minutes document without checking it, so the download gate is that
      link's only guard.
    - The board edits visibility through `PATCH /api/admin/documents` in `DocumentsManager.tsx`.
    - `store.ts`'s INSERT names its columns, so a new column takes its default.
13. **Navigation.** `accountNav` (`src/lib/site.ts:102-164`) branches on `contentTier` and `lotIds`
    only. A signed-in visitor sees "Verify your property", and a tenant would see the same.
14. **The structural suites.**
    - `permission-matrix.test.ts` builds callers from capability sets and seeds the site flags as
      literals.
    - `member-routes-all-gated.test.ts` seeds only `officialMode` and `liveVotingEnabled`.
    - `reads-all-scoped.test.ts` classifies every read export by name.
    - `freeze-coverage.test.ts` requires every mutating route to be frozen.
    - `legacy-roster-consumers.test.ts` scans for table names, but its import regex does not see
      `roster-schema` imports.
    - `test/server/dual-fixtures.ts` resets a fixed table list.

## Decisions

### 1. Tables

One migration per slice; see [Delivery slices](#delivery-slices).

**`tenancies`** holds the roster fact:

| Column                     | Type                                  | Notes                                                  |
| -------------------------- | ------------------------------------- | ------------------------------------------------------ |
| `id`                       | text PK                               |                                                        |
| `tenant_person_id`         | text, FK `people(party_id)`, restrict | the tenant                                             |
| `lot_id`                   | text, FK `lots(id)`, restrict         |                                                        |
| `basis_ownership_id`       | text, FK `ownerships(id)`, restrict   | the owning party's Ownership (ADR 0028)                |
| `start_day`                | day, NOT NULL                         | the approval's Association Day                         |
| `scheduled_end_day`        | day, NOT NULL                         | exclusive; at most 13 months after `start_day`         |
| `actual_end_day`           | day                                   | exclusive; an early end                                |
| `end_reason`               | text                                  | paired with `actual_end_day`                           |
| `ended_by_account_id`      | text                                  | plain text, no FK, by the actor-column convention      |
| `renews_tenancy_id`        | text, FK `tenancies(id)`              | the Tenancy this one renews, or null                   |
| `voided_at`                | instant                               | a Tenancy recorded in error                            |
| `invite_contact_method_id` | text, FK `contact_methods(id)`        | the approved contact every invitation goes to (`0045`) |
| `created_at`, `updated_at` | instant, NOT NULL                     |                                                        |

The names follow `board_terms`, so `COALESCE(actual_end_day, scheduled_end_day)` means the same thing
in both. The CHECKs are:

- `intervalOrdered` on both end columns;
- `actual_end_day` at or after `start_day`;
- `actual_end_day` paired with `end_reason`;
- `end_reason IN ('owner_ended', 'board_ended', 'basis_ended', 'lot_retired')`.

The 13-month cap is checked in the mutation SQL, not in a CHECK: a CHECK using `date()` arithmetic
on columns is untested in this codebase, and the cap is a policy number the board may change.

**A Tenancy is current on day `d`** when all of these hold:

- it is not voided;
- `start_day <= d < COALESCE(actual_end_day, scheduled_end_day)`;
- its basis Ownership is unvoided and current on `d`;
- its Lot is not retired.

That definition lives once, as `TENANCY_CURRENT_SQL` in a new `src/server/roster/tenancy.ts`, and
every reader uses it.

**`tenancy_requests`** holds the owner's request, which is not yet a roster fact:

| Column                                    | Notes                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `id`, `lot_id`, `created_at`              |                                                                         |
| `requested_by_account_id`                 | plain text                                                              |
| `requested_by_person_id`                  | FK `people`; whose Lot Authority approval re-checks                     |
| `basis_ownership_id`                      | FK `ownerships`; resolved when the request is made                      |
| `kind`                                    | `new` or `renewal`                                                      |
| `renews_tenancy_id`                       | FK `tenancies`; set exactly when `kind = 'renewal'`                     |
| `tenant_name`, `channel`, `contact_value` | for `new` only; cleared when the request is decided (see below)         |
| `scheduled_end_day`                       | the requested end day                                                   |
| `status`                                  | `open`, `approved`, `refused` or `withdrawn`                            |
| `decided_at`, `decided_by_account_id`     | set together when the status leaves `open`, as in `correction_requests` |
| `refusal_reason`                          | free text shown to the requester; required on `refused`                 |
| `tenancy_id`                              | FK `tenancies`; set on `approved`                                       |

**The tenant's name and contact leave the request when it is decided.** On approval they move into
`people` and `contact_methods`, where Roster Redaction and the AI pseudonymizer already reach them.
On refusal or withdrawal they are cleared. A CHECK enforces it: `status = 'open'` or the three
columns are null. The request table never holds a name or contact the roster doesn't, and only
while it waits. A partial unique index allows one open request per Lot and normalized contact.

**The basis is resolved when the request is made.** If the requester holds a Current Ownership of
the Lot, the basis is that Ownership. Otherwise it is the represented Organization's Current
Ownership that gives them Lot Authority. If two would qualify, direct Ownership wins.

**`tenancy_invitations`** holds the claim credential; see [decision 4](#4-the-invitation-and-the-claim).

**`documents.tenant_visible`** is `INTEGER NOT NULL DEFAULT 0`, with a CHECK that it is 0 or 1 and
is 1 only when `visibility = 'homeowner'`. It is added with `ALTER TABLE … ADD COLUMN`. The default
satisfies the CHECK for every existing row, which the migration test confirms. No rebuild is
needed.

### 2. Deriving Tenant Access

`deriveAccess` gains a third statement in its existing batch, so the cost stays one round trip:

```sql
WITH me AS (… the LOT_SQL one-hop consolidation, unchanged …)
SELECT EXISTS (
  SELECT 1 FROM tenancies t JOIN me ON t.tenant_person_id = me.party_id
  WHERE <TENANCY_CURRENT_SQL at ?2>
) AS has_tenancy
```

- `has_tenancy = 1` adds the `tenant` capability. `contentTier` is unchanged, so a tenant who owns
  nothing stays `visitor`.
- The derivation reads no site settings. The roster says who is a tenant, and the gates decide
  what that unlocks (decision 5). Setting `tenantAccessEnabled` off therefore needs no change to
  derivation, and the next request sees nothing.
- `Capability` gains `'tenant'`. Nothing checks it exhaustively. `requireMemberApi`,
  `requireBoard` and `requireVotingApi` never accept it.

### 3. Requests and approval

**Member API: `POST /api/member/tenancies`**, an action bus behind `requireMemberApi` (which
needs `officialMode`), then, for `request`, `renew` and `reinvite`, `tenantAccessEnabled` (`404`
when off), then `403` without a `personId`. Every action re-checks `lotAuthorityExists` for the
caller inside its own statement, and the gated ones re-check `TENANT_ACCESS_ENABLED_SQL` there too,
so a race answers `409`. `withdraw` and `end` stay live with `tenantAccessEnabled` off (review
decision 6):

| Action     | Does                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| `request`  | Opens a `new` request: name, `email` or `sms` channel, value, Lot, end day. `409` on a duplicate open. |
| `renew`    | Opens a `renewal` request for a current Tenancy of a Lot the caller holds. Needs no name or contact.   |
| `withdraw` | Withdraws an open request for a Lot the caller holds, whoever made it.                                 |
| `end`      | Ends a current Tenancy of the caller's Lot today, with `owner_ended`, as a Roster Change.              |
| `reinvite` | Issues a fresh invitation for an approved, unclaimed Tenancy (decision 4).                             |

A Tenancy or request outside the caller's Lots answers the masked `404`. The end day must be after
today and at most 13 months out (`400`).

**`GET`** on the same route, which also stays live with `tenantAccessEnabled` off, lists, for each
of the caller's Lots:

- current and upcoming Tenancies, with the tenant's name, the end day and whether the invitation
  has been claimed;
- open requests;
- requests refused in the last 90 days, with the board's reason.

It shows no contact values beyond the masked last characters of the invited contact.

**The owner page** is `/tenants`, outside `/homeowner/*` for ADR 0024's reason: it must be able to
answer `404`. It renders only when `officialMode` is on and the caller has `member`. With
`tenantAccessEnabled` off it renders only when one of the caller's Lots has a Tenancy or an open
request on file, and then offers End and Withdraw but no request form or Renew. A server-rendered
list carries a small client form for the actions.

**Admin API: `POST /api/admin/tenancies`.** It runs `requireBoard`, then checks the gates for every
action except `refuse`, `end` and `void`, which stay live with the gates off (ADR 0028; review
decision 6). It has a `GET` list, which says whether approval is open.

| Action     | Does                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `approve`  | For `new`: names an existing Person, or creates one from the request. Adds the Contact Method if that Person lacks it. Records the Tenancy. |
| `refuse`   | Records the reason, clears the name and contact. No ledger row, as with correction requests.                                                |
| `end`      | Ends a Tenancy today with `board_ended`.                                                                                                    |
| `void`     | Voids a Tenancy recorded in error, with a reason.                                                                                           |
| `reinvite` | As the member action.                                                                                                                       |

**Approval is one batch.** It re-checks:

- the request is still `open` (compare-and-swap on `status`);
- the requester still holds Lot Authority over the Lot today (`lotAuthorityExists` on
  `requested_by_person_id`);
- the basis Ownership is current and unvoided, and the Lot is not retired;
- both gates are on;
- the caller still has Board Access, through `CAPABILITY_SQL` in the batch, as
  `ownership-transfer.ts` does;
- no current or future Tenancy of the same Person and Lot overlaps;
- the end day is after the start and at most 13 months out.

Any failed check answers `409` with the reason the panel shows. For a renewal, the new Tenancy
starts the day the renewed one is scheduled to end, so the two are adjacent. If that day has
already passed, it starts today.

One `AuditCorrelation` records:

- `person_created` (when new) and `contact_method_recorded` (when added);
- `tenancy_recorded`, with evidence `{kind: 'request', requestId}`.

`createPerson` and `addContactMethod` move from their routes into shared builders in
`src/server/roster/`, and the existing routes call them, so there is one copy of each insert.

**Matching an existing Person.** The approve form searches the roster by name and by the requested
contact. It shows any Person who already holds that contact, because a contact shared by two
identities is not uniquely attributable. The board decides; nothing matches automatically, in line
with Duplicate Owner Consolidation.

**The admin panel** is a new **Tenants** panel in `AdminApp.tsx`. It has an open-requests queue,
where each request carries an approve dialog and a refuse dialog, and a Tenancies table with end,
void and re-invite. Row actions carry accessible names such as
`Approve tenancy request: <tenant name>`. It is the first request-queue panel, so its list and
dialog components are written to be reused by the verification and correction queues later, but
those queues are not moved here.

### 4. The invitation and the claim

**The invitation is a link, not a 6-digit code.** It is a 256-bit random token in a link to
`/tenant-invite?token=…`, sent by email or SMS through the existing senders. It is stored only as
an HMAC under `BETTER_AUTH_SECRET`, like the codes, is good for 14 days, and is single use.

The reason: the existing 6-digit code is safe because it lives 10 minutes, allows 5 attempts and
is bound to the Account that asked for it. An invitation is sent before the tenant has an Account,
must survive days in an inbox, and is entered by whichever Account the tenant signs in with. A
6-digit code with that lifetime and no binding could be guessed. This is the
[departure from ADR 0028](#departures-from-adr-0028).

`tenancy_invitations` has these columns:

- `id`, `tenancy_id`, `contact_method_id`, `channel`;
- `token_hash`, unique;
- `expires_at`;
- `consumed_at`, `consumed_by_account_id`, `superseded_at`;
- `created_at`.

A new invitation supersedes every earlier unconsumed one for the same Tenancy. Sends are limited
per Tenancy, to 3 a day, in KV with the existing helpers. The daily cleanup job deletes invitations
that expired more than 30 days ago.

**The claim.** The emailed link opens `/tenant-invite`, a page that **only displays**. A GET never
consumes the token, because mail scanners prefetch links.

- A signed-out visitor is sent to sign in or register, with the token kept through the redirect.
- A signed-in visitor sees the Lot's address and a **Claim** button, which calls
  `POST /api/verify/tenant-claim`.

The route checks, in order:

1. the write freeze (from middleware, and again in the route);
2. `401`;
3. the gates (`404`);
4. a per-Account claim limit (5 a day);
5. the token.

On success, one batch, copied from `confirmPersonVerification`:

1. consumes the invitation, re-checking that it is unexpired, unconsumed and unsuperseded;
2. re-checks that the Tenancy is current and both gates are on;
3. inserts `person_verifications` with method `otp_email`/`otp_sms`, the invitation's
   `contact_method_id`, and reason `automatic_contact_proof`. All of these fit the existing CHECKs
   (fact 8). Following the token proves control of the contact the board approved;
4. inserts the `person_links` row;
5. records a `person_verified` Identity Event with reason code `tenant_invitation`.

The outcomes:

| Situation                                          | Result                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| The Account is already linked to the tenant Person | `200`. The invitation is consumed, and the Tenancy already applies.               |
| The Account is linked to a different Person        | `409 linked-elsewhere`: "this account belongs to someone else; contact the board" |
| The tenant Person is linked to another Account     | `409 person-linked`: "contact the board"                                          |
| The token is unknown, expired, used or superseded  | `400 invalid-invitation`, the same answer for each                                |

**Navigation.** `AccountNavAuth` gains `capabilities`:

- A caller with `tenant` and without `member` sees **Documents** and **Account**, and no longer
  sees "Verify your property".
- A caller with `member`, with both gates on, sees a **Tenants** link to `/tenants`.

### 5. Gates

- **The flag.** `tenantAccessEnabled` joins `SiteSettings`, its default, its normalizer and
  `SITE_GATE_KEYS`, with a `GATE_COPY` entry. That copy says turning it on lets owners request
  tenants and lets approved tenants see Tenant-Visible documents.
- **The SQL predicate.** `TENANT_ACCESS_ENABLED_SQL` in `src/server/roster/tenancy.ts` copies
  `LOT_RECORDS_ENABLED_SQL`, requiring `officialMode` and `tenantAccessEnabled` to be literal JSON
  `true`.
- **Where it is checked.** The request, renew, reinvite, approve and claim mutations all check it,
  and so does the document predicate. End, void, refuse and withdraw don't (review decision 6).

### 6. Documents

**One predicate decides what a reader can see.** `documentVisibleTo(reader)` in
`src/server/content/visibility.ts` returns a Drizzle condition built from
`{contentTier, capabilities}`. When the reader holds `tenant`, it is:

```sql
visibility IN (<visibleTiers(contentTier)>)
OR (tenant_visible = 1 AND <TENANT_ACCESS_ENABLED_SQL>)
```

When the reader doesn't hold `tenant`, it is only the first line.

- **`fetchDocumentsFor(env, reader)`** takes the reader instead of a role. Both callers pass
  `authContext`. It also projects `tenantVisible`, for the board's list.
- **`/api/files/[id]`** selects with `WHERE id = ? AND documentVisibleTo(reader)`. When there is no
  row it answers `404`, so the list and the download cannot disagree. Public documents skip the
  session lookup as they do today.
- **`PATCH /api/admin/documents`** accepts `tenantVisible`:
  - `400` when the document's resulting visibility is not `homeowner`.
  - Any visibility change away from `homeowner` sets `tenant_visible = 0` in the same `UPDATE`.
  - A CHECK failure from a race answers `409`.
- **`DocumentsManager.tsx`** gets a Tenant-Visible checkbox in the edit form, shown only for
  homeowner documents, plus a "Tenant-Visible" filter tab and badge.
- **Uploads and Drive Imports start unmarked.** `store.ts`'s INSERT names its columns, so it takes
  the default 0.
- **Readers that don't change:** the AI assistant, reports and the duplicates panel are board-only.

### 7. Consequences of Ownership changes

`tenancyLossStatements(ownershipId, day, correlation)` in `roster/tenancy.ts` ends every current or
future Tenancy whose basis is that Ownership. It sets `actual_end_day = MAX(start_day, day)` and
`end_reason = 'basis_ended'`, and registers a `tenancy_ended` consequence event on the caller's
correlation. It runs next to `lossConsequences` in four places:

| Path                                | `day`                        | Reason        |
| ----------------------------------- | ---------------------------- | ------------- |
| Ownership `end`                     | the Ownership's end day      | `basis_ended` |
| Ownership `void`                    | today                        | `basis_ended` |
| `transfer`, per departing Ownership | the transfer's effective day | `basis_ended` |
| Lot retirement, per Ownership ended | the retirement day           | `lot_retired` |

- **The transfer preview** gains `tenanciesEnding`: the tenant name, Lot and scheduled end of each
  Tenancy it will end. `tenancies` joins `snapshotTables`, so a Tenancy approved after the preview
  invalidates its token.
- **Open requests aren't closed** by these paths. Approval re-checks the basis and the requester's
  Lot Authority, so such a request can only be refused. The panel marks it "basis ended" and offers
  only Refuse.
- **No Review Flag.** The access a tenant had before the change was real, so ending it needs no
  review.
- **Representation changes don't end Tenancies.** The basis is the Organization's Ownership.

### 8. The ledger and the invariants

- **Subjects.** `roster_change_subjects` is rebuilt to add `tenancy_id`, with the exactly-one
  CHECK widened, and `audit_event_subjects_v` is recreated. `RosterSubjectColumn` and
  `ROSTER_SUBJECT_COLUMNS` gain the column.
- **Event kinds:** `tenancy_recorded`, `tenancy_ended` and `tenancy_voided`.
- **Reasons:** the `RosterChangeReason` union gains `tenancy_request_approved`, `owner_ended`,
  `board_ended`, `basis_ended` and `lot_retired`, plus `recorded_in_error` for a void.
- **The actor of an owner's end** is the owner's Account. This is the one Roster Change a non-board
  Account may make. `CONTEXT.md`'s Roster Change entry gains the exception: _"except that a
  current holder of Lot Authority may end a Tenancy of that Lot."_
- **The invariant gate** gains two direct queries in `invariants.ts`, not branches of the view at
  the five-term ceiling, which brings it to 19:
  - `tenancy_overlap`: `intervalCheck` on `tenant_person_id` and `lot_id`, with the effective end
    `COALESCE(actual_end_day, scheduled_end_day)`. The helper's `end` parameter is widened to take
    an expression.
  - `tenancy_on_ended_basis`: a current Tenancy whose basis Ownership has ended or been voided.

### 9. Privacy page

Slice 3 is the first to collect tenants' names and contacts, so it updates `src/pages/privacy.astro`
with a new official-only section beside "Voting, proxies, and lot records". It says:

- an owner supplies the tenant's name and one contact;
- the board sees them, and refused requests are cleared;
- an approved tenant joins the roster like an owner;
- the invitation is sent through the same email and SMS providers.

A retention line goes under "How long we keep information". Slice 4 updates the section to cover
the invitation.

## Departures from ADR 0028

1. **The claim uses a single-use link, not the 6-digit code machinery.** The ADR says the claim
   "reuses the existing code machinery". The token is still HMAC-stored under the same secret,
   sent through the same senders and limited by the same KV helpers. What changes is a 256-bit
   token and a 14-day life in place of a 6-digit code and 10 minutes, because the invitation is not
   bound to an Account and must last in an inbox (decision 4). Slice 4 amends the ADR's sentence.
2. **More actions stay live with the gates off.** The ADR exempts the board's end and void. Refuse,
   and the owner's end and withdraw, are exempt too (review decision 6), for the ADR's own reason
   that ending access must never wait on a gate, and so that a pending request's name and contact
   can always be cleared. None of them grants anything. Slice 4 amends the ADR's sentence.

## Failure and edge behavior

| Situation                                          | Result                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Either gate off                                    | Request, renew, approve and claim `404`; tenants see public only                     |
| Gates off, board ends, voids or refuses            | Allowed                                                                              |
| `tenantAccessEnabled` off, owner ends or withdraws | Allowed; `/tenants` shows what is on file, without the request form                  |
| `officialMode` off                                 | The whole member API and `/tenants` `404` (ADR 0019); the board's actions remain     |
| Requester sold the Lot before approval             | Approve `409 basis-ended`; the panel offers Refuse only                              |
| Two board admins approve the same request          | One succeeds; the other `409 already-decided`                                        |
| Request whose end day has passed by approval       | `409 end-day-passed`; the owner submits a new one                                    |
| Owner ends a Tenancy the board is ending           | First wins; the second `409 already-ended`                                           |
| Invitation expired                                 | Claim `400 invalid-invitation`; the owner or board re-invites                        |
| Tenant claims after the Tenancy ended              | `409 tenancy-ended`                                                                  |
| Tenant also owns another Lot                       | `member` and `tenant`; homeowner tier already includes every Tenant-Visible document |
| Board demotes a document from homeowner to board   | `tenant_visible` cleared in the same `UPDATE`                                        |
| Ownership consolidated into a survivor             | Ownership rows do not move, so the basis stays valid                                 |
| Tenant's Person consolidated into another          | The `me` CTE resolves the survivor, as for Lot Authority                             |

## Tests

### Worker/D1 tests

- **`test/server/tenancy-derive.test.ts`.** Test `tenant` and `contentTier: 'visitor'` across:
  - a current Tenancy;
  - before start, on the scheduled end (exclusive) and after an actual end;
  - a voided Tenancy;
  - an ended or voided basis Ownership;
  - a retired Lot;
  - a consolidated tenant;
  - an owner who is also a tenant (`member` plus `tenant`).
- **`test/server/tenancy-requests.test.ts`.** Every member action, covering:
  - the masked `404` across Lots;
  - a direct owner and a Representative (organization-wide and Lot-scoped) as requesters;
  - basis resolution, preferring direct Ownership;
  - the duplicate-open `409`;
  - the 13-month cap;
  - withdrawal by a co-owner.
- **`test/server/tenancy-approval.test.ts`.**
  - Approve a new request with a new Person and with an existing one, and approve a renewal (the
    adjacent start).
  - Each re-check failing inside the batch leaves zero rows and answers `409`.
  - Refusal clears the name and contact.
  - The audit correlation's events and subjects.
- **`test/server/tenancy-claim.test.ts`.**
  - A claim by email and by SMS.
  - Every `409` and `400` above.
  - Superseded, expired and consumed invitations.
  - A GET of `/tenant-invite` never consumes the invitation.
  - The `person_verifications` row and Identity Event shapes.
  - The per-Account limit.
- **`test/server/tenancy-consequences.test.ts`.**
  - Ownership end, void, transfer and Lot retirement each end the right Tenancies, with the
    `actual_end_day` above.
  - A co-owner's Ownership leaves other Tenancies alone.
  - A Representation end changes nothing.
  - The transfer preview lists `tenanciesEnding`, and its token is invalidated by a new Tenancy.
- **`test/server/tenant-documents.test.ts`.**
  - The list and the download agree for each reader class, gates on and off.
  - A Tenant-Visible document reaches a tenant and not a visitor.
  - A non-flagged homeowner document is `404` to a tenant.
  - A minutes link to a document the tenant may not see is `404`.
  - The PATCH rules, including clearing the flag on demotion and `409` on a race.
- **Migrations.** A migration test for each new migration. `invariants.test.ts` covers the two new
  checks, each violated once.

### Static and structural suites

- **`permission-matrix.test.ts`.** It gains a `TENANT` caller and asserts `403` on every admin and
  member route. `tenantAccessEnabled: true` joins its seeded flags.
- **`member-routes-all-gated.test.ts`.** Its settings helper takes the third flag, so
  `/api/member/tenancies` reaches its `401`/`403`.
- **`freeze-coverage.test.ts`.** It pins the new mutating routes as frozen. `tenant-claim` is
  frozen too: no exemption.
- **`reads-all-scoped.test.ts`.** It classifies the new read exports. The owner's list reads are
  `fetchMemberTenanc*`, scoped by Lot Authority; the board's are `fetchAdminTenanc*`.
  `fetchDocumentsFor` takes a reader.
- **A new `test/unit/tenancy-not-lot-authority.test.ts`.** It pins that `roster/authority.ts`,
  `board-consequences.ts` and the `LOT_SQL` constant never name `tenancies` or
  `tenancy_requests`, by import or in SQL. It reuses the `legacy-roster-consumers` scanner, with
  its import pattern widened to `roster-schema`. The scan covers the `LOT_SQL` string itself
  rather than the whole of `derive.ts`, which must name the table.
- **`test/server/dual-fixtures.ts`.** `NEW_TABLES` gains the three tables, and `seedRoster` gains a
  Tenancy option.
- **A sibling of the `ai/` scan** pins that `src/server/ai/` never reads `tenancy_requests` or
  `tenancy_invitations`.

Every new guard is mutation-checked against the code with the guard removed, per the repo's
standing rule.

## Delivery slices

Each slice is one PR. **Each slice's migration must be applied to production before its PR
merges**, because Workers Builds deploys on merge:

- Slice 1's document read selects the new column.
- Slice 2's `deriveAccess` queries `tenancies` on every signed-in request, so merging it first
  would fail every signed-in page.

`/ship` files a `ready-for-human` follow-up for each migration, with the 0033/0039 precedent noted.

1. **The document flag and the gate.**
   - Migration `0042`: `documents.tenant_visible`.
   - `tenantAccessEnabled` with its predicate and copy.
   - `documentVisibleTo`, shared by the list and the download.
   - The PATCH rules and the `DocumentsManager` checkbox, filter and badge.

   No tenant exists yet, so for users the only change is that the board can mark documents ahead
   of time.

2. **The Tenancy fact.**
   - Migration `0043`: `tenancies`, the `roster_change_subjects` rebuild and the view.
   - The `tenant` capability in `deriveAccess`.
   - The Ownership-change consequences and the preview field.
   - The admin `end`/`void` actions and a read-only Tenancies table in the new panel.
   - The two invariants, the not-Lot-Authority scan and the fixtures.
3. **Requests and approval.**
   - Migration `0044`: `tenancy_requests`.
   - The member route and the `/tenants` page.
   - The approve and refuse actions and the queue in the Tenants panel.
   - `createPerson` and `addContactMethod` extracted as shared builders.
   - The privacy-page section.
4. **Invitation and claim.**
   - Migration `0045`: `tenancy_invitations`.
   - Sending on approval, and `reinvite`.
   - `/tenant-invite` and `/api/verify/tenant-claim`.
   - The navigation changes and the cleanup job.
   - The privacy-page update and the ADR 0028 amendment.

After slice 4, using the feature in production needs the board to:

- adopt the site (#361);
- mark documents Tenant-Visible;
- turn on `tenantAccessEnabled`.

Those are association decisions, tracked on #361 and #294, not code.

## Out of scope

- Moving the verification and correction queues into the new queue panel.
- Email alerts to the board about new requests.
- Tenant-visible announcements, meetings or other content.
- Bulk tenant import. A roster import screen is #292's question.
- A tenant directory.

## Review decisions (2026-10-20)

The maintainer accepted every recommendation on 2026-10-20. The sections above already describe
these answers.

| #   | Decision                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------ |
| 1   | The claim uses a 14-day, single-use 256-bit link instead of the 6-digit code. Slice 4 amends ADR 0028. |
| 2   | The board and any Lot Authority holder over the Lot may re-invite, at most 3 sends a day per Tenancy.  |
| 3   | A decided request keeps no tenant name or contact. A refusal leaves only its reason.                   |
| 4   | Any Lot Authority holder over the Lot may withdraw an open request, whoever made it.                   |
| 5   | The four slices ship in the order listed, each migration applied to production before its PR merges.   |

## Review decisions (2026-10-25)

From the slice 3 code review.

| #   | Decision                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6   | Refuse, and the owner's end and withdraw, stay live with the gates off, so a pending request's name and contact can always be cleared. The owner's actions still need `officialMode`, like every member route. |

## Review decisions (2026-10-26)

From slice 4, where this spec was silent. The maintainer accepted each.

| #   | Decision                                                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7   | Every invitation goes to the contact the board approved, which the Tenancy records (`invite_contact_method_id`, added by `0045`): approval sets it and a renewal copies it. A re-invite answers `409` if that contact has since ended, been voided or been redacted, or if the Tenancy predates the column. |
| 8   | Approving a renewal sends an invitation only while the tenant Person has no current Person Link, to the renewed Tenancy's approved contact. A tenant who has claimed needs none: the renewed Tenancy applies to their account at once.                                                                      |
| 9   | Sign-in, registration and Google sign-in return to `next` only when it is exactly `/tenant-invite?token=<token>`, so it cannot become an open redirect. `/tenant-invite` offers both links to a signed-out visitor rather than redirecting.                                                                 |
| 10  | An invitation may be sent and claimed while its Tenancy is current **or upcoming**, not only current as [§ 4](#4-the-invitation-and-the-claim) first said: decision 8 sends to an upcoming renewal, whose link must work before the renewal starts.                                                         |
| 11  | A claim also requires the invited contact to still be on file (unvoided, unredacted, current), so voiding a mistyped contact kills the link sent to it.                                                                                                                                                     |
