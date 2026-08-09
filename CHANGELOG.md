# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.65] - 2026-08-09

### Fixed

- **The Elections panel no longer offers an add-candidate form that the server refuses.** A closed
  recorded election showed a working-looking form, but candidates can only be added while an
  election is a draft, so submitting it always failed. A candidate may also now be withdrawn from
  a conducted election while voting is open — the one change the record permits at that point,
  which the panel previously hid.

### Changed

- What the board may do to an election — edit, add or remove a candidate, type tallies or a ballot
  register, certify, uncertify, void, delete — is now decided in one place rather than by a single
  catch-all condition inside the list rendering, so each control matches the rule the server
  actually enforces.

## [0.3.64] - 2026-08-09

### Changed

- Server tests now share one fixtures module (`test/server/fixtures.ts`) for the request helper,
  the row builders, and the foreign-key-safe table reset that each suite previously re-derived by
  hand. No application code or behaviour changes.

## [0.3.63] - 2026-08-09

### Fixed

- **Recording attendance or a member vote for an owner who does not exist now returns a readable 400.** `represented_by_owner_id` and `cast_by_owner_id` are real foreign keys to the owner
  roster, so an unknown id previously escaped `setMemberAttendance` and `setMemberVotes` as a raw
  database constraint error — a 500 with no explanation. Only the ballot register pre-checked it.
  All three entry-set routes now share one guard and answer the same way.

### Changed

- The rule that an entry names either a proxy or an acting owner but never both — the same
  invariant in member attendance, member votes, and the ballot register — is now defined once in
  the proxy guards rather than restated in each of the three routes.

## [0.3.62] - 2026-08-09

### Fixed

- **Large meeting archives and high-turnout elections no longer fail to load.** D1 accepts at most
  100 bound parameters per query, and two reads bound one parameter per row of a prior result
  without batching: the motion counts behind the public meeting list, and the per-lot address
  lookup behind the board Elections panel. An association with more than 100 approved meetings, or
  a single election in which more than 100 lots voted, hit `too many SQL variables` and the page
  failed outright. Both now batch, and the limit itself moved out of a private constant in the
  read model into `src/server/db/chunked.ts`, so future reads of the same shape inherit it.

## [0.3.61] - 2026-08-09

### Fixed

- **A failed admin panel load no longer hangs on "Loading…".** `useAdminResource` had error
  handling for saves but none for the load it runs on mount, so a rejected fetch left every
  affected admin panel stuck on its loading state, produced an unhandled rejection, and told the
  board nothing. The load now records a `loadError` and writes the same `"Error: …"` text into the
  message banner each panel already renders, so the failure is visible in all twelve panels
  without per-panel handling. `reload()` still rethrows after recording, because the panels call
  it from inside a save action — swallowing there would report success over a list that never
  refreshed.

## [0.3.60] - 2026-08-07

### Changed

- **Agent synchronization now starts from `.agents/skills`.** Each authored skill is a complete
  directory source, so synchronization safely replaces former junctions, regenerates
  `.claude/skills` for Claude Code, and emits `.codex/agents` custom-agent TOML from the authored
  Claude agent definitions. Format first, then run `npm run sync:agents`; generated trees should
  not be edited or replaced with skill symlinks.

## [0.3.59] - 2026-08-07

### Changed

- Bumped the direct development dependencies `@cloudflare/workers-types` from 5.20260801.1 to
  5.20260804.1 and `@testing-library/user-event` from 14.6.1 to 14.6.3.

## [0.3.58] - 2026-08-07

### Added

- **Completed the default-off live homeowner voting experience.** When official mode and live voting
  are both enabled, verified homeowners can use `/vote` to cast a conducted-election ballot or
  member-motion vote for their own lot or an occasion-valid proxy they hold. The review dialog names
  the pending selection and provenance, moves and traps keyboard focus, supports Escape/cancel with
  focus restoration, disables background voting controls, and warns that the homeowner cannot
  change, recover, or recast through `/vote`. An exact-204 success becomes a selection-free receipt;
  conducted-election choices are application-wide undisplayable and irreplaceable, while attributed
  member-motion votes remain board-correctable after close.
- **Added board controls for the complete live-voting lifecycle.** Site settings can enable or
  globally pause voting; the Elections panel separates draft/open **Active** records from durable
  **History**, opens and closes conducted elections, and monitors turnout by count and weight. The
  Meetings panel opens, closes, and reopens member-motion voting while preserving its frozen
  electorate and votes.

### Changed

- Opening an election or motion freezes active lots and voting weights as the historic denominator.
  Disabling official mode or live voting pauses new opens and casts without closing an occasion or
  deleting snapshots, turnout, votes, or retained choices; restoring both settings resumes an
  occasion that is still open. Closing a conducted election atomically derives its final aggregate
  candidate totals and moves it to History, while a closed member motion may reopen against its
  original snapshot.

### Security

- The voting route requires the `Origin` header to equal the request URL's origin exactly before it
  processes JSON, session, role, or resource input. Casting repeats official-mode/live-voting,
  visibility, own-lot or held-proxy authority, frozen eligibility and weight, open-state, and
  one-cast checks inside the atomic D1 mutation, so a racing pause, close, authority change, or
  duplicate leaves no partial write.
- Conducted turnout and retained choices remain structurally non-linked: choice rows carry only
  election, candidate, and frozen weight, with no ballot, lot, owner, proxy, caster, timestamp,
  shared receipt, or other identity join field. No live candidate tally or lot-to-choice history is
  exposed; totals appear only after close. Rare weights, SQLite insertion order, and D1 Time Travel
  remain documented residual inference limits rather than a claim of mathematical anonymity.

## [0.3.57] - 2026-08-06

### Security

- **Updated `js-yaml` to the patched 4.3.1 release.** The lockfile now resolves Astro's YAML
  parser dependency outside the range affected by quadratic CPU consumption during `!!omap`
  parsing (GHSA-5p4m-2wfm-xmqj).

## [0.3.56] - 2026-08-06

### Added

- **Added the default-off homeowner casting API and eligible-caller read model.** `POST /api/vote`
  accepts final conducted-election ballots and one-time member-motion votes for a verified lot or
  an occasion-scoped proxy the caller holds. The server-only open-voting projection returns visible
  open occasions, caller-controlled eligible lots, frozen weights, valid owner/proxy options,
  election candidates, and only a per-lot `hasCast` receipt. There is still no GET voting API,
  `/vote` page, navigation entry, homeowner voting UI, or new admin UI.

### Security

- **Made the voting surface fail closed before input or resource processing.** Both middleware and
  the route guard require official mode and live voting first, then exact equality between the
  required `Origin` header and request origin, JSON media type, an authenticated session, and the
  homeowner role. Unknown or out-of-tier occasions remain `404`, and own-lot or held-proxy
  authority is checked server-side.
- **Kept record-date weights and race checks inside the atomic write boundary.** Election turnout
  and identity-unlinked retained choices are inserted together using only the frozen eligibility
  snapshot; motion votes use the corresponding frozen motion weight. Mutation predicates repeat
  visibility, authority, open state, feature flags, and one-cast-per-lot checks, so a racing close,
  global pause, authority change, or duplicate cast records nothing and returns `409`. Disabling
  official mode or live voting pauses new casts without deleting snapshots or voting history.

## [0.3.55] - 2026-08-06

### Added

- **Added the default-off foundation for live homeowner voting without exposing a homeowner voting
  route yet.** Site settings now persist a fail-closed `liveVotingEnabled` flag, and additive D1
  migrations introduce identity-unlinked retained `ballot_choices`, frozen election and motion
  eligibility snapshots, member-motion voting state, and a monotonic correction revision. No `/vote`,
  `/api/vote`, casting flow, or homeowner voting UI is part of this release.

### Changed

- **Conducted elections and member motions now have atomic board-only lifecycle foundations.**
  Opening freezes the active-property electorate and weights; conducted-election configuration and
  motion text are then protected as historical facts. Conducted elections publish no live tally
  and derive final candidate totals from retained choices only when closing. Motion close/reopen
  retains its original snapshot and votes, while state-plus-revision compare-and-swap prevents a
  stale board correction from overwriting an intervening session. Election, motion, and meeting
  deletion guards retain every record that has live-voting history.

### Security

- **Digital election choices are recountable without an explicit turnout identity link.** Choice
  rows contain no ballot, lot, owner, proxy, caster, timestamp, or other identity/join field;
  supported reads never correlate them to turnout, and ADR 0020 prohibits adding such a field.
  This is not mathematical anonymity: a rare or unique snapshotted weight retained on both turnout
  and choice rows may identify or narrow a property's selections, while SQLite insertion order and
  D1 Time Travel add residual operator-level temporal correlation risk.

## [0.3.54] - 2026-08-05

### Security

- **Cleared the Undici and Sharp dependency advisories in the Cloudflare development toolchain.**
  Miniflare now resolves Undici 7.29.0 and Sharp 0.35.2, while the refreshed Astro language-server
  chain resolves YAML 2.8.3; both production-only and full-tree npm audits now report zero
  vulnerabilities.

## [0.3.53] - 2026-08-05

### Changed

- **Refreshed the project roadmap around the shipped structured association record and made live
  homeowner voting the next product priority.** Architecture and operator documentation now cover
  meetings, resolutions, recorded elections, proxies, saved AI reports, the production migration
  ledger, and the fact that Worker deployments do not apply D1 migrations automatically.

## [0.3.52] - 2026-08-05

### Changed

- Bumped the transitive development dependency `fast-uri` from 3.1.4 to 3.1.5.

## [0.3.51] - 2026-08-04

### Changed

- Bumped `@cloudflare/vitest-pool-workers` from 0.19.0 to 0.20.1,
  `@cloudflare/workers-types` from 5.20260730.1 to 5.20260801.1, `@types/react` from 19.2.17 to
  19.2.18, `@types/react-dom` from 19.2.3 to 19.2.4, and `@vitejs/plugin-react` from 6.0.4 to
  6.0.5; the refreshed lockfile also updates Wrangler from 4.115.0 to 4.118.0.

## [0.3.50] - 2026-08-04

### Added

- **Verified homeowners can now grant and revoke proxies online when the site is operating in
  official HOA mode.** The new Proxies page lists the caller's active lots, published upcoming
  member meetings and elections, proxies they granted, and proxies they hold. A grant identifies
  the granting owner, resolves the holder from an active-owner street-address lookup, and stays
  tied to exactly one occasion; an unused grant can be revoked until that occasion has passed,
  while a proxy already cited by attendance, a vote, or a ballot remains protected from deletion.

### Security

- Homeowner proxy pages and APIs fail closed when official mode is off, require a current verified
  lot, scope grants and revocations to that lot, and return indistinguishable not-found responses
  for hidden occasions and foreign proxy ids. Holder lookup returns only active-owner names and
  opaque ids—never contact data—and held proxies redact occasion titles and dates above the
  caller's visibility tier. The occasion cutoff follows the association's `America/New_York`
  calendar day, and the grant form invalidates stale holder selections after address changes,
  failed lookups, or out-of-order responses. See
  [ADR 0019](docs/adr/0019-homeowner-writes-official-mode-gate.md).

## [0.3.49] - 2026-08-03

### Added

- **Recorded proxies can now be edited from the admin Proxies tab.** An Edit button on each proxy
  loads it into the form for correcting the holder's name, the holder-as-owner link, or which of
  the lot's owners granted it — the fields a mis-read paper form actually gets wrong. The lot and
  the occasion stay fixed while editing, since moving a proxy to another lot or occasion is a
  different proxy, not an edit; recording that remains delete-and-re-add, as before.

### Changed

- **A proxy can no longer be recorded against a board meeting.** Only member attendance, member
  votes, and election ballots can cite a proxy, so a proxy tied to a board meeting could never be
  used — it was an inert row waiting to confuse someone. The Proxies tab now offers only member
  meetings as occasions, and the API refuses a board-meeting proxy outright, so the rule holds
  even for a caller bypassing the picker. Election occasions are unchanged, and any proxy recorded
  against a board meeting before this rule still displays in the record list.
- The proxy pickers in the attendance, vote, and ballot editors are now one shared component, so
  the rule for which proxies are offered — including "a proxy for the annual meeting also covers
  the election held there" — lives in exactly one place. No visible behavior changed.

## [0.3.48] - 2026-08-03

### Added

- **A proxies record: the board can now record that an owner authorised someone to act for their
  lot** at one meeting or one election, entered from the signed paper forms the association already
  collects. A proxy names the lot, the granting owner, and the holder — who need not be an owner
  (a spouse, a neighbour, an attorney); when the holder is an owner, the link is recorded too, so
  "whose proxies did Jane hold?" stays answerable. Each proxy is scoped to exactly one occasion,
  enforced by a database CHECK constraint rather than only a route guard, and one lot can hold at
  most one proxy per occasion. Revocation is deletion: an unused proxy is simply removed, while a
  proxy already cited by attendance, a vote, or a ballot is refused deletion with a message naming
  where it is used. See [ADR 0018](docs/adr/0018-proxies-record-via-proxy-consolidation.md).
- A new **Proxies** tab in the admin panel records and deletes proxies, grouped by the meeting or
  election they cover, so the board sees "who is covered for the March meeting" at a glance. The
  attendance, vote, and ballot editors replace their old "via proxy" checkbox with a proxy picker
  that offers only the proxies actually valid for that lot at that occasion; choosing one clears
  the owner picker beside it, since who acted now lives on the proxy record itself.
- Recording attendance, votes, or ballots against a proxy is validated server-side, not just in
  the picker: the proxy must exist, must belong to the lot it is used for, and must be scoped to
  the occasion being written — a proxy signed for the March meeting cannot justify a vote at the
  June meeting. A proxy scoped to a meeting also covers an election held at that meeting, matching
  what a form signed "for the annual meeting" actually authorises, while a standalone election
  accepts only its own proxies.
- Migrations `0014` and `0015` add the `proxies` table and replace the free-floating `via_proxy`
  booleans on member attendance, member votes, and ballots with a real `proxy_id` reference —
  "acted by proxy" is now derived from an actual proxy on file rather than asserted by a checkbox
  nothing backed. All three tables carry no production rows, so the change rewrites no history.

### Changed

- Who held a lot's proxy is board-only. Public meeting and election pages still show that a lot
  acted by proxy — that fact carries the tier of the meeting or election it belongs to — but the
  proxy's identity, and even its opaque id, never appear on a public read, so two lots can never
  be publicly correlated to the same holder.
- Deleting a meeting is now also refused when an election's recorded ballots cite a proxy scoped
  to that meeting — previously reachable only through an unusual sequence (recording ballots under
  a meeting-scoped proxy, then detaching the election from the meeting), which would have surfaced
  as a raw database error instead of a readable message.

## [0.3.47] - 2026-08-03

### Added

- **A build check rejects numeric form values defaulted with `||`.** `Number('')` and `Number('0')`
  are both `0`, so a pattern like `Number(field) || 1` cannot tell an empty box from a typed zero
  and quietly substitutes the default — and because that happens in the browser, the server never
  receives the zero to reject it, so nobody sees an error. This shipped twice as a real bug: a
  lot's vote weight became 1 when a board member entered 0, and a candidate's tally was stored as
  a genuine zero when the field was simply left blank. Both were caught in review before release;
  the check now fails the build instead of relying on someone noticing.

## [0.3.46] - 2026-08-02

### Added

- **An elections book records the outcome of board elections held on paper**, distinct from the
  meeting record's motions and from the resolutions book's standing rules: an election has its own
  title, seat count, election date, and a roster of candidates, each with a name, an optional
  statement, and a per-candidate tally. The ballot itself is never linked to a candidate anywhere
  in the record — only that a lot returned a ballot is stored, which is what makes the aggregate
  turnout figure answerable while individual choice stays unrecorded, not merely hidden. See
  [ADR 0017](docs/adr/0017-elections-secret-by-construction.md).
- An election moves through four board-driven transitions: **close** ends voting and locks in the
  candidate roster and turnout as recorded; **certify** declares winners from the closed election's
  candidates and writes the board's official acceptance of the result; **uncertify** reverses a
  certification that needs correction; **void** abandons an election that should not stand as a
  record at all. A closed or certified election is a settled fact and is never surfaced to the
  public while still a draft or once voided, regardless of who is asking.
- **Certifying an election opens a term of service** for each winner on the board roster: a winner
  who already has a board-person record gets a new term starting from the date the board supplies,
  and a first-time winner gets a new board-person record created alongside it. A candidate cannot
  be certified into a term while they already hold one that hasn't ended, and the same candidate
  cannot win the same election twice.
- A new **Elections** tab in the admin panel creates elections, manages their candidates, records
  each candidate's tally and the per-lot ballots that produced the turnout figure, and drives all
  four transitions from the closed/certified/void state machine. A tally left blank stays
  unrecorded rather than counting as zero — the two are different facts, and a candidate whose
  tally was never entered is shown as not recorded on the public page instead of appearing to have
  been shut out.
- A new public page, `/elections`, lists closed and certified elections with each candidate's
  tally, winners marked, and turnout stated only in aggregate — lots and vote weight, both against
  their eligible totals — never the per-lot list of who returned a ballot. A visibility tier applied
  per election controls who sees it, the same as resolutions and meetings.
- Migration `0013` adds the `elections`, `candidates`, and `ballots` tables, with a unique index
  preventing two ballots from the same lot on one election and another preventing two candidates
  from sharing a sequence position within one election.

### Changed

- Deleting a meeting is now refused when an election records it as where it was held. The link
  would otherwise be dropped silently, leaving a certified election with no record of the meeting
  it took place at — unlink the election first if the meeting really needs to go.
- A term of service created by certifying an election can no longer be deleted directly from the
  board roster. Removing it that way would leave the election still claiming a winner whose term
  had vanished; uncertifying the election is the way to undo it, which removes the terms it
  created and reopens the result for correction.

### Fixed

- A meeting's `body` (board vs. member) could previously be changed after creation through the
  general-purpose `PATCH` endpoint, even once the meeting already had attendance or votes recorded
  against the voter model that `body` selects — silently producing a meeting record whose attendance
  and vote rows no longer matched what the meeting claimed to be. `body` is now fixed at creation;
  changing it requires creating the meeting again with the right value.
- Deleting a board person linked to a candidacy previously raised a raw, uncaught D1 foreign key
  error instead of a clear response. The `board_people` delete pre-check now covers that case too,
  alongside the meeting-record references it already checked, and returns a `409` naming it.

## [0.3.45] - 2026-08-02

### Added

- **A resolutions book records the board's standing rules** — pool hours, parking, architectural
  guidelines, and similar policies adopted outside individual meeting motions. Each resolution is
  its own durable record with a citation number, title, body, and effective date, distinct from the
  meeting record's motions: a motion that fails still happened and stays in the meeting record, but
  only an adopted resolution appears in the book. Amending a resolution creates a new one that
  supersedes the old rather than editing it in place, so "what's in force today" is always a single
  lookup and the full history stays traceable back through the chain of replacements. See
  [ADR 0016](docs/adr/0016-resolutions-supersession-chain.md).
- A resolution moves through three board-driven transitions: **adopt** brings a drafted resolution
  into force with an effective date and, optionally, the motion that authorized it; **supersede**
  brings a new resolution into force while retiring its predecessor as superseded, both in one
  atomic write so the two can never land out of step; **repeal** retires an in-force resolution
  without replacing it, leaving its place in the chain intact for anyone tracing the history later.
- A new **Resolutions** tab in the admin panel creates and edits resolutions and drives all three
  transitions, grouping the book by status so what is currently in force reads first. Adopting or
  superseding offers a picker of recorded motions, so the rule can be tied back to the vote that
  authorized it without anyone handling an internal identifier. A resolution can be deleted only
  while still a draft; anything that has ever taken effect is permanent history.
- A new public page, `/resolutions`, lists in-force resolutions by default, with a toggle to include
  superseded and repealed ones, each with its full text and a rendered chain of what it supersedes.
  A visibility tier applied per resolution controls who sees it, and the chain itself respects that
  tier in both directions: an out-of-tier predecessor or successor shows only that a link exists,
  never its number or title.
- Migration `0012` adds the `resolutions` table, with unique indexes preventing two resolutions from
  sharing a citation number or both claiming to supersede the same predecessor.

### Changed

- Deleting a motion, or a meeting containing one, is now refused when a resolution cites that motion
  as the one that adopted it. Previously the deletion succeeded and silently detached the
  resolution's provenance, which nothing could restore — the link is recorded when the resolution is
  adopted and cannot be edited afterward. Ending a motion's tie to a resolution is now an explicit
  act rather than a side effect of tidying up a meeting.
- An effective date supplied when adopting or superseding a resolution must be a real calendar date.
  Dates that merely look well-formed, such as `2026-02-31`, are rejected rather than stored and
  displayed verbatim on the public page.

## [0.3.44] - 2026-08-01

### Added

- **Member meetings now record per-property attendance and votes**, alongside the existing board
  attendance and roll-call votes on the same meeting record. The admin panel's Meetings tab gains
  property-based editors for both; the public meeting page renders a weighted "N of M votes
  represented" attendance line and each property's vote on a motion.
- **Properties carry a vote weight** (defaulting to 1, one vote per lot), editable from the roster
  admin panel; a weight of zero is rejected, since a property that should not vote belongs at
  inactive status instead. Every member tally and quorum figure sums weight rather than counting
  properties, so associations that vote one-lot-one-vote see identical results to a simple count,
  and associations that weight by lot size or ownership share need no separate mode. See
  [ADR 0015](docs/adr/0015-weighted-member-voting.md).
- Migration `0011` adds `properties.vote_weight`, `member_attendance`, `member_votes`, and nullable
  mover/seconder property references on `motions`.

### Changed

- **Publishing a member meeting exposes each property's address alongside how it voted.** No
  resident names are published, but the admin panel now warns about this at the visibility
  control before a board member makes a member meeting public.

## [0.3.43] - 2026-08-01

### Added

- **Board meetings, motions, and roll-call votes are now a structured record**, with new public
  pages, `/meetings` and `/meetings/[id]`, listing and detailing approved meetings: attendance,
  each motion's text, mover and second, and how every board member voted, alongside a derived tally
  and the board's recorded outcome.
- A new **Meetings** tab in the admin panel creates and edits meetings (body, kind, date, time,
  location, a linked minutes document, a written summary), records board attendance, and manages
  each meeting's motions and roll-call votes.
- Four new tables (migration `0010`): `meetings`, `board_attendance`, `motions`, and `board_votes`.
  New board-only endpoints `/api/admin/meetings` (create, edit, attendance, approve, unapprove,
  delete) and `/api/admin/motions` (create, edit, votes, delete).

### Changed

- **A meeting only appears on the public pages once a board member explicitly approves it.**
  Publication now asks two questions instead of one: has this meeting been approved, and who may
  see it. Approving and unapproving are explicit actions, each recording (or clearing) who approved
  the meeting and when. See [ADR 0014](docs/adr/0014-meeting-record-status-gate.md).
- `ReportMarkdown` moved from the admin components to `src/components/react/`, gaining a safe-link
  allow-list so links inside a generated report render only when they point somewhere expected.

## [0.3.42] - 2026-08-01

### Security

- **The board-only API surface is now gated in middleware**, not only by a guard repeated by hand in
  every route handler. Requests to `/api/admin/*` are rejected before they reach a route — `401` for
  an anonymous caller, `403` for an authenticated non-board one, matching the codes `requireBoard`
  already returned. Previously `src/middleware.ts` protected the `/admin` pages but not the API
  behind them, so an admin route shipped without its guard would have been live and no existing test
  would have failed. Every handler keeps its own `requireBoard` call as the enforced layer; the
  middleware gate is a backstop.
- Added a structural test that enumerates every module under `src/pages/api/admin/` and asserts each
  exported verb rejects an anonymous caller. Per-resource gate tests only cover routes someone
  remembered to write a test for; this one fails when the _route_ is added, so a new endpoint cannot
  ship ungated.

See [ADR 0013](docs/adr/0013-admin-api-gated-in-middleware.md).

## [0.3.41] - 2026-08-01

### Added

- Board roster in the admin panel: board members with their offices and terms of service, on a new
  **The Board** tab. A person who leaves and returns keeps one entry with multiple terms.
- `board_people` and `board_terms` tables (migration `0009`), plus board-only
  `/api/admin/board-people` and `/api/admin/board-terms` endpoints.
- [ADR 0012](docs/adr/0012-board-record-as-structured-rows.md) — the board record is modeled as
  structured rows, a person and a term are separate entities, and board membership is independent
  of site accounts.

### Changed

- The admin **Board members** tab is now labeled **Board access**, since it manages who can sign in
  to the admin panel rather than who serves on the board.

## [0.3.40] - 2026-07-31

### Changed

- **Roadmap refreshed after the governing-documents report shipped.** The AI CC&R Compliance
  Report item is now marked partially implemented, pointing at the report feature released in
  0.3.39 and naming what it does not yet cover: the compliance angle proper — where current
  practice diverges from the governing documents — which needs a record of current practice to
  compare against, plus deferred refinements (a retention policy for saved report content, a
  structured-output query planner, saved-report list pagination, and skipping generation when
  retrieval returns nothing).
- Recorded three further product backlog items — minutes and motion/vote records, election
  management, and a reserve planning tracker — each gated on its own spec or a board decision, and
  added a Product Opportunities section that keeps longer-range product vision out of the backlog
  proper. No code or architecture changes accompany this; nothing here is scheduled work.

## [0.3.39] - 2026-07-31

### Added

- **Board members can generate saved, citable AI reports over the governing documents.** A new
  **Reports** section in the admin panel offers six curated topics (rentals & leasing, fences &
  improvements, assessments & collections, enforcement & fines, meetings & voting, maintenance
  responsibilities) plus a freeform topic box. Each report runs several targeted searches over the
  document library, pools the best excerpts, and streams a structured brief — Summary, What the
  documents say, Where it lives, Ambiguities and conflicts, Gaps — with `[Source N]` citations
  linking back to the tier-checked document downloads. Reports persist to a new `reports` table
  (migration `0008`) as a board-only history with view and delete (with confirmation); a failed or
  disconnected generation saves nothing. Freeform topics are expanded into search queries by a
  small Claude Haiku planning call that degrades gracefully to a single query if it fails.
- New board-only endpoint `POST/GET/DELETE /api/admin/reports` (SSE generation stream, metadata
  list, full detail, delete), fail-closed like the rest of the admin surface.

### Security

- Both AI calls behind report generation — the Haiku query planner and the Claude generation
  pass — receive only pseudonymized text via the same roster-based pseudonymization the document
  assistant uses; server tests assert no real roster values reach either payload. Saved report
  content is de-anonymized (real) text stored in D1 at the same board-only tier as the documents
  it cites.

## [0.3.38] - 2026-07-30

### Changed

- Bumped `@astrojs/cloudflare` from 14.1.6 to 14.1.7, `astro` from 7.1.5 to 7.1.6, and
  `@cloudflare/workers-types` from 5.20260729.1 to 5.20260730.1.

## [0.3.37] - 2026-07-29

### Changed

- Bumped `@astrojs/cloudflare` from 14.1.4 to 14.1.6, `@astrojs/react` from 6.0.1 to 6.0.2,
  `astro` from 7.1.3 to 7.1.5, `@astrojs/check` from 0.9.9 to 0.9.10,
  `@cloudflare/vitest-pool-workers` from 0.18.8 to 0.19.0, `@cloudflare/workers-types` from
  5.20260727.1 to 5.20260729.1, `@napi-rs/canvas` from 1.0.2 to 1.0.3, `@types/node` from 26.1.1
  to 26.1.2, `jsdom` from 30.0.0 to 30.0.1, and `pdfjs-dist` from 6.1.200 to 6.2.108.

## [0.3.36] - 2026-07-27

### Changed

- Bumped `@cloudflare/workers-types` from 4.20260702.1 to 5.20260727.1 (major version update).

## [0.3.35] - 2026-07-27

### Changed

- Bumped `jsdom` from 29.1.1 to 30.0.0 (major version update).

## [0.3.34] - 2026-07-27

### Changed

- Bumped `@anthropic-ai/sdk` from 0.114.0 to 0.115.0.

## [0.3.33] - 2026-07-24

### Changed

- Bumped the transitive `postcss` dependency from 8.5.16 to 8.5.23.

## [0.3.32] - 2026-07-24

### Added

- **Codex now runs this repo's agents and skills, generated from the Claude Code originals.**
  `.claude/agents/` and `.claude/skills/` remain the single source of truth, and
  `npm run agents:sync` renders the mirror Codex actually discovers at
  `.agents/skills/<name>/SKILL.md`. Skills copy verbatim under a provenance banner; subagents are
  re-rendered as skills — Codex has no project-level subagent registry — with the Claude-only
  `tools:`/`model:` frontmatter dropped and a short "delegated role" preamble added. `ship`,
  `code-reviewer`, and `docs-updater` are now reachable under the same names in either CLI. See
  [ADR 0011](docs/adr/0011-claude-sourced-agent-assets-mirrored-for-codex.md).
- **Drift between the source and that mirror is caught automatically.** `npm run agents:check`
  reports the exact missing, stale, extra, or orphaned paths and exits non-zero. It runs in CI on
  every pull request, in `/ship`'s fast checks, and from a `PostToolUse` hook that re-syncs the
  mirror the moment a `.claude/` agent or skill file is written, so an edit in one CLI cannot
  silently leave the other behind.

### Removed

- Deleted the hand-written `.codex/agents/*.toml` files. Codex reads neither `.codex/agents/` nor a
  repo-level `.codex/skills/`, so those files were parity in appearance only.

## [0.3.31] - 2026-07-24

### Changed

- Bumped `@anthropic-ai/sdk` from 0.113.0 to 0.114.0, `better-auth` from 1.6.24 to 1.6.25,
  `better-auth-cloudflare` from 0.3.0 to 0.3.1, and `@cloudflare/vitest-pool-workers` from 0.18.7
  to 0.18.8.

## [0.3.30] - 2026-07-23

### Changed

- Bumped `@anthropic-ai/sdk` from 0.112.5 to 0.113.0 and `better-auth` from 1.6.23 to 1.6.24.

## [0.3.29] - 2026-07-22

### Changed

- Bumped `@testing-library/jest-dom` from 6.9.1 to 7.0.0.

## [0.3.28] - 2026-07-22

### Changed

- Bumped the transitive `svgo` dependency from 4.0.1 to 4.0.2.

## [0.3.27] - 2026-07-22

### Changed

- Bumped the transitive `fast-uri` dependency from 3.1.2 to 3.1.4.

## [0.3.26] - 2026-07-22

### Changed

- Bumped `@anthropic-ai/sdk` from 0.112.4 to 0.112.5, `react` and `react-dom` from 19.2.7 to
  19.2.8, `@cloudflare/vitest-pool-workers` from 0.18.6 to 0.18.7, and `@vitejs/plugin-react` from
  6.0.3 to 6.0.4.

## [0.3.25] - 2026-07-21

### Changed

- Bumped `@anthropic-ai/sdk` from 0.112.1 to 0.112.4, `@astrojs/cloudflare` from 14.1.3 to 14.1.4,
  `astro` from 7.1.1 to 7.1.3, and `prettier` from 3.9.5 to 3.9.6.

## [0.3.24] - 2026-07-17

### Changed

- Bumped `@anthropic-ai/sdk` from 0.111.0 to 0.112.1, `astro` from 7.0.9 to 7.1.1, and
  `@cloudflare/vitest-pool-workers` from 0.18.4 to 0.18.6.

## [0.3.23] - 2026-07-15

### Changed

- Removed the per-turn documentation-freshness Stop hook from `.claude/settings.json`.
  Documentation is now kept current at ship time by the `ship` skill's scoped `docs-updater` pass,
  so routine work no longer triggers an end-of-turn docs check.

## [0.3.22] - 2026-07-15

### Fixed

- **The admin sidebar's "View site" and "Log out" links stay in view on long pages.** The left
  navigation no longer stretches to match tall page content — most noticeable on the Documents
  panel, where reaching the footer actions previously meant scrolling to the very bottom. The
  sidebar is now pinned to the viewport height and scrolls on its own when it can't fit, so its
  footer actions remain visible regardless of how long the main content is.

## [0.3.21] - 2026-07-15

### Added

- **A `ship` skill now takes a finished branch to an open PR.** Running `/ship`
  (`.claude/skills/ship/`) refreshes the docs, writes the CHANGELOG entry for the exact version
  the merge will mint, runs the fast format and type checks, and opens or updates the pull
  request — so the changelog stays in lockstep with the release tags instead of drifting behind
  them.
- **CI now guards the changelog against drift.** A new "Changelog Version" workflow
  (`.github/workflows/changelog.yml`) fails any non-dependabot pull request unless `CHANGELOG.md`
  documents the version that PR's merge will mint. The target version is computed by the new
  `scripts/next-version.sh`, which mirrors the auto-tagging algorithm in `version.yml`. Dependabot
  PRs are exempt; their entries are backfilled by `/ship` on the next human PR.

## [0.3.20] - 2026-07-15

### Changed

- Dependabot pull requests are now labeled by ecosystem (`npm`, `github-actions`).

## [0.3.19] - 2026-07-15

### Changed

- Bumped `actions/setup-node` from 6 to 7 in the CI workflow.

## [0.3.18] - 2026-07-15

### Changed

- Dependabot now checks for updates daily at 05:00 instead of on its previous schedule.

## [0.3.17] - 2026-07-14

### Changed

- Bumped `@astrojs/cloudflare` from 14.1.2 to 14.1.3 and `astro` from 7.0.7 to 7.0.9.

## [0.3.16] - 2026-07-13

### Changed

- Bumped `@anthropic-ai/sdk` from 0.110.0 to 0.111.0.

## [0.3.15] - 2026-07-13

### Added

- **Search the admin document library by name.** The board's Documents panel now has a search box
  that filters the list as you type, matching either the document title or the underlying uploaded
  filename (case-insensitive). It works alongside the existing visibility tabs — searching narrows
  within the selected tier — so finding one document among hundreds no longer means scrolling.

## [0.3.14] - 2026-07-13

### Fixed

- **Scanned PDFs are correctly flagged "Not searchable" again.** Image-only PDF uploads were being
  marked searchable even when no text could be extracted, because the searchability check counted
  the metadata boilerplate that Workers AI wraps around every document. The check now measures only
  the extracted page text, so a scan with no real content is flagged "Not searchable" and becomes
  eligible for the `npm run ocr:scanned` recovery job. Text-native files (`.md`/`.txt`/`.csv`) are
  unaffected, and the stored search copy still keeps the document's metadata for retrieval context.

## [0.3.13] - 2026-07-12

### Added

- **Scanned PDFs can now be made searchable.** A new operator command
  (`npm run ocr:scanned`) OCRs scanned/image-only PDF uploads — which upload fine
  but were flagged "Not searchable" — into the assistant's search index, using
  Cloudflare Workers AI (document content stays within Cloudflare). Results become
  searchable at the next search sync.

## [0.3.12] - 2026-07-12

### Changed

- The assistant's "general knowledge only" empty-retrieval notice now has a distinct tint so it
  stands out from the answer instead of blending in. (Internal: simplified a pseudonymizer dedup
  key; no behavior change.)

## [0.3.11] - 2026-07-12

### Added

- **New document uploads become assistant-searchable automatically.** Uploading a document now
  builds its search index copy (via Cloudflare Workers AI), so board members no longer need an
  operator to re-run the import for a new file to show up in the assistant. Files that can't be
  converted to searchable text (scans or unsupported formats) are marked "Not searchable" in the
  admin Documents panel and still download normally.

## [0.3.10] - 2026-07-12

### Changed

- **Assistant is clearer and more accurate.** When no documents match a question, the answer is now
  flagged as general-knowledge-only; each cited excerpt shows its category and (pseudonymized)
  title; and stale index entries with no matching document are ignored instead of showing an empty
  citation. A "New conversation" button resets the chat.

### Fixed

- **Assistant stops garbling document numbers and words.** The PII pseudonymizer no longer masks
  arbitrary long/bare numbers as phone numbers, and no longer replaces common English words that
  happen to match a resident's name token. Roster phone numbers are still masked in any format, and
  conversation history is fully pseudonymized before any length cap is applied.

### Security

- Document titles sent to the AI provider are now pseudonymized (previously they were withheld);
  roster names, addresses, phones, and emails are still always masked.

## [0.3.9] - 2026-07-12

### Changed

- Documentation and internal tooling only — public docs brought in line with the already-shipped AI
  assistant, a docs-freshness automation fix, and a changelog restructure. No user-facing changes.

## [0.3.8] - 2026-07-12

### Fixed

- **Assistant no longer hangs on a full roster** — the PII pseudonymizer's surrogate name pools
  were finite, so a large enough roster could exhaust them mid-request and spin forever, hanging
  the Worker on every assistant call. Surrogate generation is now injective over an unbounded index
  range (deterministic disambiguation tiers), so it always terminates. Answer generation also gets
  more token headroom so adaptive thinking no longer starves the visible answer, and a cut-off reply
  now shows a visible "cut off by the length limit" notice instead of ending silently.

### Security

- Generated surrogate names are now checked against the roster so a disambiguated placeholder can
  never coincide with a real resident's actual name.

## [0.3.7] - 2026-07-11

### Changed

- **Document search index split from the download library** — the AI assistant now retrieves over
  a dedicated Markdown index (one `rag/<uuid>.md` per document, indexed by Cloudflare AI Search)
  instead of the raw files, so scanned and oversized documents become searchable while citations
  still link to the original human-readable file for download. Deleting or de-duplicating a document
  now also removes its search-index copy. The document library's category list expanded from 5 to 16
  for finer organization.

## [0.3.6] - 2026-07-10

### Changed

- **Hybrid assistant answers** — answers now draw on both the documents and general knowledge,
  clearly labeling which parts come from the documents (cited by `[Source N]`) versus general
  knowledge not found in them.

## [0.3.5] - 2026-07-10

### Fixed

- **Assistant retrieval works in production** — an unexpected Cloudflare AI Search response shape
  returned a production `500` on every question; the response is now normalized so document search
  returns results.

## [0.3.4] - 2026-07-10

### Added

- **Board-only AI document assistant** — ask questions about the document library from the admin
  panel and get streamed answers with per-document citations that link back to the tier-checked
  download (Cloudflare AI Search retrieval + Claude generation).

### Security

- The assistant pseudonymizes known resident PII (current and former owners, best-effort and
  roster-based) before sending document excerpts to Anthropic; document titles are never sent.

## [0.3.3] - 2026-07-10

### Changed

- Internal cleanup of the duplicate-resolution response payload (removed a vestigial `deleteIds`
  field and a stale test payload). No behavior change.

## [0.3.2] - 2026-07-10

### Changed

- Dependency updates (Dependabot: npm minor/patch group).

## [0.3.1] - 2026-07-10

### Changed

- **Duplicate review remembers resolved groups** — resolving duplicates now marks the file(s) a
  board member keeps with a `keep_verified_at`/`keep_verified_by` state, and the admin
  **Duplicates** panel hides any group whose members are all already kept-verified instead of
  re-showing it on every visit. Resolving now takes an explicit list of files to keep alongside
  the files to delete, rather than a single keeper, so a "keep all" action can mark a group
  reviewed without deleting anything. If a later upload is confirmed as a near duplicate of a
  previously-kept file, that file's kept state is cleared so the group resurfaces for review. The
  panel also adds a per-file "View" link and a "kept" badge.

## [0.3.0] - 2026-07-09

### Changed

- **Release-line versioning scheme** — adopted the `<major>.<minor>.<build>` release-line tagging
  used for these releases (the first tag on a line uses the package build value; later merges on the
  same line increment the build segment), replacing the earlier four-part build tags.

## [0.2.2] - 2026-07-09

### Changed

- Dependency updates (Dependabot: npm minor/patch group).

## [0.2.1] - 2026-07-08

### Changed

- Introduced `AGENTS.md` as the canonical contributor/agent guide and pointed the docs and agent
  references at it.

## [0.2.0] - 2026-07-08

Initial public release for the resident-run Valleys at Ashebrook site. This release establishes the
Cloudflare Workers/D1/R2 foundation, homeowner verification, board admin workflows, document
library, security hardening, public documentation cleanup, and the remaining roadmap.

### Added

- **Roadmap, architecture, and ADR docs** — remaining roadmap work now lives in `ROADMAP.md`,
  public architecture is summarized in `docs/architecture.md`, and architecture decision records
  live under `docs/adr/` for durable choices that future roadmap work should preserve.
- **Scheduled verification cleanup** — the Worker now exposes a daily scheduled handler that purges
  old consumed/expired property-verification rows and resolved manual-approval rows through the
  shared cleanup routine.
- **Document deduplication** — documents now store a nullable SHA-256 `content_hash`; board uploads
  block exact duplicates, warn on metadata-only near duplicates with an explicit override, and a new
  admin **Duplicates** panel plus `npm run docs:dedupe` dry-run/commit script help clean up the
  imported archive.
- **Board-editable disclaimer and About copy** — the footer "not affiliated" disclaimer and the
  `/about` page text are now editable from the admin **Site Settings** panel (two new fields on the
  site settings blob — no migration). Left blank, both fall back to the built-in copy, so existing
  deployments render unchanged; changing this text no longer needs a code deploy.
- **Signed-in presence in the header** — the public header now reflects the visitor: anonymous
  users get **Sign in** / **Register** links, a signed-in user without a verified home gets a
  **Verify your property** link, board members get an **Admin** link, and any signed-in user gets a
  **Sign out** control — replacing the single hardcoded "Admin sign in" link. Homeowners no longer
  have to guess the `/login`, `/register`, or `/verify-property` URLs.
- **Tiered content + document library** — site content served from Cloudflare D1 with
  `public | homeowner | board` visibility tiers, document files in R2 behind a tier-checked
  download endpoint, and an import pipeline for the document archive (replacing the earlier
  Firebase/Firestore stack).
- **Identity & roles** — homeowner and board accounts on Better Auth (email/password + admin
  plugin), with possession-based homeowner verification: a one-time code sent to the phone/email
  already on the owner roster (Resend / Twilio), gated by Cloudflare Turnstile. Roles are enforced
  server-side and fail-closed.
- **Resident rebrand + official mode** — the public site is branded "The Valleys at Ashebrook
  Residents", with an admin-toggleable official-mode flag that switches on official-HOA
  presentation (branding, footer disclaimer, HOA-only surfaces such as dues).
- **People-per-home roster** — the flat owner list split into `properties` (homes) and `owners`
  (people), verification matched by home with the code fanned out to all contacts on file, and a
  per-person spreadsheet import.
- **Roster & members admin UI** — board-only Roster (properties/owners CRUD) and Members
  (approval queue / revoke) sections in the admin panel.
- **Board members admin panel** — a board-only **Board members** section that promotes another
  account to `board` and demotes a board member (the last remaining board member can't be demoted),
  making board handoff a supported workflow via direct database writes rather than the Better Auth
  admin API.
- **Admin content management** — announcements, documents, dues, and site settings managed through
  the board-only admin panel.
- **First-board bootstrap endpoint** — a permanent `POST /api/bootstrap/board` creates the very
  first `board` account (which can't be made through the self-service flow), replacing the old
  hand-written temporary-route procedure. It requires a bootstrap secret matched in constant time
  plus first-board account config.
- **SEO basics** — a branded custom 404 page, a `robots.txt` (allowing public content, disallowing
  `/admin` and `/api`), and a `/sitemap.xml` of the public content pages. The sitemap is served by
  a small SSR route rather than `@astrojs/sitemap`, which emits nothing under full-SSR output.

### Changed

- **Public setup vs. private operations docs** — public `SETUP.md` now stays generic and
  resident-run-site focused, while deployment-specific runbooks, roster erasure commands,
  bootstrap details, and backup notes belong under gitignored private operations docs.
- **Release-line tag workflow** — the version workflow now allows the first tag on a release line
  to use the package patch value, so this initial release can be tagged `v0.2.0`; later merges on
  the same line continue as `v0.2.1`, `v0.2.2`, and so on.
- **CI and deployment posture** — the build workflow runs the Worker/D1 integration suite, Vitest
  coverage thresholds are set from the current baseline, CodeQL stays in GitHub default setup, and
  production deploys intentionally remain with Cloudflare Workers Builds rather than a duplicate
  GitHub deploy workflow.
- **Shared admin-manager scaffolding** — the board admin managers (announcements, documents, dues,
  site settings, roster, board members) now share a `useAdminResource` hook for the load / busy /
  status-message boilerplate each was repeating by hand, instead of duplicating the same
  `try/catch/finally` save logic six times. No behavior change.
- **Public content is now server-rendered** — announcements, documents, and dues are read in each
  page's Astro frontmatter (tier-filtered by the visitor's role) and rendered server-side instead of
  fetched client-side into `client:only` islands. The HTML now ships with the real content — better
  SEO, faster first paint, and it works with JavaScript disabled — rather than a "Loading…"
  placeholder. The `/api/content/*` endpoints remain for the admin panel.
- **Database uniqueness + hot-path indexes** — migration `0003` adds a `UNIQUE` index on
  `properties.address_normalized` and on `user_property_links (user_id, property_id)`, plus indexes
  on the roster/verification/content hot-read columns (`owners.property_id`,
  `property_verifications.user_id`, `manual_approval_queue.status`, `documents.visibility`,
  `announcements (visibility, date)`). Creating or renaming a property to a duplicate address now
  returns `409` instead of an opaque `500`, and re-verifying (or re-approving) a home no longer
  accumulates duplicate ownership links.
- **Enabled Workers Logs** — `[observability]` turned on in `wrangler.toml` so production
  invocation logs, console output, and errors are visible from the Cloudflare dashboard. Also
  removed a stray `console.log` from the site-settings read endpoint.
- **Resolve the caller once per request** — API routes now read the auth context the middleware
  already put on `locals` (via a new `resolveAuthContext` helper and a `requireBoard` that takes
  `locals`), instead of each route re-running a full Better Auth session + D1 role/link lookup. A
  fail-closed fallback preserves behavior when `locals` is absent (e.g. direct handler invocation
  in tests).

### Removed

- **Stale public execution docs** — old implementation handoff files and the
  `docs/superpowers/` scratch/spec tree were removed from the public documentation surface after
  preserving durable decisions in ADRs.
- **Stale Firebase `.gitignore` entries** — the project no longer uses Firebase/Firestore, so the
  `.firebase/` and `*firebase*-debug.log` ignore block was dropped. (The `SESSION` KV binding and
  the `requirePropertyAccess` guard were investigated as possible cruft too but both are
  load-bearing — the binding is required by the Cloudflare adapter and the guard backs a planned
  feature — so they were documented in place rather than removed.)

### Fixed

- **Local sign-in works under `npm run dev`** — `http://localhost:4321` is now a trusted Better Auth
  origin, so signing in on the dev server no longer fails with an origin error (the dev server's
  `BETTER_AUTH_URL` points at the production URL, which had left localhost untrusted). Production
  auth is unaffected.
- **Property-verification flow polish** — the single-use Turnstile token is now reset after every
  verification request, so retrying after a rate-limit or error no longer fails with "Bad captcha";
  the one-time code message now names the (masked) requesting account (e.g. `Requested by
j***@gmail.com`) so a recipient can tell a real request from an attacker probing their contact;
  and a successful confirmation shows a success state with a link to the resident documents (a full
  navigation that re-resolves the now-homeowner role).

### Security

- **Roster PII operating stance** — setup/security docs now state where roster data comes from, that
  it is used for owner verification, how removal requests are handled, and how D1 restore/export
  retention works.
- **Verify-request rate limiting** — `POST /api/verify/request` is throttled in KV with a per-user
  cooldown plus daily caps per user and per property; the limit surfaces as a `429` in the verify
  form, curbing abuse of the SMS/email fan-out.
- **Document upload allowlist + canonical content type** — uploads are restricted to an extension
  allowlist and stored with a server-derived content type (HTML and SVG excluded as stored-XSS
  vectors); disallowed types are rejected with `415`.
- **Hardened document downloads** — responses are sent with `nosniff`, forced to `attachment` for
  anything other than PDF, and given a sanitized filename.
- **Baseline security headers** — every response now carries `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and an **enforced**
  Content-Security-Policy. The policy allows exactly the third-party resources the site uses
  (Google Fonts, the Google Calendar embed, Turnstile, Web3Forms) plus the Cloudflare Web Analytics
  beacon that Cloudflare's edge injects, and was flipped from Report-Only to enforced after auditing
  every resource against the directive list.
- **HMAC-keyed, constant-time one-time codes** — verification codes are stored only as keyed
  HMAC-SHA-256 hashes and compared in constant time, so a leaked database backup can't be reversed
  with a precomputed table.
- **Settings validated on write, normalized on read** — dues and site settings are coerced and
  validated so malformed values can't reach rendering.
- **Impersonation/ban/set-role closed to board sessions** — the Better Auth admin-plugin
  capabilities are intentionally not granted; all role changes are direct, board-only database
  writes.
- **Fail-closed first-board bootstrap** — the new `POST /api/bootstrap/board` self-disables the
  moment any board account exists (`410`), so the bootstrap can no longer be a forgotten,
  standing role-escalation route the way the previous hand-added temporary endpoint could. A
  missing `BOOTSTRAP_SECRET` is treated as closed (`403`), never as "unset means open".
- **Public documents read no longer leaks storage metadata** — `GET /api/content/documents` now
  projects only the `DocumentItem` contract (id, title, category, visibility, updatedAt); the
  internal R2 object key, filename, byte size, and content type are no longer sent to callers.
- **Admin write validation** — announcement, property, owner, and document writes now trim, cap
  length, validate enums/dates, drop unknown keys, and reject empty required fields with a `400`
  (instead of persisting coerced, unvalidated strings). Malformed JSON bodies return `400` rather
  than an opaque `500`, the public announcements `limit` is clamped to a non-negative integer (a
  negative value previously dropped items off the end), and the members "approve" action refuses a
  `propertyId` that doesn't exist (`404`) or is inactive (`409`).

[Unreleased]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.15...HEAD
[0.3.15]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.14...v0.3.15
[0.3.14]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.13...v0.3.14
[0.3.13]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.12...v0.3.13
[0.3.12]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.11...v0.3.12
[0.3.11]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.10...v0.3.11
[0.3.10]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.9...v0.3.10
[0.3.9]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/jwh3times/valleys-at-ashebrook-hoa/releases/tag/v0.2.0
