# Roster Admin UI — Design

**Date:** 2026-07-02
**Status:** Draft for review
**Branch:** feat/resident-rebrand-official-mode
**Builds on:** the people-per-home roster refactor (`properties` + `owners`, `/api/admin/{properties,owners}`, `/api/admin/members`).

## Context

The person-per-home roster refactor split the data into `properties` (homes) +
`owners` (people) and shipped the board-only API (`/api/admin/properties`,
`/api/admin/owners`, `/api/admin/members`), but **no admin UI** exists to drive
them. Today `AdminApp.tsx` has only Announcements / Documents / Dues / Site.
Boards need to view and maintain the roster and to process homeowner-access
requests from the browser rather than via SQL.

## Goals

- A **Roster** admin section to view all homes with their owners and to
  add / edit / deactivate homes and owners.
- A **Members** admin section to process the manual-approval queue (approve /
  deny pending homeowner requests) and revoke homeowner access.
- Follow the existing admin manager conventions exactly (component per section,
  shared `admin-panel`/`panel-card`/`list-row` classes, reads via a `lib`
  helper, writes via `lib/admin.ts`).

## Non-goals

- No hard deletes — removal is soft via `status: 'active' | 'inactive'`.
- No new roster/verification business logic — the API endpoints already exist;
  this is UI + thin client helpers + one small read enhancement.
- No ownership-transfer workflow beyond deactivate-old / add-new (manual).
- No bulk import UI (the CLI import remains the bulk path).

## Components

### `RosterManager` (`src/components/admin/RosterManager.tsx`)

Home-centric. Reads `GET /api/admin/properties` (each home carries its `owners`
nested). Layout:

- A top form to **add / edit a home** (address, unit, notes; when editing, also
  status).
- A `panel-list` of homes; each home is a `panel-card` showing address (+ unit),
  a status badge, and its owners beneath (name · phone · email · status). Each
  home has Edit / Deactivate(Reactivate); each owner has Edit / Deactivate.
- An **Add owner** control per home opens an owner form (fullName, phone, email,
  notes) that posts with that home's `propertyId`.

Operations → endpoints:

- Add home: `POST /api/admin/properties` `{address, unit?, notes?}`
- Edit home: `PATCH /api/admin/properties` `{id, address?, unit?, status?, notes?}`
- Add owner: `POST /api/admin/owners` `{propertyId, fullName, phone?, email?, notes?}`
- Edit owner: `PATCH /api/admin/owners` `{id, fullName?, phone?, email?, status?, notes?}`
- Deactivate / reactivate: the corresponding `PATCH` with `status`.

Owner-form guidance copy: phone should be E.164-ish (`+1XXXXXXXXXX`); the field
accepts what the board types (no client reformatting in v1).

### `MembersManager` (`src/components/admin/MembersManager.tsx`)

Reads `GET /api/admin/members` → `{ recent, queue }`.

- **Pending queue** (`queue`): each row shows the requester's email, the
  `claimedAddress`, the `reason`, and the date. **Approve** must link the person
  to a home, so it renders a **property picker** — a `<select>` of active homes,
  pre-selected by matching the row's `claimedAddress` against each home's
  address via a **best-effort case-insensitive compare done in the component**
  (no import of server code; if there is no clear match the picker defaults to
  no selection and the board chooses) — and posts
  `{action:'approve', queueId, propertyId}`. **Deny** posts
  `{action:'deny', queueId}`.
- **Recent homeowners** (`recent`): list with **Revoke** →
  `{action:'revoke', userId}`.

The picker sourcing: `MembersManager` also fetches `GET /api/admin/properties`
(active homes) to populate the `<select>`.

## API touch-up — `GET /api/admin/members`

Queue rows currently expose only `userId` (opaque in the UI). Enhance the GET to
join `users` so each queue row also carries `email` (and keep `userId`). Left
join so a queue row for a since-deleted user still renders (email null). No
change to POST actions (approve already accepts `propertyId`). This is the only
server change.

## Client helpers — `src/lib/admin.ts`

Add board-only helpers (reads live here too, since these endpoints are
board-gated, unlike the public reads in `content.ts`):

- `fetchProperties(): Promise<PropertyWithOwners[]>` — `GET /api/admin/properties`
- `saveProperty(data, id?)` — POST (create) / PATCH (update)
- `saveOwner(data, id?)` — POST (create, requires `propertyId`) / PATCH (update)
- `fetchMembers(): Promise<MembersView>` — `GET /api/admin/members`
- `memberAction(payload)` — `POST /api/admin/members`

Each throws on non-ok, matching the existing helpers.

## Types — `src/lib/types.ts`

`Property` and `Owner` already exist. Add:

- `PropertyWithOwners = Property & { owners: Owner[] }`
- `ManualApprovalItem { id; userId; email: string | null; claimedAddress; reason; status; createdAt }`
- `MemberUser { id; name; email; createdAt }`
- `MembersView { recent: MemberUser[]; queue: ManualApprovalItem[] }`

(Timestamps arrive as **ISO strings**: Drizzle `mode:'timestamp'` columns
deserialize to `Date`, which `Response.json` serializes to ISO. The UI formats
via the existing `lib/format` helpers.)

## Wiring — `AdminApp.tsx`

Add `{ key: 'roster', label: 'Roster', render: () => <RosterManager /> }` and
`{ key: 'members', label: 'Members', render: () => <MembersManager /> }` to the
`SECTIONS` array (after `documents`, before `dues` is a reasonable order — board
content first, roster/access next).

## Testing

- **jsdom component tests** (mirror `SiteManager.test.tsx`), mocking the
  `lib/admin` helpers:
  - `RosterManager`: renders homes+owners from a mocked `fetchProperties`;
    add-home submit posts the right payload; add-owner posts with the correct
    `propertyId`; edit-owner and deactivate post the expected `PATCH`.
  - `MembersManager`: renders queue+recent; **Approve posts the selected
    `propertyId`**; Deny and Revoke post the right actions.
- **Server tests**: extend `test/server/admin-members` coverage for the new
  email join (seed a queue row + user, assert the GET row carries `email`); add
  authenticated happy-path coverage for `properties`/`owners` GET/POST if not
  already present (the roster refactor left only 401 checks).

## Rollout

Pure additive UI + one read enhancement; no migration. Ships with the rest of the
branch. Board reaches it at `/admin` → Roster / Members after signing in.
