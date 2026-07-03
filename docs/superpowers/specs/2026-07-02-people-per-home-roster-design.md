# Roster: People-per-Home Model — Design

**Date:** 2026-07-02
**Status:** Draft for review
**Branch:** feat/resident-rebrand-official-mode

## Context

The roster backs homeowner sign-up: a user enters their property address, the
address is normalized and matched to a roster record, and a one-time code is sent
to the contact info on file. On success the user is linked to their home and
promoted to `homeowner`.

Today `owners` is one flat row per home: a combined `full_name` ("Jerry W Holland
Caitlyn R Holland") plus a single `phone`/`email`. That loses the second owner's
contact and misrepresents two people as one. The board's contact spreadsheet has
been restructured into per-person columns (`Homeowner 1/2`, `… Phone`, `… Email`),
so the source data is now cleanly separable — 19 of 21 homes have two owners.

## Goals

- Model each owner as a distinct person (own name, phone, email).
- Model the home/address once, shared by its owners; the address is the
  verification key ("someone who lives here").
- When a code is requested, deliver it to **every** distinct contact on the home
  for the chosen channel, so either owner can complete verification.
- Support ownership transfers naturally (deactivate old people, add new; the home
  record persists).

## Non-goals

- No structured address decomposition (street/city/state/zip). Matching is on a
  normalized address string; every home is one Raleigh NC 27603 address. YAGNI.
- No tenant modeling (the `Tenant …` columns are ignored).
- No per-person user accounts — verification links a user to a **home**, not a
  person.

## Data model

Split the flat `owners` table into `properties` (homes) and `owners` (people).

### `properties` (new)
| column | type | notes |
| --- | --- | --- |
| id | text pk | uuid |
| address | text notnull | raw property address |
| addressNormalized | text notnull | `normalizeAddress(address)`, match key |
| unit | text nullable | |
| status | text `active`\|`inactive` default `active` | |
| notes | text nullable | |
| createdAt / updatedAt | timestamp | |

### `owners` (repurposed → a person)
| column | type | notes |
| --- | --- | --- |
| id | text pk | uuid |
| propertyId | text notnull | logical FK → `properties.id` |
| fullName | text notnull | one person |
| phone | text nullable | E.164 (`+1XXXXXXXXXX`) |
| email | text nullable | |
| status | text `active`\|`inactive` default `active` | |
| notes | text nullable | |
| createdAt / updatedAt | timestamp | |

Removed from `owners`: `address`, `addressNormalized`, `unit` (now on the property).
Two people may share a phone/email — that is allowed; dedup happens only at send
time.

### Link tables — re-point owner → property
Verification proves membership of a **home**, so both link tables reference the
property, not a person:

- `propertyVerifications.ownerId` → `propertyId`
- `userPropertyLinks.ownerId` → `propertyId`

Consistent with the existing schema, these stay plain `text` columns (logical FK,
no enforced constraint). `manualApprovalQueue` is unchanged (it stores the claimed
address string).

**Migration is a clean restructure:** the roster was never successfully imported,
so `owners`, `propertyVerifications`, and `userPropertyLinks` are empty — no data
to backfill.

## Verification (fan-out) — `src/server/verification/property.ts`

`requestPropertyVerification(env, userId, address, channel)`:

1. `property = findActivePropertyByAddress(db, address)`. If none → enqueue
   `manualApprovalQueue` (reason: address not found); return `{queued}`.
2. Load active owners for the property. Build the recipient list for the channel:
   `sms` → distinct non-null `phone`s; `email` → distinct non-null `email`s.
   (Distinct so a shared phone isn't texted twice.)
3. If the recipient list is empty → enqueue manual approval (no contact for
   channel); return `{queued}`.
4. Delete the user's prior unconsumed verifications; generate one code; insert one
   `propertyVerifications` row (`propertyId`, `channel`, `codeHash`, expiry).
5. Send the code to each recipient. Succeed if **at least one** send resolves;
   if all fail, surface an error (code row remains for retry). One bad
   number/address never blocks the others.

`confirmPropertyVerification` is unchanged except it links
`userPropertyLinks(userId, propertyId)` and promotes visitor → homeowner.

`src/server/roster/lookup.ts`: replace `findActiveOwnerByAddress` with
`findActivePropertyByAddress` + `getActiveOwnersForProperty(propertyId)`.
`normalizeAddress` stays in `normalize.ts` (unchanged).

## Roster import — `scripts/import-roster.ts`

Each spreadsheet row → one `property` + one or two `owners`:

- property: `address` ← `Property Address`, `addressNormalized`, `unit` ← `Unit No`.
- person 1: `fullName` ← `Homeowner 1`, `phone` ← firstPhoneE164(`Homeowner 1 Phone`),
  `email` ← firstEmail(`Homeowner 1 Email`).
- person 2: only if `Homeowner 2` is non-empty; same mapping on the `Homeowner 2 …`
  columns.

Read cells defensively (`sheet_to_json` omits empty cells, so keys vary per row).
Reuse `firstPhoneE164` / `firstEmail` (kept). Emit `properties` INSERTs, then
`owners` INSERTs referencing the generated property ids. No dedup of shared phones
at import (allowed by design).

## Admin — `/api/admin/*` + `src/components/admin/AdminApp.tsx`

Owner management becomes two-level: homes, each with its people.

- API: add `/api/admin/properties` (GET list with nested owners for the UI; POST
  create; PATCH update address/unit/status). Repurpose `/api/admin/owners` to
  person CRUD (POST requires `propertyId`; PATCH updates/deactivates a person).
- UI: a Properties list; each home expands to its owners with add / edit /
  deactivate. Exact endpoint shapes and component structure to be finalized in the
  implementation plan after reading `AdminApp.tsx`.

## Types — `src/lib/types.ts`

Add `Property` and `Owner` shapes for the admin client (mirroring the columns
above, timestamps as ISO strings).

## Testing

- `test/unit/roster-import.test.ts`: per-person mapping — a row with two owners
  yields one property + two owners; `Homeowner 2` blank yields one owner; phone →
  E.164; email extraction; shared phone preserved on both people.
- Verification (server test): fan-out sends to all distinct contacts; shared phone
  deduped to one send; empty channel → manual queue; ≥1 success = ok.
- Update `roster-lookup` and `AdminApp` tests for the new shapes/endpoints.

## Migration & rollout order

1. Update `schema.ts`; `npm run db:generate`; review the generated migration.
2. `npm run db:migrate:local`, then `npm run db:migrate:remote` (empty tables).
3. Rewrite import; `npm run roster:import`; review `roster-import.sql`.
4. `wrangler d1 execute ashebrook-hoa --remote --file private/roster-import.sql`.
5. Ship verification + admin changes (they depend on the new schema).

## Risks / open items

- Per-person contact accuracy depends on the sheet; misalignments only affect
  tidiness, not verification (fan-out is per-home). Board fixes in admin.
- Admin UI is the largest surface; its detail is deferred to the plan.
- SQLite column renames become table rebuilds in the generated migration; safe
  here because the tables are empty, but review the migration before applying.
