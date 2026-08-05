# Live Homeowner Voting and Conducted Elections — Design

- **Date:** 2026-08-05
- **Status:** Approved
- **Roadmap:** Item 9, Phase 1

This is the reviewed successor to the ignored
`docs/superpowers/specs/2026-08-03-homeowner-writes-design.md` working note. The proxy-granting
parts of that note have shipped; this document scopes only the remaining live-voting work.

## Purpose

Add the first site-conducted voting workflows for homeowner election ballots and member-meeting
motions. The existing application records paper elections, ballots, tallies, proxies, and member
votes after the fact. This phase adds `/vote` so an eligible homeowner or proxy holder can cast
while voting is open.

Live voting is inert by default. It requires both official mode and a separate board-controlled
feature flag. The design keeps election selections anonymous by construction while retaining a
recountable ballot box and a durable, board-visible historical record.

## Goals

- Let the board prepare, open, pause, close, and review conducted elections and member-motion
  voting.
- Let verified homeowners cast for their own lots and for lots whose valid proxies they hold.
- Make election selections structurally unlinkable to a lot, owner, proxy, turnout row, or casting
  time.
- Make casting, closing, pausing, and concurrent duplicate attempts deterministic and atomic.
- Freeze each vote's eligible properties and weights when it first opens so its denominator cannot
  drift with later roster changes.
- Preserve closed and certified results as a readable historical record.
- Keep every new surface unavailable until the board explicitly enables live voting.

## Non-goals

- Changing or retracting a submitted election ballot.
- Live candidate tallies.
- Cumulative or ranked-choice voting.
- Per-ballot dispute adjudication.
- A generic records archive spanning unrelated governance domains.
- Replacing the existing recorded-paper-election workflow.

## Feature flag and operating model

`SiteSettings` gains `liveVotingEnabled: boolean`. `DEFAULT_SITE_SETTINGS` and normalization both
default it to `false`, including when the settings row is missing, malformed, or predates the
field. The value is stored in the existing `settings` JSON row with key `site`; it does not require
a schema column.

The board controls the flag in Admin → Site Settings. It is a global kill switch layered beneath
`officialMode`:

| Official mode | Live voting | Homeowner result                   |
| ------------- | ----------- | ---------------------------------- |
| off           | either      | `/vote` and `/api/vote` return 404 |
| on            | off         | `/vote` and `/api/vote` return 404 |
| on            | on          | eligible callers may read and cast |

Disabling the flag pauses voting. It never changes an election status or a motion voting state,
and it never deletes a cast. Re-enabling it resumes every previously open item. Admin preparation
remains available while disabled, but opening an election or motion requires the flag to be on.
The admin UI labels an open item as globally paused when the flag is off.

## Election secrecy model

The existing `ballots` table remains the turnout register: it records that a property cast in an
election, its snapshotted weight, and either an owner or proxy provenance. It does not record a
selection.

A new `ballot_choices` table is the digital ballot box:

| Column         | Constraint                                         |
| -------------- | -------------------------------------------------- |
| `id`           | text primary key                                   |
| `election_id`  | foreign key to `elections.id`, cascade on delete   |
| `candidate_id` | foreign key to `candidates.id`, restrict on delete |
| `weight`       | non-negative integer, required                     |

The table has an index on `election_id`. It deliberately has no `ballot_id`, `property_id`, owner,
proxy, caster, created/updated timestamp, or other correlation field. Application types and reads
must not invent an indirect link. A schema test pins the allowed column set.

An election ballot is final. Because the selections are anonymous, neither a homeowner nor the
board can identify and edit one submitted ballot. A material ballot error requires the board to
void and rerun the election. This is the cost of making “how did lot X vote?” structurally
unanswerable. Motion votes remain attributable and may be corrected by the board after motion
voting closes.

ADR 0020 will record this model, the retained recount capability, and residual platform-level
correlation risks such as SQLite insertion order and D1 Time Travel.

## Schema and lifecycle

The next migration creates `ballot_choices` and adds `motions.voting_state`, a required text value
with default `none` and supported values `none | open | closed`.

It also creates two record-date snapshots:

- `election_eligibility(election_id, property_id, weight)`; and
- `motion_eligibility(motion_id, property_id, weight)`.

Each pair of parent id and property id is unique. Parent deletion cascades; property deletion is
restricted so a historical electorate cannot be damaged. The weight is the property's
non-negative vote weight when voting first opens. These rows contain no owner, proxy, ballot, or
choice data.

`ElectionStatus` gains `open`. Conducted elections follow:

```text
draft → open → closed → certified
  └──────────────→ void
```

`source: 'conducted'` is selectable only when creating an election and remains immutable.
Recorded elections retain their current behavior. Existing `setTallies` and `setBallots` actions
continue rejecting conducted elections.

Opening a conducted election requires:

- live voting enabled;
- current status `draft`;
- at least one non-withdrawn candidate; and
- at least one active eligible property; and
- visibility `public` or `homeowner`, so an eligible homeowner can see it.

The open operation atomically snapshots every active property and its vote weight, then changes
the election state. That snapshot is the election's record-date electorate. From this point,
title, date, seat count, meeting, visibility, candidate identity, and candidate statement are
immutable. A candidate may be withdrawn once while open, but not reinstated; choices already cast
for that candidate stay in the box.

Closing requires status `open`. The atomic close operation changes the state and derives every
candidate's final `votes` as `SUM(ballot_choices.weight)`. A candidate with no choices receives a
real zero. No tally is populated or exposed while the election is open. Closed elections cannot
reopen; certification and uncertification retain their current rules.

For member motions, `openVoting` and `closeVoting` actions are available only while the parent
meeting is a draft. Opening requires live voting enabled. Closing is reversible while the meeting
remains a draft so the board can recover from an operational mis-click. `setMemberVotes` returns
409 while a motion is open, preventing a bulk edit from racing live casts.

The first `openVoting` snapshots every active property and weight. A later close/reopen cycle
retains that original snapshot instead of adding newly active properties or changing weights. A
motion's text becomes immutable after its first open; its outcome, mover, second, and other meeting
record metadata may still be completed after voting closes.

The first open returns 409 if member votes were already entered, preventing an ambiguous hybrid of
pre-recorded and live votes. The board can clear those rows through the existing closed-state
editor before opening. Votes retained from a genuine live session remain in place across a later
close/reopen cycle.

## Atomicity and concurrency

Application-level validation provides useful errors, but it is not the concurrency boundary. The
decisive state checks and writes occur together in D1.

For an election cast, the server generates a new turnout-row id and anonymous choice ids, then
executes one atomic D1 batch. The turnout insertion is conditional on all of these still being
true inside the database operation:

- `officialMode` and `liveVotingEnabled` are true in the `site` settings JSON;
- the election is conducted and open;
- the property and snapshotted weight exist in `election_eligibility`;
- the supplied owner or proxy provenance is still valid for the caller; and
- the complete candidate set still belongs to the election, is not withdrawn, is distinct, and
  fits the election's immutable seat limit; and
- the election/property unique constraint is not already satisfied.

Choice inserts are conditional on the newly generated turnout id existing after that insertion,
without storing that id in `ballot_choices`. If the turnout insertion fails or affects no row, no
choice is inserted. Constraint failure rolls back the batch.

Close, pause, and cast operations are serializable at the D1 batch boundary:

- Cast first: close subsequently counts the complete ballot.
- Close first: the cast writes nothing and returns 409.
- Pause first: the cast writes nothing and returns 409.
- Two casts for one election and property: exactly one commits; the other returns 409.

Motion casting uses the same pattern: the insert is conditional on the feature flag, open motion,
draft member meeting, `motion_eligibility` row and snapshotted weight, still-valid owner or proxy
provenance, and unique motion/property pair at execution time.

Tests must deliberately exercise double-cast, close-versus-cast, pause-versus-cast, and invalid
choice batches and then inspect all affected tables for partial rows.

## Security boundary

Every homeowner voting read or write enforces this order:

1. Read normalized site settings. `officialMode` off returns 404.
2. `liveVotingEnabled` off returns 404.
3. On `POST /api/vote`, require an `Origin` header exactly equal to
   `new URL(request.url).origin`; missing or mismatched origin returns 403.
4. Require an authenticated caller at homeowner rank or higher.
5. Require the election or motion to be visible at the caller's tier.
6. Resolve a property the caller may represent; the acting owner or proxy holder must still be
   active even though the target property's eligibility is fixed by the record-date snapshot.
7. Require that property in the vote's immutable eligibility snapshot.
8. Validate owner/proxy provenance, candidates, seat count, choice, and lifecycle.
9. Perform the database-conditioned atomic write.

`POST /api/vote` accepts JSON only. Cross-origin, missing-origin, and non-JSON requests never reach
the casting logic. The same-origin helper is a focused server-only unit with direct tests.

The checks exist in middleware and in each route handler. Route handlers remain authoritative
because Worker route tests invoke them without middleware. The existing structural member-route
test expands to enumerate nested modules under `src/pages/api/member/` plus `/api/vote`, proving
that every exported verb fails closed when official mode or live voting is disabled and rejects
anonymous access when enabled.

## Eligibility

A caller casts for a property through exactly one path:

- **Own lot:** the property is in `ctx.propertyIds`; `castByOwnerId` is required and names an active
  owner of that property.
- **Held proxy:** `proxyId` belongs to the property and applicable meeting/election occasion, and
  its holder is an active owner of one of the caller's verified properties.

Supplying both owner and proxy provenance returns 400. An invalidly scoped proxy returns 409 using
the shared proxy guard; a proxy not held by the caller returns 403. Unknown or out-of-tier
occasions return 404 without confirming their existence.

Election candidate ids must be distinct, number from one through the election seat count, belong
to the election, and not be withdrawn. Motion choice is one of `yes | no | abstain`.

## API and read model

`POST /api/vote` has two append-only actions:

- `castBallot { electionId, propertyId, candidateIds, castByOwnerId? , proxyId? }`
- `castMotionVote { motionId, propertyId, choice, castByOwnerId? , proxyId? }`

No homeowner update or delete verb exists.

`fetchOpenVotingFor` is a dedicated server read. It returns only open conducted elections and
open member motions visible to the caller, candidate presentation data, eligible own and
proxy-held lots that occur in the applicable eligibility snapshot, and per-lot received state. It
does not relax the existing public election or draft-meeting reads. It never returns election
choices or live tallies.

## Homeowner experience

`/vote` is server-rendered. When either global gate is off it renders the generic 404. A signed-out
caller sees the sign-in path only when both gates are on. A verified homeowner sees:

- each open conducted election with candidates, statements, and seat limit;
- each open member motion with meeting title and date;
- one cast control for every eligible own or proxy-held lot; and
- a received state for each lot that has already cast.

Before submitting an election ballot, the UI shows the selected candidates and requires explicit
confirmation that the ballot is final and cannot be recovered or edited. The receipt confirms the
election and lot but does not echo candidate selections. A stale page submission after pause or
close is rejected server-side and writes nothing.

## Admin experience and history

Admin → Site Settings contains the Live Voting toggle with an emergency-pause explanation.

The Elections manager adds conducted/recorded source selection at creation, Open and Close actions,
and live turnout count and weight. It never shows a live candidate tally. Elections are presented
in two views:

- **Active:** draft and open elections, including an explicit globally-paused state.
- **History:** closed, certified, and void elections.

A historical conducted election shows date, status, source, candidates, read-only final totals,
winners, certification details, and weighted turnout against the frozen eligible-count and
eligible-weight denominators. Board users may inspect which properties were eligible and which
participated, including owner/proxy turnout provenance, but never how a property voted. Void
elections remain visible as part of the audit trail.

Member-motion Open and Close controls live in the Meetings manager. Historical motion tallies and
attributable property votes remain attached to their meeting, which is their natural record.

## Failure responses

| Condition                                              | Response  |
| ------------------------------------------------------ | --------- |
| Official mode or live-voting flag off                  | 404       |
| Anonymous caller with both gates on                    | 401       |
| Missing/mismatched Origin or unsupported content type  | 403 / 415 |
| Caller below homeowner or lot outside caller scope     | 403       |
| Unknown or out-of-tier occasion                        | 404       |
| Invalid owner, candidates, seat count, or vote choice  | 400       |
| Both owner and proxy provenance supplied               | 400       |
| Invalid occasion scope or non-open lifecycle           | 409       |
| Second ballot or motion vote for the same property     | 409       |
| Cast loses a close/pause race                          | 409       |
| Bulk member-vote edit while live motion voting is open | 409       |

## Test requirements

- Unit tests pin flag normalization/defaults, navigation behavior, input normalization, and the
  same-origin helper.
- Schema tests pin the exact `ballot_choices` column set and foreign-key actions.
- Snapshot tests prove eligible counts and weights do not change after property status or weight
  edits and survive motion close/reopen cycles unchanged.
- Worker tests cover every authorization, visibility, eligibility, proxy, lifecycle, and failure
  path.
- Concurrency tests prove all-or-nothing double-cast, close-versus-cast, and pause-versus-cast
  outcomes.
- Close tests prove weighted derivation, real zero totals, and absence of while-open tallies.
- Read tests prove choices and live tallies never leave the server and public record rules remain
  unchanged.
- Page tests prove both global gates render the 404 shell and use a mode-on eligible fixture as a
  positive control.
- Component tests cover final-ballot confirmation, receipts, paused labels, Active/History views,
  and absence of admin live tallies.
- Each delivery slice runs `format:check`, `agents:check`, `lint:coercions`, `check`, `test`,
  `test:server`, and `build`.

## Delivery slices

1. **Feature flag, schema, and lifecycle.** Add the normalized board setting, migration,
   electorate snapshots, configuration-freeze rules, conducted-election and motion transitions,
   admin pause status, ADR 0020, and lifecycle tests.
2. **Voting API and read model.** Add strict origin enforcement, eligibility resolution,
   atomic casting and close logic, route enumeration, and Worker security/concurrency tests.
3. **Homeowner and admin UI.** Add `/vote`, confirmation and receipts, active/history election
   views, motion controls, accessibility coverage, and page/component tests.

Every slice is safe to merge independently because the flag defaults off. The voting API slice
and the final integrated feature require explicit security review before merge.

## Deferred decisions

- Vote changing would require a link from a ballot to its choices and therefore a new secrecy ADR.
- Cumulative or ranked-choice voting needs a separate allocation and recount design.
- A recount action may later rerun the deterministic close aggregation; it is not required for the
  initial UI.
- Owner-linked identity may later replace lot-scoped owner self-selection if
  `user_property_links.owner_id` is introduced and backfilled.
- Notifications on open, cast, pause, close, or proxy changes require a separate communication
  policy.
