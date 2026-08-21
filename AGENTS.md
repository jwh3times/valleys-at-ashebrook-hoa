# Repository Guidelines

## What This Is

This is the public and homeowner website for the Valleys at Ashebrook neighborhood, branded
**"The Valleys at Ashebrook Residents"**. An admin-toggleable **official mode** switches the site
to official-HOA presentation: branding, footer disclaimer, and HOA-business surfaces like `/dues`
and homeowner proxy grants at `/proxies` are driven by the `officialMode` site setting through
`src/lib/site.ts`. A separate `liveVotingEnabled` site setting supplies the default-off gate for
conducted elections and member-motion voting. The guarded `POST /api/vote`, caller-specific
server read model, atomic casting, and homeowner `/vote` experience are all feature-gated on both
settings. The page offers one-time homeowner submission of ballots for conducted elections and
votes on member motions only to verified callers, with per-lot receipts that never reveal selections.
Conducted-election choices are application-wide undisplayable and irreplaceable; member-motion
votes remain attributable and board-correctable after close. The admin Site, Elections, and
Meetings panels expose the default-off enable/pause control, conducted-election Active/History
lifecycle and turnout monitoring, and member-motion open/close/reopen controls.

The app is an Astro SSR app (`output: 'server'`) running on **Cloudflare Workers** via the
`@astrojs/cloudflare` adapter, backed by Cloudflare **D1** (SQLite via Drizzle ORM), **R2**
(document files), and **KV** (Astro sessions). Auth is **Better Auth** with email/password and the
admin plugin. Homeowner sign-up is verified against the owner roster via a one-time code sent to
the phone or email already on file, using Resend for email and Twilio for SMS, gated by Cloudflare
Turnstile. Board members manage all content through the admin panel at `/admin`. `SETUP.md` is the
human deployment guide.

## Project Structure & Module Organization

Source code lives in `src/`, with pages and API routes in `src/pages/`, shared UI in
`src/components/`, layouts in `src/layouts/`, client helpers in `src/lib/`, and server-only logic
in `src/server/`. Tests live in `test/`, public static assets in `public/`, automation scripts in
`scripts/`, and documentation in `docs/`. The `design/Ashebrook HOA.dc.html` file is a static
design mockup kept as visual reference only; it is not built or imported and should not be edited.
Current roadmap items live in `ROADMAP.md`; durable architecture decisions live in `docs/adr/`.

## Build, Test, and Development Commands

Use the Node version pinned in `.nvmrc` (`nvm use`) before installing dependencies.

```bash
npm run dev               # dev server at http://localhost:4321
npm start                 # same local Astro dev server
npm run build             # SSR build to dist/
npm run check             # TypeScript 7 + Astro type checks
npm run types:worker      # regenerate Cloudflare runtime/binding types
npm run types:worker:check # fail if generated Worker types drifted, enforced by CI
npm test                  # jsdom component/unit tests (Vitest)
npm run test:watch        # Vitest in watch mode
npm run test:server       # Worker/D1 integration tests (vitest-pool-workers)
npm run format            # Prettier write
npm run format:check      # Prettier check, enforced by CI
npm run lint              # type-aware Oxlint correctness and React Hooks checks
npm run lint:fix          # apply Oxlint's safe fixes
npm run sync:agents       # regenerate the Claude skills and Codex agents
npm run sync:agents -- --check # fail if generated agent trees drifted, enforced by CI
npm run lint:coercions    # fail on `Number(x) || <default>`, enforced by CI
npm run db:generate       # generate Drizzle migration files
npm run db:migrate:local  # apply migrations to local D1 with Wrangler
npm run db:migrate:remote # apply migrations to production D1 — the ONLY path; deploys do not run migrations
npm run auth:generate     # regenerate Better Auth schema from config
npm run roster:import     # import owner roster for homeowner verification
npm run docs:import       # generate documents-manifest.json; see SETUP.md
npm run docs:dedupe       # dry-run document duplicate report; see SETUP.md
npm run corpus:import     # clean-replace R2/D1 doc + rag-twin corpus import; see SETUP.md §7
npm run ocr:scanned       # OCR scanned/"unsupported" PDF uploads into search twins; see SETUP.md
npm run verify:invariants # ADR 0022 migration invariant gate; pass --local or --remote
npm run roster:backfill   # ADR 0022 roster backfill; dry-run by default, --write --operator=<id>, --classify=<id>=technical
npm run shadow:sweep      # ADR 0022 offline shadow sweep over every account; --local/--remote, --write
npm run deploy            # build and deploy with Wrangler
```

`npm install` also runs the root `postinstall`, which installs the locked TypeScript 6 Astro
checker under `vendor/astro-check-ts6/`. The root compiler remains TypeScript 7; `npm run check`
generates Astro's project types, runs the root compiler over **both** TypeScript programs, then
uses that isolated checker only for `.astro` diagnostics until Astro supports the TypeScript 7
programmatic API.

There are two programs on purpose. `tsconfig.json` covers the Astro/Workers app — `src/` and the
Workers-pool tests in `test/server/` — while `tsconfig.node.json` covers the code that never runs on
Workers (`scripts/`, the jsdom/node tests in `test/unit/`, and the root config files). Each config
excludes what the other includes; adding a new Node-side path means adding it to both.
`worker-configuration.d.ts` supplies both programs with compatibility-date-aligned Cloudflare
runtime and binding types generated from `wrangler.toml` and `.env.example`; `src/ambient.d.ts`
augments the generated `Env` with secrets and test-only bindings. Run `npm run types:worker` after
changing either configuration source. CI runs `npm run types:worker:check` so generated-type drift
cannot merge.

Run a single test file or test name with:

```bash
npx vitest run test/unit/example.test.ts
npx vitest run -t "shows an empty message"
npx vitest run --config vitest.workers.config.ts test/server/api.test.ts
```

CI (`.github/workflows/build.yml`) runs `types:worker:check`, `format:check`, `lint`,
`sync:agents -- --check`, `lint:coercions`, `check`, `test`, `test:server`, then `build` on every PR
and push to `main`; run the relevant checks locally before pushing. On every
merge to `main`, the Version workflow (`.github/workflows/version.yml`) tags the merge commit and
creates a GitHub release using the `package.json` major/minor release line. The project uses the
third semver segment as a build number (`<major>.<minor>.<build>`). The first tag for a new line
uses the package build value (`0.2.0` -> `v0.2.0`); later merges on the same line increment the
build tag (`v0.2.1`, `v0.2.2`, ...). When bumping major or minor, `x.y.0` remains valid and is not
incremented to `x.y.1` unless an `x.y.0` tag already exists.

The Changelog Version workflow (`.github/workflows/changelog.yml`) runs on every non-dependabot PR
and fails it unless `CHANGELOG.md` documents the version that PR's merge will mint.
`scripts/next-version.sh` predicts that version by mirroring the Version workflow's tag algorithm,
and the `/ship` skill (`.claude/skills/ship/`) classifies the branch's project-level release impact
as major, minor, or build before writing the matching changelog section. For a major or minor
classification it idempotently updates `package.json` and `package-lock.json` from the merge-base
release line; a build classification leaves the package version unchanged. Dependabot PRs are
exempt; their entries are backfilled by `/ship` on the next human PR.

## Coding Style & Naming Conventions

Use TypeScript and Astro conventions already present in the repo. Follow the existing Prettier
settings, keep indentation consistent with the file's current style, and prefer descriptive names
over abbreviations. Use `*.test.ts` and `*.test.tsx` for tests. Keep server-only code in
`src/server/` and avoid importing it into client-side modules.

**Never default a coerced numeric form value with `||`.** `Number('')` and `Number('0')` are both
`0`, so `Number(x) || 1` cannot tell a blank field from a typed zero and silently substitutes the
default — and because the substitution happens before the request is sent, the server never sees
the `0` to reject it. Check for blank first:

```ts
const raw = form.field.trim();
const value = raw === '' ? undefined : Number(raw);
```

This has bitten twice — a lot's `vote_weight` set to 1 when the board typed 0, and a candidate's
tally recorded as a real 0 when the field was left blank, destroying the `NULL` ("not recorded")
vs `0` ("recorded as zero") distinction. `npm run lint:coercions` fails CI on the pattern; a
deliberate case needs a trailing `coercion-ok` comment with a reason. It catches the shape, not
every way blank can be conflated with zero.

## Architecture

**Rendering model.** Pages are `.astro` files in `src/pages/`. The site is full SSR. Public content
(announcements, documents, dues, the meeting record, the resolutions book, the elections record) is
read server-side in each page's frontmatter via `fetchAnnouncementsFor`, `fetchDocumentsFor`,
`getDuesSettings`, `fetchMeetingsFor`/`fetchMeetingFor`, `fetchResolutionsFor`, or
`fetchElectionsFor`, using the role from
`Astro.locals.authContext`, then passed as props to display
components. Those components render server-side without client directives so HTML ships with real
content for SEO, first paint, and no-JS behavior. When `fetchMeetingFor` returns `null` for a draft
or out-of-tier meeting, `/meetings/[id]` renders the generic 404, never a 403, so the response
doesn't confirm such a record exists. Same-origin API endpoints under `src/pages/api/` back the
admin panel and any client refresh. Runtime bindings and secrets are read via
`import { env } from 'cloudflare:workers'`. Build-time `PUBLIC_*` vars are inlined by Astro from
`.env`.

**Cloudflare bindings.** `wrangler.toml` defines `DATABASE` (D1), `KV` (app KV), `SESSION` (KV for
Astro sessions), `DOCS` (R2 document storage), and `AI` (Workers AI / AI Search binding). `SESSION`
is required by the `@astrojs/cloudflare` adapter, which enables Astro sessions against that binding
by default even though app auth uses Better Auth's D1 sessions rather than `Astro.session`. `AI`
backs the admin document assistant's retrieval via `env.AI.autorag(...)`, pointed at the
`AI_SEARCH_INSTANCE` var; answer generation additionally requires the `ANTHROPIC_API_KEY` secret.
The AI Search instance's R2 data source is scoped to the `rag/` folder only, so it indexes the
Markdown twins described below and never the human-readable originals.

**HTTP endpoints.** API routes live under `src/pages/api/`:

- Public tier-filtered reads: `GET /api/content/{announcements,documents,dues,site}`.
- Gated document download from R2 with tier checks: `GET /api/files/[id]`.
- Default-off live homeowner voting: `POST /api/vote` accepts `castBallot` and `castMotionVote`
  only; there is no GET voting endpoint. Middleware is the namespace backstop and the handler calls
  `requireVotingApi` independently. Its fixed guard order is: literal-boolean `officialMode` plus
  `liveVotingEnabled` (`404`), the operator-only write freeze (`503`, see
  `src/server/authz/write-freeze.ts` below), exact equality of the required `Origin` header with
  `new URL(request.url).origin` (`403`), `application/json` media type (`415`), authenticated
  session (`401`), then `homeowner`-or-higher role (`403`). Only then are the action and resource
  resolved. Out-of-tier or unknown occasions are masked as `404`; own-lot or occasion-scoped
  held-proxy authority — a held-proxy cast also re-checks that the proxy's grantor still holds Lot
  Authority over the lot (the ADR 0022 phase 3d grantor re-validation, #220/#204, asked of the
  party roster since #248 part 2, and exact at-the-occasion semantics for a live cast) — frozen-snapshot eligibility and weight, open state, both
  feature flags, and
  one cast per lot are re-checked inside the mutation SQL. Election turnout and identity-unlinked
  retained choices are a single checked D1 batch, and a race with close, pause, authority change,
  or another cast returns `409` without a partial write. Conducted ballots are final: supported
  reads expose only `hasCast`, never choices for display or replacement. Turning either flag off
  pauses new opens and casts without deleting lifecycle state, snapshots, turnout, votes, or
  choices; an occasion still open resumes when both flags return true.
- Board-only writes: `/api/admin/{documents,announcements,dues,site}` and
  `/api/admin/{properties,owners,members}`. `/api/admin/board-people` and
  `/api/admin/board-terms` were **retired by phase 3b (#218), not ported**: the identity layer
  moved to the party roster and `board_service_terms` (see the ADR 0022 roster routes below), and
  porting the legacy routes would have kept two identity layers alive. The legacy `board_people`
  table itself survives — `board_terms.person_id` still references it — but #248 (part 1 of 2, an
  ADR 0022 phase 4 precondition) repointed the meeting and elections records off it onto the party
  roster (migration `0028`), so
  the record-keeping pickers (attendance, mover/second, roll call, the candidate link) now read a
  flat `{id, fullName}` list of `people` — excluding consolidated parties, names rendered through
  `personDisplayLabel` — from `GET /api/admin/meetings?roster=people` instead. The legacy "The
  Board" editor stayed retired; the writable board-service surface is now the phase-3e (#221)
  **Board** panel (`BoardServicePanel`), which writes `board_service_terms`/
  `board_office_assignments` through `/api/admin/board-service` (see the ADR 0022 roster routes
  below), not the legacy `board_people`/`board_terms` tables.
  `POST /api/admin/documents` hashes uploads, blocks exact duplicates, warns on near duplicates,
  and stores `content_hash` on success; a confirmed near-duplicate upload also clears
  `keep_verified_at`/`keep_verified_by` on the existing documents it near-matches, so that
  duplicate group resurfaces for review.
- Board-only meeting record (board and member meetings — proxies recorded by the board or granted
  online by a homeowner attach to member attendance/votes and election ballots):
  `/api/admin/meetings` supports `GET`/`POST`/`PATCH`/`DELETE`.
  `GET` lists every
  meeting including drafts, or returns one full meeting detail with `?id=`; `POST`
  creates a meeting, or with `{ action: 'setAttendance' }` fully replaces a board meeting's
  per-person attendance roll, or with `{ action: 'setMemberAttendance' }` fully replaces a member
  meeting's per-property attendance roll, or with `{ action: 'approve' }`/`{ action: 'unapprove' }`
  flips `status` (`approve` returns `400` if `approvedByMotionId` names no motion — a motion from a
  different, normally following meeting is valid — and `409` if already approved or if a child
  motion vote is open, with the open-vote check in the conditional status update so approval
  cannot win that race;
  `unapprove` clears `approved_at`/`approved_by`/`approved_by_motion_id`); `PATCH` updates a meeting's fields but
  cannot write `status`; `DELETE` returns `409` on an approved meeting (unapprove first), `409` if
  any motion belonging to it is cited as a resolution's adopting motion (see the resolutions
  bullet below), `409` if an election records it as where it was held (see the elections bullet
  below), `409` if an election ballot cites a proxy scoped to this meeting (closes a raw-D1-error
  path that opens once an election's `meetingId` is detached from a meeting after ballots were
  recorded against a meeting-scoped proxy — the meeting-still-linked check above can't catch that
  case), and `409` if any child motion has a live-voting state or eligibility snapshot, otherwise
  cascading its attendance, motions, votes, and proxies. `/api/admin/motions`
  supports `POST`/`PATCH`/`DELETE`. `POST` creates a motion with a server-assigned `sequence`
  (unique per meeting), or with `{ action: 'setVotes' }` fully replaces a board motion's roll-call
  vote set, or with `{ action: 'setMemberVotes' }` fully replaces a member motion's per-property
  vote set, or with `{ action: 'openVoting' }`/`{ action: 'closeVoting' }` moves a member motion's
  live-voting state. First open requires both official mode and the default-false live-voting flag
  to be literal JSON booleans `true`, a draft member meeting, no pre-entered member votes, and at
  least one active property; it
  atomically freezes every active property's weight in `motion_eligibility`. Close is reversible
  while the meeting stays draft, and reopen retains the original eligibility snapshot and any live
  votes. `setMemberVotes` returns `409` while open; after first open it stamps weights from the
  immutable snapshot and performs the full replacement as a state-plus-`voting_revision`
  compare-and-swap in one D1 batch, so a stale correction cannot overwrite an intervening session.
  `PATCH` cannot edit a motion while open or change its text after first open; `DELETE` returns `409`
  if the motion is cited as a resolution's adopting motion or has any live-voting history,
  otherwise cascading its votes. `setAttendance`/`setMemberAttendance` and board `setVotes` each
  replace their full child set in one `db.batch()`. All four attendance/vote actions return
  `409` if the target meeting's or motion's `body` doesn't match the action — board attendance/votes
  against a member meeting/motion, or vice versa, are refused; `setMemberVotes` also returns `400`
  for an unknown `propertyId`, since it stamps `memberVotes.weight` from `properties.vote_weight` at
  recording time and must resolve that weight to build a legal row. `setMemberAttendance`,
  `setMemberVotes`, and (on `/api/admin/elections`) `setBallots` each take a per-entry `proxyId`
  instead of the old `viaProxy` boolean; every referenced proxy is checked by the shared
  `proxyUseError` guard (`src/server/content/proxy-guards.ts`) — unknown `proxyId` is `400`, a proxy
  for a different lot or scoped to a different occasion is `409` (a meeting-scoped proxy also
  covers an election held at that meeting; a standalone election accepts only its own), a proxy
  whose grantor does not currently hold Lot Authority over the proxy's lot is `409` (the ADR 0022
  phase 3d grantor re-validation, #220/#204 — still a current-day approximation of "held Lot
  Authority at the occasion", but asked of the party roster since #248 part 2 rather than of
  `owners.status`; see the module comment) — and an entry carrying both `proxyId` and
  `representedByPersonId`/`castByPersonId` is `400`, since who acted
  lives on the canonical proxy row, never beside it. All verbs on both routes are
  `requireBoard`-gated.
- Board-only resolutions book (standing rules the board adopts; a durable record — amending one
  creates a **new** resolution that supersedes the old, forming a walkable chain; see
  [ADR 0016](./docs/adr/0016-resolutions-supersession-chain.md)): `/api/admin/resolutions` supports
  `GET`/`POST`/`PATCH`/`DELETE`, all `requireBoard`-gated. `GET` lists every resolution including
  drafts, with no tier filter. `POST` creates a `draft` (`201 { id }`); with
  `{ action: 'adopt', id, effectiveDate, motionId? }` moves a `draft` to `in_force` with a
  mutation-boundary status compare-and-swap; with
  `{ action: 'supersede', id, supersedesId, effectiveDate, motionId? }` puts the (draft) resolution
  `id` in force and marks `supersedesId` `superseded` in one D1 batch that atomically re-checks the
  successor is still a draft, the predecessor is still in force, and no other successor exists.
  Concurrent losers return `409` without a partial transition; with
  `{ action: 'repeal', id }` moves an `in_force` resolution to `repealed`, leaving every
  `supersedes_id` link intact. `effectiveDate` is required by `adopt` and `supersede` and validated
  as a real calendar date (`400` on malformed). `PATCH` edits only `number`/`title`/`body_md`/
  `effective_date`/`visibility` — `status`, `supersedesId`, and `adoptedByMotionId` are
  transition-only and rejected on key presence by `normalizeResolutionInput`, so a chain invariant
  can never be bypassed through a plain field write; `PATCH` also returns `409` if it would clear
  `effective_date` on a non-draft resolution. `DELETE` removes only a `draft` that nothing
  supersedes.
- Board-only elections record (recorded paper elections plus the default-off conducted-election
  lifecycle foundation; see [ADR 0017](./docs/adr/0017-elections-secret-by-construction.md) and
  [ADR 0020](./docs/adr/0020-digital-ballot-box.md)): `/api/admin/elections` supports
  `GET`/`POST`/`PATCH`/`DELETE`, plus actions `open`, `close`, `void`, `setTallies`, `setBallots`,
  `certify`, and `uncertify`, all `requireBoard`-gated. `GET` returns every election including
  drafts and open elections, each with its candidates, turnout, and frozen/current eligibility
  totals nested and, board-only, its per-lot eligibility and ballot lists — the same
  full-detail-on-list shape as `/api/admin/resolutions`. `POST` creates a `draft` election with
  create-immutable `source: 'recorded' | 'conducted'`; `PATCH` edits
  `title`/`seats`/`electionDate`/`meetingId`/`visibility` only — `status`, `source`, and
  certification provenance are transition-only and rejected on key presence by
  `normalizeElectionInput`, and every conducted-election field is frozen after first open.
  `open` accepts only a public- or homeowner-visible conducted draft with at least one
  non-withdrawn candidate
  and one active property while both official mode and the live-voting flag are true; in one D1
  batch it freezes every active property and weight in `election_eligibility` and moves the
  election to `open`. A recorded `close` retains its existing `draft -> closed` transition; a
  conducted close accepts only `open`, atomically moves to `closed`, and derives every candidate's
  final `votes = SUM(ballot_choices.weight)`, using a real zero when no choice row exists. No
  conducted tally is populated or exposed while open, and a closed conducted election cannot
  reopen. `setTallies` and `setBallots` each fully replace their election's candidate-tally set or
  per-lot ballot set in one `db.batch()` (a candidate omitted from `setTallies` has its tally
  restored to `NULL`), and both return `409` for a `certified`/`void` election and for every
  non-`recorded` election. Each replacement reserves the election inside that same D1 batch, so a
  competing certification or void that wins first leaves the existing tallies/ballots intact and
  makes the replacement return `409`. `setBallots` stamps `weight` from
  `properties.vote_weight` unless explicitly supplied, and each entry's `proxyId` goes through the
  same `proxyUseError` guard described in the meetings bullet above, scoped to `{ electionId,
meetingId: election.meetingId }` so a proxy signed for the election's own meeting also covers it.
  `certify` (reworked by phase 3b, #218, per #203) takes per-winner
  `{candidateId, personId?, qualifyingLotId, startDay, scheduledEndDay, office?}` and, in one
  reserved `db.batch()`, creates PARTY-ROSTER facts: a `board_service_terms` row per winner
  carrying `election_id`, validated in conditional SQL against the winner's qualifying basis
  (`qualifiesGuard` — the person currently owns or represents the lot) and both non-overlap
  directions, plus an optional `board_office_assignments` row; `candidates.won` is set and the
  election moves to `certified`. It writes NO legacy `board_people`/`board_terms` rows, backfills
  no `candidates.person_id`, and creates NO Access Grant — Board Access is never implicit.
  A winner qualifying nowhere is a hard `409` naming them (the escape is recording the Ownership
  or Representation first), and per-winner `assertInBatch` guards make the whole certification
  roll back rather than commit with a term or an explicitly requested office missing.
  `uncertify` VOIDS the terms it created rather than deleting them — the round-trip leaves
  visible voided facts — voids their office assignments, ends any Board grants they qualified
  (`recorded_in_error`), clears `won`, and returns the election to `closed`; an election
  certified under the retired legacy model simply has nothing to void. `DELETE` removes only a
  `draft` election; a `certified` election cannot be voided directly (`void` returns `409` —
  uncertify first). `/api/admin/candidates`
  supports `POST`/`PATCH`/`DELETE`, `requireBoard`-gated; `sequence` is server-assigned, candidates
  can be added or deleted only while the election is a draft, and conducted candidates become
  immutable after open except that a not-yet-withdrawn candidate may be withdrawn once while open.
  An optional `personId` links a candidate to a party-roster Person — repointed from the retired
  `board_people`/`board_person_id` identity by #248 — and is pre-checked against `people` (rejecting
  an unknown id or one whose Party is consolidated with a readable `400`) before it can reach the
  FK, the same avoid-a-raw-D1-error pattern `setBallots`'s `castByPersonId` check uses.
  The homeowner cast path is `POST /api/vote`, reached only through the feature-gated `/vote` page
  for verified callers. The page renders selection-free receipts that contain only the item title
  and lot address. Its labeled review modal summarizes the pending selection and provenance, moves
  and traps focus, supports Escape/cancel with focus restoration, and disables every background
  voting control. The admin Elections panel separates draft/open Active records from
  closed/certified/void History, exposes conducted Open/Close and count/weight turnout monitoring,
  and never exposes a live conducted tally or editable conducted ballot/choice rows.
- Board-only complete proxies record (including paper proxies entered by the board and online
  grants created by homeowners — one Person authorising one named holder to act for one lot at
  exactly one meeting or election; see
  [ADR 0018](./docs/adr/0018-proxies-record-via-proxy-consolidation.md)): `/api/admin/proxies`
  supports `GET`/`POST`/`PATCH`/`DELETE`, all `requireBoard`-gated. `GET` returns every proxy with
  its property address and grantor/holder names resolved — the same full-detail-on-list shape as
  `/api/admin/resolutions` and `/api/admin/elections`; the member sibling described below is
  lot-scoped rather than a complete register. `POST` returns `201 { id }` with a readable `404` for
  each of the five FKs it
  can write (`propertyId`, `grantorPersonId`, `holderPersonId`, `meetingId`, `electionId`), `400` if
  the grantor has NEVER held Lot Authority over the given property — deliberately the weaker of the
  two questions `roster/authority.ts` answers, since a proxy signed before a sale is a real record
  the board must be able to enter; `proxyUseError` is what refuses that proxy at every USE, so
  entering it is allowed and using it is not (ADR 0018's model, preserved by #248 part 2 rather
  than tightened) — `400` if grantor and holder resolve to the same person,
  `409` if `meetingId` resolves to a board-body meeting ("Proxies apply to member meetings —
  this is a board meeting" — proxies are cited only by member attendance/votes/ballots, so a
  board-meeting proxy could never be used; election occasions are unaffected), and `409` on a
  duplicate occasion (`proxies_property_meeting_unq`/`proxies_property_election_unq`, "This lot
  already has a proxy for this occasion"). `PATCH`
  allow-lists `holderName`/`holderPersonId`/`grantorPersonId` — `propertyId`, `meetingId`, and
  `electionId` are rejected on key presence by `normalizeProxyInput`, since moving a proxy to
  another lot or occasion is a different proxy, not an edit — and re-checks grantor-≠-holder against
  the effective stored-plus-payload values. `DELETE` returns `409` naming which of `attendance`,
  `votes`, or `ballots` still cites the proxy ("Proxy is in use (…) — remove those records first"),
  else deletes; deletion is the entire revocation model, there is no `revoked_at`.
- Official-mode homeowner proxies: `/api/member/proxies` supports `GET`/`POST`/`DELETE`, and
  `/api/member/owner-lookup` supports `POST`. Every handler calls `requireMemberApi`, while
  middleware independently gates `/api/member/*`: `officialMode` off returns `404`, then anonymous
  is `401` and callers below `homeowner` are `403`; board callers pass the rank check. `GET` returns
  only proxies granted for the caller's verified lots plus proxies naming a Person with authority
  over one of those lots as holder. Own-lot rows retain occasion title/date even above the caller's
  tier; held rows for another lot redact those fields above tier. `POST` requires one
  caller-controlled lot, a Person currently holding Lot Authority there as grantor, a different
  Person holding authority somewhere as holder, and exactly one
  visible upcoming member meeting or non-terminal election. Both the picker read and write path
  expose only minimal scheduled-occasion metadata at the occasion's visibility tier even while its
  record remains draft; dates use the `America/New_York` association day. `DELETE` is limited to
  the caller's lots and refuses both past occasions and proxies already cited by attendance, votes,
  or ballots. The address lookup resolves one typed active-property address to the names and opaque
  IDs of the Persons who may act for it (never contact data) — repointed from the lot's active
  `owners` rows by #248 part 2, which also makes an Organization's Representative nameable where
  the legacy shape could only offer the entity; the route keeps its `owner-lookup` path, since #248
  changed what it reads rather than where it lives. Verified homeowners can repeat such lookups, an
  accepted disclosure documented with the lot-control/self-asserted-owner trust model in
  [ADR 0019](./docs/adr/0019-homeowner-writes-official-mode-gate.md).
- Board-only duplicate review: `GET /api/admin/duplicates` lazy-backfills document hashes from R2
  and returns exact or near groups, each member annotated with a `verifiedAt` timestamp; groups
  where every member is already kept-verified are hidden until a matching upload resets one.
  `POST /api/admin/duplicates` takes `{ action: 'resolve', keepIds, deleteIds }`, deletes each
  `deleteIds` document (D1 row + R2 object), and marks the surviving `keepIds` as kept-verified;
  `keepIds` must be non-empty and disjoint from `deleteIds`, while `deleteIds` may be empty for a
  keep-all/mark-reviewed resolution.
- Board handoff, re-pointed by ADR 0022 phase 3e (#221) onto the same `cutover_mode` branch
  `/api/verify/*` established: `GET /api/admin/roles` lists current board; `POST /api/admin/roles`
  accepts `{ action: 'promote', email }` or `{ action: 'demote', userId }`. Under `legacy` both
  actions write `users.role` exactly as before — `demote`'s last-board-member count-then-update race
  is now closed by folding the live-board-count check into the update's own `WHERE` (a lost race
  answers `409` rather than emptying the board), and the historical `409` for demoting anyone while
  only one board member remains is preserved bit-for-bit. Under `derived`, `promote` instead walks
  account → Person Link → a current-or-scheduled Board Term and creates a `board` Access Grant plus
  a `users.role` write-behind mirror in one batch (readable `404`/`409` naming whichever link is
  missing or already granted), and `demote` ends every live Board grant the account holds, refusing
  (`409`) if that would leave no other account holding Board Access, then mirrors the role the
  account derives to afterward — `homeowner` if Lot Authority survives, `visitor` otherwise, `board`
  if a live `system_admin` grant remains. The shared builders (`grantStatements`,
  `endBoardGrantsStatements`, and the chain/mirror reads) live in the new
  `src/server/roster/access.ts`, called by both this route and `/api/admin/access-grants` so the two
  surfaces can never write different grants.
- Member revocation, also re-pointed by phase 3e: `GET`/`POST /api/admin/members` lists recently
  verified homeowners plus the legacy manual-approval queue (write-dead since v0.10.0 — nothing
  enqueues to it in either cutover mode; its `approve`/`deny` actions stay legacy-queue-only and
  unbranched). `POST { action: 'revoke', userId }` ends a homeowner's access: under `legacy` it
  clears `users.role` to `visitor` and deletes the account's `user_property_links`, refusing (`409`)
  a current board member exactly as before; under `derived` it ends the account's Person Link via
  the shared `endLinkStatements` (reason `no_longer_qualifies`), writing the same
  `users.role`/`user_property_links` mirrors in the same batch, and decides the board-member
  refusal from live Board grants — never from the mirror it is itself writing.
- ADR 0022 phase 2 roster preview, `requireBoard`-gated and read-only:
  `GET /api/admin/roster-preview` returns structural counts (IDs and non-personal fields only, not
  a roster browser) across five sections — Roster, Board, Access, Review, Compliance — including
  the two ADR 0022 integrity views and shadow-mismatch counts. It is not a public or homeowner
  surface and does not affect authorization. Its phase-2 admin panel (`RosterPreview`) was retired
  by phase 3e in favor of the five writable panels below; this route and its structural-count shape
  are unchanged.
- ADR 0022 phase 3b roster, board-service, and access routes (#218; decided by #202/#203/#205 —
  read those resolution comments before touching any of this). Every mutation here is ONE D1 batch
  of conditional statements — domain writes first, then the immutable-ledger rows built by
  `src/server/roster/audit.ts`'s `AuditCorrelation` (one command = one correlation; root event
  seq 0 with a unique `operation_key`; consequences name the root as cause), every statement gated
  so a lost race leaves ZERO rows anywhere, with `meta.changes` on the primary deciding the `409`.
  Since the phase 3f flip these routes write the roster production actually runs on, and the
  authoritative backfill that seeded it is insert-once, so the clean-replace mode that once could
  have erased their rows is permanently retired. The surfaces, all `requireBoard`-gated unless
  noted:
  - `/api/admin/board-service` — `GET` (terms + offices + live-derived composition advisories:
    below-three/above-five, vacant offices, expiring and lapsed terms) and a `POST` action bus
    with NO `PATCH`: `createTerm`, `endTerm`, `cancelTerm`, `voidTerm` (the three disjoint ending
    kinds), `substituteQualifyingLot` (in-place, three typed subjects), `correctTerm`,
    `assignOffice`, `endOffice`, `voidOffice`. Interval non-overlap per Person AND per qualifying
    Lot is conditional SQL at the mutation boundary (`noOverlapGuard`), proven under interleaving;
    ending a term ends its current offices and its Board grants (the grant always at recorded-at).
  - `/api/admin/access-grants` — `grant`/`revoke` for both grant types. Board callers act on
    `board` grants (their own included); `system_admin` grants take a System Administrator. The
    last-System-Administrator invariant lives on exactly this route as a mutation-boundary guard
    (never in evaluation), re-checked inside the batch so concurrent revokes cannot empty the set,
    and a refused attempt is permanently recorded as a denied Access Event. Grants validate the
    account→Person-Link→term chain and are created only through this route's explicit `grant`
    action or, as of phase 3e (#221), the board-handoff `/api/admin/roles` `promote` action under
    `derived` — both call the same `grantStatements` builder in `src/server/roster/access.ts` —
    never implicitly by anything else.
  - Roster: `GET /api/admin/roster` (full-detail Roster surface with the live Ownerless-Lot
    advisory; single-record reads never write the ledger) plus per-entity `POST` action buses —
    `/api/admin/roster-lots` (`retire` — ends current Ownerships as caused Roster Changes,
    dual-writes legacy `properties.status`, refuses over a live qualifying term or an open frozen
    snapshot; `correctRetirement` restores the Lot but never the ownerships), `/api/admin/
roster-parties` (`createPerson`/`createOrganization` — party+subtype in one batch, org name
    collisions warn rather than merge; name corrections; `consolidate` with an explicit survivor,
    same-kind/one-hop/both-linked refusals; `correctConsolidation` clears the pointer),
    `/api/admin/roster-ownerships` (`create` — no anticipated start OR end; `end` — backdated
    end day allowed, with optional per-affected-term `substitutions` else terminate-by-default via
    `src/server/roster/board-consequences.ts`, then the phase 3d transfer-effects engine below;
    `void` — no vote reset, supersede-on-void of that Ownership's own open flags),
    `/api/admin/roster-representations`
    (`create` — scope XOR, scoped lots must be currently org-owned, end day MAY be future; `end`;
    `void`; `correctScope` — scope rows void, never delete; `end`/`void`/`correctScope` each also
    run the phase 3d transfer-effects engine, discovery-only), and `/api/admin/
roster-contact-methods` (`add`/`end`/`void`/`setPreferred`; values normalize on write and
    reach the ledger as sensitive-field CATEGORIES only).
  - `POST /api/admin/roster-export` — the bulk export, deliberately a mutating verb: it is the one
    read that is also a recorded act, writing an `access` ledger event (`roster_export`) BEFORE
    any data leaves and failing closed (500, no export) if the record cannot be written. Nothing
    is persisted server-side.
  - `GET`+`POST /api/admin/correction-requests` — the board review queue for member correction
    requests; `accept` applies the fact as an ordinary Roster Change citing the request id as
    opaque evidence (`evidence_request_id`); `decline` writes no ledger row.
  - The three System-Administrator-only surfaces, gated by `requireApiCapability` on the four
    technical capabilities (#205/#217): `/api/admin/redactions` (`redactPersonName`/
    `redactContactMethod` under `redactionAuthorize` — value and marker nulled together, at least
    one `redaction_tasks` row always created so the integrity view holds; `recordCleanup` under
    `redactionCleanup`, operational only), `GET /api/admin/access-denials`
    (`accessDenialDetail`), and `GET /api/admin/audit-integrity` (`auditIntegrityViews`). These
    capabilities come only with a live `system_admin` grant, so under `derived` they answer only
    the System Administrator (one exists since the phase 3f bootstrap) and 403 everyone else; if
    the flag were ever written back to `legacy`, nobody holds them and all three answer 403 for
    every caller — by design.
  - Member correction requests: `GET /api/member/roster-self` (own Person, Contact Methods,
    Ownerships, Representations, open requests — never the ledger, never another party's data)
    and `GET`/`POST`/`DELETE /api/member/correction-requests` (own name and own Contact Methods
    only; requests are operational rows whose free text NEVER enters the ledger; withdrawal and
    out-of-scope ids mask as `404`). Both use `requireMemberApi` and then answer the deliberate
    no-Person-Link `403` pointing at verification — under `derived` that is any caller whose
    account has not been linked to a Person; under `legacy`, which has no Person concept, it is
    every caller.
- ADR 0022 phase 3c Person Verification / Person Link routes (#219; decided by #201, amended by
  #202). `/api/verify/{request,confirm}` are now ONE route contract answered by TWO backends
  branched on `getCutoverMode`: `legacy` keeps the existing property flow (address match,
  owner-contact fan-out, `property_verifications`, confirm writes `user_property_links` and
  promotes role); `derived` runs the new Person flow entirely in `src/server/roster/verification.ts`.
  `POST /api/verify/request` takes `{ address, name, channel, turnstileToken }` in both modes;
  after the write freeze, session, malformed-body, channel, and Turnstile gates — none of which
  touch the roster — EVERY remaining outcome (success, unknown address, unmatched or ambiguous
  name, an organization-owned lot, a shared/unattributable contact, both already-linked
  collisions, and every rate limit) converges on the same byte-identical
  `200 { ok: true, message: 'If the information matches our records, a code has been sent.' }`;
  there is no more `queued`/`rateLimited` distinction and no `429` on this route. Under `derived`,
  the matcher (`matchPersonForVerification`) resolves the claimed Lot, filters current Person
  owners (never Organizations — the join through `people` excludes them structurally), applies a
  two-tier name match (exact normalized full match; if zero, a first-and-last-token match; either
  tier requires exactly one candidate), then picks the matched Person's current contact on the
  chosen channel that is ALSO uniquely attributable roster-wide (`(channel, value_normalized)`
  resolves to exactly one Party), and sends exactly one code to that contact — never a fan-out. A
  Person already linked to a different account auto-creates a `verification_review_requests` row
  (`internal_reason='person_already_linked'`) and sends nothing; the caller's own account already
  being linked sends nothing and creates nothing. `POST /api/verify/confirm` collapses every
  internal failure (wrong code, expired, locked, or a batch race) into
  `{ ok: false, reason: 'mismatch' }` except `expired`/`locked`, which keep their own reason; on a
  `derived` success it writes, in one D1 batch, `person_verifications`
  (`method='otp_email'|'otp_sms'`), `person_links`, a root `identity`-family ledger event
  (`person_verified`, reason `automatic_contact_proof`), and two write-behind mirrors (never read
  for authorization) that insert `user_property_links` and promote `users.role` from `visitor` to
  `homeowner` — kept only so the legacy read model and Better Auth session stay coherent through
  the flip. Neither backend auto-queues to `manual_approval_queue` anymore — the three legacy
  auto-enqueue paths (address not found, no contact on file, every send failed) were removed;
  `POST /api/verify/review` is the one explicit applicant action that queues review (session-gated,
  no Turnstile — the one-open-request-per-account partial unique index is the flooding control),
  writing `verification_review_requests` identically in both modes and always answering the
  uniform `200 { ok: true, message: 'Your request was sent to the board.' }`.
  `POST /api/verify/unlink` is the applicant's always-available self-unlink — deliberately outside
  `/api/member/*` and `officialMode`, gated only by the write freeze and an authenticated session —
  ending the caller's own Person Link and every Access Grant it currently supports in one batch,
  refusing (`409`) to strip the last System Administrator and permanently recording that refusal
  as a denied Access Event. The board's mirror surfaces are flat, `requireBoard`-gated, and
  new-model-always (no mode branch): `/api/admin/person-links` (`GET` the full link register with
  verification provenance; `POST` `manualVerify { accountId, personId, reason:
'manual_board_decision'|'migration_reverification', evidence }` links an EXISTING Person — never
  creates one — with readable `404`/`409` pre-checks for an unknown/organization/consolidated
  Person or either side already linked, and `unlink { linkId, endReason }` for every admin-facing
  end reason except `self_unlink`, sharing the same grant-ending batch and last-System-
  Administrator guard as `/api/verify/unlink`) and `/api/admin/verification-requests` (`GET` the
  open review queue; `POST` `accept { id, personId, reason? }` is a `manualVerify` whose evidence
  cites the request's own id, resolving the row `accepted` in the same batch; `decline { id }`
  marks the row `declined` and writes a durable `identity` ledger event — denial IS ledgered here,
  unlike a correction-request decline). Rate limiting (KV, `src/server/verification/rate-limit.ts`)
  keeps Turnstile, the per-account 120s cooldown, and the per-account daily cap (5), keeps the
  per-Lot daily cap (5, both modes), adds a per-Person daily cap (5, `derived` only — a Person who
  owns several Lots must not be re-sendable once per Lot), and adds a distinct-claimed-names-
  per-Lot-per-account cap (3/24h, both modes) — the roster-walking control, capping how many
  different names one account can try against one Lot regardless of whether any of them matched.
- ADR 0022 phase 3d transfer effects and the review-flag queue (#220; decided by #204).
  `src/server/roster/transfer-effects.ts` is the mutation-boundary engine wired into
  `/api/admin/roster-ownerships` `end` (resets every open member-motion vote for the departing
  Lot, then runs retrospective discovery and the forward pass) and `void` (no vote reset — a void
  is not a transfer — plus supersede-on-void of that Ownership's own open flags) and into
  `/api/admin/roster-representations` `end`/`void`/`correctScope` (discovery and the forward pass
  only; a Representation change never resets a vote). Per #204, a transfer changes who may act for
  a Lot, never whether the Lot counts: no eligibility snapshot, weight, turnout row, or quorum
  denominator is touched. The ONE stored action it reverses is an open member-motion vote for the
  transferred Lot — `member_votes` deleted and the motion's `voting_revision` advanced under the
  same compare-and-swap `setMemberVotes` and live casting already require, closed motions
  untouched. Everything else is surfaced, never rewritten, as a `review_flags` row: retrospective
  discovery walks the `[effectiveDay, recordedAt]` window (occasion-day rule for member
  attendance/votes, recorded-instant rule for ballots and granted proxies) and flags
  `intervening_action_backdated`, plus an account-keyed pass over `roster_change`/`identity`
  ledger events for any Board Term the command affected; a forward pass over still-upcoming
  occasions flags a pending held proxy `authority_lost_pending_occasion` and a not-yet-concluded
  conducted ballot `ballot_final_after_transfer` (conducted only — a recorded election's ballots
  stay replaceable via `setBallots`). One flag per record: the forward pass is enumerated first and
  wins any record both passes would reach. A void supersedes its own open flags
  (`resolution_code = 'superseded'`) rather than deleting them; nothing stored is ever reversed.
  Flag INSERTs FK-reference the `review_flag_opened` audit event that opens them, so
  `effects.flagStatements` runs after `correlation.statements` in every caller's batch — the one
  documented exception to `audit.ts`'s domain-writes-first ordering. BALLOT SECRECY: this module
  never reads, joins, names, or counts `ballot_choices` or a candidate selection — a
  `ballot_final_after_transfer` flag reaches only the identity-linked turnout `ballots` row and the
  election occasion. The board's read/resolve surface is `GET`+`POST /api/admin/review-flags`,
  `requireBoard`-gated: `GET` returns the full-detail register (every flag, open first, with its
  typed impacted reference and source-event summary — the same full-detail-on-list shape as the
  other phase-3b/3c registers); `POST { action: 'resolve', id, resolutionCode }` accepts
  `remediated`/`confirmed_valid`/`no_effect` (`400` for `superseded`, reserved for the automatic
  void/correction path above; `409` on an already-resolved flag) and, in one batch, flips the flag
  and writes an account-attributed `review_flag_resolved` root event. `src/lib/roster-admin.ts`'s
  `fetchReviewFlags`/`resolveReviewFlag` and the phase-3e (#221) **Review** panel (`ReviewPanel`)
  are its client helper and admin panel: `ReviewPanel` lists every flag with its typed `impacted`
  reference (rendering `null` rather than hiding the row), offers only the three manual resolution
  codes, and never offers `superseded`.
- Board-only document assistant: `POST /api/admin/assistant` (SSE) takes `{ question, history? }`
  and streams a Claude-generated, cited answer over the document library, retrieved via Cloudflare
  AI Search; document excerpts and chat history are pseudonymized (known resident PII replaced with
  consistent surrogates) before they reach Anthropic, document titles are pseudonymized before being
  sent, orphan/empty retrieval chunks are dropped before generation, and citations reference
  retrieved chunks back to real documents server-side. See SECURITY.md for the
  pseudonymization guarantees and limits. Retrieval is not tier-aware, which is why this endpoint
  stays board-only — see SECURITY.md and **Data model** below for the two-representation R2 layout
  retrieval runs over. `POST /api/admin/documents` generates the document's `rag/<uuid>.md` twin on
  upload via Workers AI `toMarkdown` and records `documents.rag_status` (`ok`/`unsupported`); a new
  upload is searchable at the next AI Search sync, and files that cannot be converted (scans, old
  `.doc`) are flagged "Not searchable" in the admin Documents panel via a board-only
  `GET /api/admin/documents`. Scanned uploads that `toMarkdown` cannot convert are flagged
  `rag_status = 'unsupported'` and can be made searchable later by the operator-run
  `scripts/ocr-scanned.ts` (rasterize + Workers AI vision; see [ADR 0010](./docs/adr/0010-ocr-scanned-documents-operator-job.md)).
- Board-only governing-documents reports: `POST /api/admin/reports` (SSE) takes `{ template }` XOR
  `{ topic }` (topic capped at `INPUT_LIMITS.reportTopic`; 400 on malformed/both/neither/
  unknown-template/over-length, 500 when the Anthropic key is missing, 503 when AI Search is
  unavailable). One of six curated templates (rentals, fences/improvements, assessments,
  enforcement, meetings/voting, maintenance) supplies fixed retrieval sub-queries; a freeform topic
  is instead expanded into 3-6 sub-queries by a small Claude Haiku planning call. Chunks from every
  sub-query are retrieved, pooled, deduped, and capped at 30, then streamed through one Claude Opus
  generation into a five-section markdown report (Summary / What the documents say / Where it
  lives / Ambiguities and conflicts / Gaps) with `[Source N]` citations, built via the same
  excerpt-context and pseudonymization pipeline as the chat assistant (see `src/server/ai/`
  below). The stream emits a `sources` frame, `token` frames, then `done { id }`; a completed
  report is inserted into the `reports` table before `done` is emitted, so a failed or
  client-disconnected generation leaves no row. `GET /api/admin/reports` lists saved report
  metadata newest-first, or returns one full report (`?id=`) including `contentMd` and sources;
  `DELETE /api/admin/reports` (body `{ id }`) removes a saved report. All three verbs are
  `requireBoard`-gated, fail-closed. See SECURITY.md for the privacy model shared with the chat
  assistant and the saved-report exposure it does not share.
- Homeowner verification: `/api/verify/{request,confirm,review,unlink}` — see the ADR 0022 phase
  3c entry above for the full contract.
- First-System-Administrator bootstrap: `POST /api/bootstrap/board` (rewritten by #219; see
  `src/server/roster/bootstrap.ts`), permanently fail-closed and checked in this order: the
  `system_admin_bootstrap` singleton is unconsumed (`410` once used — this, not "does a board
  account exist," is the primary guard, since an account can also be promoted board by other
  means), a timing-safe `x-bootstrap-secret` match against `env.BOOTSTRAP_SECRET` (missing binding
  = closed, `403`), an authenticated session (`401`, resolved directly off Better Auth rather than
  through `getAuthContext`/`cutover_mode`, since bootstrap runs at flip step 4 while `cutover_mode`
  may still read `legacy`), then a body `{ personId }` naming an already-recorded roster Person
  (readable `404`/`409` for unknown/organization/consolidated or either side already linked). One
  atomic batch then creates `person_verifications` (`method='bootstrap'`,
  `reason='bootstrap_first_administrator'`), `person_links`, a `system_admin` row in
  `access_grants` (`grant_reason='bootstrap'`), the `system_admin_bootstrap` singleton row itself,
  a root `identity` ledger event plus its caused `access` event, and a `users.role='board'`
  write-behind mirror (fresh-deploy admin access under `legacy`; a no-op if the account is already
  board at the flip). The legacy BOARD_EMAIL/BOARD_PASSWORD/BOARD_NAME signup path and its
  board-count guard are retired — `src/server/auth/seed-board.ts` and `scripts/seed-board.ts` are
  deleted. The route stays at its unchanged path and remains one of the write freeze's two
  permanent exemptions; it never calls `writeFreezeError`.
- Better Auth handler: `/api/auth/[...all]`.

**Client helpers.**

- `src/lib/content.ts` handles public reads from `/api/content/*` endpoints.
- `src/lib/member.ts` handles the official-mode homeowner proxy API: `fetchMyProxies`,
  `grantProxy`, `revokeProxy`, and `lookupLotPersons` (over the unchanged `/api/member/owner-lookup`
  path), with the write/lookup request shapes kept beside those helpers.
- `src/lib/admin.ts` handles board writes to `/api/admin/*` endpoints, typed document duplicate
  errors, duplicate-resolution helpers, saved-report list/fetch/delete helpers (`fetchReports`,
  `fetchReport`, `deleteReport`), the meeting-record people-picker and party-roster reads that
  replaced the retired board-roster helpers (`fetchMeetingRosterPeople` — the flat `{id,
fullName}` list from `GET /api/admin/meetings?roster=people` — plus `fetchLotPeople`, the per-lot
  Lot Authority list from `GET /api/admin/meetings?roster=lot-people` that backs the member
  attendance, member vote, ballot, and proxy pickers (#248 part 2; former holders included and
  flagged `current: false`, so a past occasion stays recordable and the Proxies panel can warn that
  a grantor's proxy would be born unusable), and `fetchRosterPeople` and
  `fetchRosterLots` over `GET /api/admin/roster`), meeting-record helpers
  (`fetchMeetings`, `fetchMeeting`, `saveMeeting`, `deleteMeeting`, `approveMeeting`,
  `unapproveMeeting`, `setAttendance`, `setMemberAttendance`, `saveMotion`, `deleteMotion`,
  `openMotionVoting`, `closeMotionVoting`, `setVotes`, `setMemberVotes`), resolutions-book helpers (`fetchResolutions`,
  `saveResolution`, `deleteResolution`, `adoptResolution`, `supersedeResolution`,
  `repealResolution`), and elections-record helpers (`fetchElections`, `saveElection`,
  `deleteElection`, `openElection`, `closeElection`, `voidElection`, `certifyElection`, `uncertifyElection`,
  `setTallies`, `setBallots`, `saveCandidate`, `deleteCandidate`) — the board-only `GET` for
  resolutions, elections, and proxies already returns every record's full detail, so unlike
  meetings/motions none of them has a separate single-record fetch — and proxies-record helpers
  (`fetchProxies`, `saveProxy`, `deleteProxy`). `setMemberAttendance`, `setMemberVotes`, and
  `setBallots` each take a `proxyId?: string | null` per entry, replacing the old `viaProxy?:
boolean`.
- `src/lib/roster-admin.ts` (ADR 0022 phase 3e, #221) handles board — and, for its three
  System-Administrator-only actions, capability-gated — writes to every phase 3b/3c/3d roster admin
  surface, one group per admin panel: Roster (`fetchRoster`, lot retire/correct, party
  create/correct/consolidate, ownership create/end/void, representation
  create/end/void/correctScope, contact-method add/end/void/setPreferred, `exportRoster`), Board
  (`fetchBoardService` plus the nine create/end/cancel/void-term, substitute-qualifying-lot,
  correct-term, and assign/end/void-office actions), Access
  (`fetchAccessGrants`/`grantAccess`/`revokeAccess`,
  `fetchPersonLinks`/`manualVerifyPersonLink`/`unlinkPersonLink`, and the
  verification-review/correction-request queue helpers), Review
  (`fetchReviewFlags`/`resolveReviewFlag`), and Compliance
  (`fetchRedactions`/`redactPersonName`/`redactContactMethod`/`recordRedactionCleanup`,
  `fetchAccessDenials`, `fetchAuditIntegrity`). `isCapabilityRefusal` identifies the bare `403`
  every System-Administrator-only helper returns to a caller holding no live `system_admin` grant
  — which, while `cutover_mode = legacy`, is every caller. The five admin
  panels (`RosterAdminPanel`, `BoardServicePanel`, `AccessPanel`, `ReviewPanel`, `CompliancePanel`)
  call only these helpers, never the routes directly.
- `src/lib/voting.ts` handles the exact-204 browser writes to `POST /api/vote` for one-time
  homeowner election-ballot and member-motion submissions; failed responses surface their server
  message and never create a receipt.
- `src/lib/reports.ts` contains the six curated `REPORT_TEMPLATES` (rentals, fences/improvements,
  assessments, enforcement, meetings/voting, maintenance) with their hand-tuned retrieval
  sub-queries, and the shared `ReportListItem`/`ReportDetail`/`ReportSource` shapes used by both
  the admin UI and the `/api/admin/reports` endpoint.
- `src/lib/types.ts` contains shared shapes, `DEFAULT_*` fallbacks, `DOCUMENT_CATEGORIES`, the
  `Visibility` type, fail-closed `SiteSettings.liveVotingEnabled`, admin-write input normalizers
  (`normalize{Announcement,Property,Owner,Resolution,Election,Candidate,Proxy}Input`,
  `INPUT_LIMITS`) that trim, cap, validate, and reject on write, the resolution shapes
  (`ResolutionStatus`, `RESOLUTION_STATUSES`, `ResolutionSummary`, `ResolutionDetail`,
  `ResolutionChainLink`, `ResolutionInput`), the elections shapes (`ElectionStatus`,
  `ElectionSource`, `ELECTION_STATUSES`, `ELECTION_SOURCES`, `ElectionSummary`, `ElectionDetail`,
  `CandidateSummary`, `ElectionTurnout`, `ElectionEligibleProperty`, `BallotRow`, `ElectionInput`,
  `CandidateInput`), member-motion `MotionVotingState` and shared `EligibilityTotals`, the
  caller-specific voting read shapes (`OpenVotingItem`, `OpenElectionVoting`, `OpenMotionVoting`,
  `VotingLot`, `VotingPersonOption`, `VotingProxyOption`), cast inputs/results (`VoteAction`,
  `CastBallotInput`, `CastMotionVoteInput`, `VoteWriteResult`), the proxies shapes (`ProxyDetail`,
  `ProxyInput`, `MemberProxyDetail`, `MemberProxyLists`, `MemberLot`, and `UpcomingOccasion`), a shared
  `isoDateOrError` calendar-date validator used by both the declarative normalizers and the
  resolutions route's `adopt`/`supersede` and the elections route's `certify` transition
  arguments, and `MemberAttendanceRow`/`MemberVoteRow`/`BallotRow`'s `proxyId` field (board-only,
  `null` on every public read — `viaProxy` on all three is now derived as `proxyId !== null` rather
  than a stored column).
- `src/lib/site.ts` contains branding constants and official-mode presentation logic (`navLinks`,
  `brandTag`, `accountNav`). The footer disclaimer and `/about` copy are board-editable via site
  settings, with `DISCLAIMER_SHORT` and `DISCLAIMER_LONG` as fallbacks. `disclaimer(site)` and
  `aboutParagraphs(site)` return overrides or built-in copy when blank. This is a pure module usable
  in `.astro` files, islands, and unit tests.
- `src/lib/format.ts` contains shared formatting helpers, including `associationDateIso` for the
  `America/New_York` proxy cutoff, unit-tested in `format.test.ts`.
- `src/lib/auth-client.ts` contains the Better Auth browser client.

**Server code.** `src/server/` contains:

- `auth/`: Better Auth config, Resend and Twilio senders.
- `authz/`: `context.ts` is the single seam every guard, page, and route resolves its caller
  through. `getAuthContext(request, env, associationDay)` resolves the session, then reads
  `cutover-mode.ts`'s `getCutoverMode` (the uncached `cutover_settings.cutover_mode` singleton,
  `test/server/cutover-mode.test.ts`) to decide which model answers: `legacy` calls
  `legacyAuthContext`, which synthesizes an `AuthContext` from the stored `users.role`/
  `user_property_links`, deliberately reproducing the old rank ladder (a board caller gets `member`
  too) so `cutover_mode = legacy` is bit-for-bit what the site was; `derived` calls
  `derivedContext(deriveAccess(...))` (below). `getCutoverMode` fails closed to **`legacy`** — the
  opposite polarity from the write freeze below, deliberately: the freeze falls back to frozen
  because refusing is the restrictive answer, while the safe answer here is whichever model is
  already serving production. Since the phase 3f flip the row exists and reads `derived`; an
  absent row now means the singleton was never written, and answers `legacy`. `associationDay` is a
  required third parameter, computed once per request by `src/middleware.ts` and by
  `resolveAuthContext` (middleware-first caller resolution with a fail-closed fallback) via
  `associationDateIso()`, never read from `locals` or recomputed downstream.
  `readLegacyRosterContext` reads the legacy answer for one account entirely from D1 with no
  session, for the shadow layer's mode-aware comparison (below). `users.role` is read ONLY inside
  `context.ts` — `test/unit/authz-legacy-role.test.ts` pins that by import-scanning the rest of
  `authz/`, and separately scans all of `src/` for a `ctx.role` comparison outside the guards (a
  read like `visibleTiers(ctx.role)` passes the alias onward rather than comparing it, so it is not
  matched). `guards.ts` defines the `AuthContext` shape — `userId`, `personId` (null under
  `legacy`, which has no Person concept), a `capabilities` **set** of `member`/`board`/
  `systemAdmin` (deliberately not a ladder: `systemAdmin` implies `board`, but neither implies
  `member`, which comes only from Lot authority), `lotIds`, `contentTier`, `hasCurrentBoardTerm`,
  plus compatibility aliases `role` (= `contentTier`) and `propertyIds` (= `lotIds`) that feed
  nothing but content reads — `tierAllows`/`visibleTiers` and their call sites are unchanged —
  retained through phase 3 and deleted in phase 4 (#212) — and its two check primitives:
  `requireCapability(ctx, capability)` (set membership, the primitive every route gate is now built
  on) and `requireRole` (survives only for content-tier questions, since `contentTier` is
  genuinely ordered, unlike capability). `requireBoard`, `requireMemberApi` (official-mode-first
  homeowner-write gate), and `requireVotingApi` (feature flags, write freeze, exact Origin, JSON
  media type, session, then `member` capability, in that order) keep their signatures but now gate
  on `ctx.capabilities` — `board` for the admin gate, `member` for the member and voting gates — as
  does middleware's backstop for each surface. Four call sites that used to compare `ctx.role`
  directly now ask `ctx.capabilities.has(...)`/`ctx.lotIds` instead: `/api/member/owner-lookup`,
  both cast preflights in `content/voting.ts`, and the `verified` checks on `/proxies` and `/vote`
  — identical behavior under `legacy`; under `derived`, a board member who owns no Lot is refused
  these member surfaces while still admitted to board ones. `requirePropertyAccess` remains the
  per-property access check (no route calls it yet), and Turnstile checks are unchanged.
  `write-freeze.ts` (`isWriteFrozen`, `writeFreezeError`, `freezePolicyFor`,
  `isMutatingMethod`) is the operator-only maintenance switch built for the ADR 0022 phase-3 flip
  and retained after phase 4: it reads the uncached `cutover_settings.write_freeze` singleton
  (fail-closed — a read error or an active freeze answers `503`; an absent row is the normal
  un-frozen state, not an error). Coverage is **deny-by-default and path-derived**:
  `freezePolicyFor(path)` is the single authority both enforcement layers consult, returning
  `everything` for `/api/member/*` and `/api/vote` (no read-only half worth keeping live),
  `exempt` for exactly two paths, and `mutations` for **everything else** — including paths nobody
  has written yet. `writeFreezeError(env, request)` therefore takes no scope argument: it derives
  coverage from the request's own path, so no call site can hold a stale opinion about what its
  surface freezes, and middleware and the per-route guards cannot drift. The two exemptions are
  `/api/auth/*` (sign-in writes a session row; an operator locked out of `/admin` cannot run the
  flip) and `/api/bootstrap/board` (flip step 4 creates the first System Administrator while the
  freeze is on). Called from `requireBoard`, `requireMemberApi`, `requireVotingApi`, both
  `/api/verify/*` routes, and `src/middleware.ts` — whose final `else` branch is what catches any
  surface no named branch claims. `test/unit/freeze-coverage.test.ts` enumerates every route module
  and fails if a mutating route ends up live without being declared in both that test and
  `ALWAYS_LIVE`. `authz/` also holds the ADR 0022 shadow layer, which computes but never decides:
  `derive.ts` (`deriveAccess`/`toDerivedAccess`, a capability SET — `member`/`board`/`systemAdmin`,
  not a ladder — plus `lotIds`, `contentTier`, and `hasCurrentBoardTerm`, recomputed from current
  D1 facts on every call with nothing cached) now also returns `invalidBoardGrantId` — a live Board
  grant whose qualifying term has lapsed, been cancelled, or been voided
  (`test/server/access-revalidation.test.ts`); evaluation refuses the caller `board` on the
  strength of it, independent of whether the write path already ended the grant, and recording it
  as an Access Event awaits an attribution decision on #217. `shadow-compare.ts`
  (`compareContexts`, the pure legacy-vs-derived diff shared by the request path and the offline
  sweep so neither can drift from the other) and `shadow.ts` (`compareInShadow`, wired into
  `src/middleware.ts` behind `env.CUTOVER_SHADOW === 'on'`) are mode-aware: they compute the OTHER
  model from whichever context served the request — under `legacy` it derives, as phase 2 always
  did; under `derived` it reads the legacy roster fresh via `readLegacyRosterContext` — so the two
  sides can never become a comparison of the served context with itself. It still returns `void`
  and swallows its own errors, so it remains structurally incapable of changing a response, and
  stays in place through phase 3, deleted only in phase 4 (#212). Legacy
  `getAuthContext`/`resolveAuthContext` remain the entry point for every request regardless of
  which model answers it.
- `content/`: `visibility.ts` (`tierAllows`, `visibleTiers`), `reads.ts` (per-role reads for
  announcements, documents, and now the meeting record — `fetchMeetingsFor`/`fetchMeetingFor`
  filter `status = 'approved'` UNCONDITIONALLY, including for a board caller, so a draft meeting is
  reachable only through the board-only `fetchAdminMeetings`/`fetchAdminMeeting`; a shared
  `assembleMeetingDetail` builds the attendance/motions/roll-call body for both pairs and carries no
  status or tier logic itself — see [ADR 0014](./docs/adr/0014-meeting-record-status-gate.md).
  Its board-side name map is built from `people` (the party roster) rather than the retired
  `board_people` identity as of #248 (ADR 0022 phase 4 precondition, part 1 of 2), with every label
  routed through `personDisplayLabel` so a redacted Person renders its durable-ID fallback the same
  way every other Person read does.
  `assembleMeetingDetail` also assembles the member side — `MeetingDetail.memberAttendance`,
  per-motion `MotionDetail.memberVotes`/`memberTally`, and `totalActiveWeight`, a `SUM(vote_weight)`
  aggregate over ACTIVE properties that is the member quorum denominator, computed unconditionally
  for every meeting (including board ones) so consumers must gate its use on `meetings.body`, never
  on the value itself being non-zero; see [ADR 0015](./docs/adr/0015-weighted-member-voting.md)).
  `assembleMeetingDetail` also takes an `includeProxyIds` admin-caller flag — the second instance of
  the ADR-0017 admin-only-field pattern, recorded together in
  [ADR 0018](./docs/adr/0018-proxies-record-via-proxy-consolidation.md): `MemberAttendanceRow.proxyId`
  and `MemberVoteRow.proxyId` carry the real proxy id only when `fetchAdminMeeting`/
  `fetchAdminMeetings` call it `true`; `fetchMeetingFor`/`fetchMeetingsFor` call it `false`, and
  `viaProxy` — always present — is derived as `proxyId !== null` rather than a stored flag. `content/`
  also has `dedupe.ts` (SHA-256 exact matching and metadata-only near-duplicate scoring),
  `proxy-guards.ts` (`proxyUseError`, the shared cross-row guard `setMemberAttendance`,
  `setMemberVotes`, and `setBallots` each call before writing a `proxyId`, plus
  `parseProvenance`/`personExistenceError` for the acting-Person field beside it), `voting-state.ts`
  (the shared SQL predicate requiring both official mode and live voting to be literal JSON
  booleans `true` for database-conditioned open and cast transitions), `voting-reads.ts`
  (`fetchOpenVotingFor`, the server-only caller-specific projection of visible open occasions,
  eligible own/proxied lots, frozen weights, valid provenance options, candidates, and `hasCast`
  receipts; it never reads `ballot_choices` or returns live tallies), and `voting.ts`
  (`normalizeVoteAction`, preflight error mapping, and atomic election/motion casting whose SQL
  repeats visibility, authority, frozen eligibility, open state, feature flags, and duplicate
  exclusion at the mutation boundary). `reads.ts` also
  has the resolutions book — `fetchResolutionsFor(env, role, { includeHistoric? })` filters
  `status != 'draft'` UNCONDITIONALLY, including for a board caller, the same rule ADR 0014 sets for
  meetings, so a draft resolution is reachable only through the board-only `fetchAdminResolutions`;
  by default it returns only `in_force`, and `includeHistoric` adds `superseded` and `repealed`.
  Both share a chain-walk helper that follows `supersedesId` backwards and re-applies the caller's
  tier filter at every step, masking an out-of-tier predecessor/successor to
  `{ id: null, number: null, title: null, visible: false }` rather than omitting it, so the chain's
  true length is never hidden. See [ADR 0016](./docs/adr/0016-resolutions-supersession-chain.md).
  For motions, `assembleMeetingDetail` attaches current active-property eligibility totals until
  first open, then frozen totals from `motion_eligibility`. `reads.ts` also has the elections record
  — `fetchElectionsFor(env, role)` filters
  `status IN ('closed', 'certified')` UNCONDITIONALLY, including for a board caller, the same rule
  ADR 0014 sets for meetings, so a draft or void election is reachable only through the board-only
  `fetchAdminElections`; both share `assembleElectionDetail`, which always computes aggregate
  turnout (`ballotsCast`, `weightCast`, `eligibleCount`, `eligibleWeight`, `eligibilityFrozen`),
  using current active properties before first open and `election_eligibility` afterward, but
  attaches the per-lot `eligibleProperties` and `ballots` lists only for the admin caller — both
  fields are `null` on every public read. It never reads or returns `ballot_choices`. See
  [ADR 0017](./docs/adr/0017-elections-secret-by-construction.md) and
  [ADR 0020](./docs/adr/0020-digital-ballot-box.md). `reads.ts` also has
  `fetchAdminProxies(env)`, the board-only complete-register read: it returns every `ProxyDetail`
  with its property address and grantor/holder Person names resolved (through `personNameMap`, the
  shared `personDisplayLabel` map this file also builds the meeting record's names from), the same
  full-detail-on-list shape as `fetchAdminResolutions`/`fetchAdminElections`. Homeowner proxy reads
  use `fetchUpcomingOccasionsFor` (minimal tier-filtered scheduled-event metadata regardless of
  draft status), `fetchMemberLots` (the caller's active lots and the Persons who may act for them),
  and
  `fetchMemberProxies` (lot-scoped granted/held lists with the ADR 0019 own-lot occasion exception
  and held-row tier redaction); these are not a public or complete tier-gated proxy register.
- `db/`: Drizzle `schema.ts`, `auth-schema.ts`, `client.ts` (`getDb(env)`), migrations, and
  `invariants.ts` (`INVARIANT_CHECKS`, `runInvariants(env)`, `formatInvariantRun` — see the
  invariant-gate paragraph below the **Data model** section).
- `scheduled.ts`: `runScheduledJobs(env)`, the body of the Worker's daily `0 7 * * *` cron trigger —
  see **Deploy** below.
- `roster/` and `verification/`: homeowner verification support. `roster/verification.ts` is the
  ADR 0022 phase 3c derived-mode Person matcher and confirm flow, `roster/identity.ts` is the
  shared Person Link creation/ending machinery behind `/api/verify/unlink` and
  `/api/admin/person-links`, `roster/bootstrap.ts` is the first-System-Administrator bootstrap
  behind `POST /api/bootstrap/board`, and `roster/transfer-effects.ts` is the phase 3d (#220)
  transfer-time effects engine behind `/api/admin/roster-ownerships` and
  `/api/admin/roster-representations` (see the HTTP endpoints entry above and **Data model**
  below) — all four join the phase 3b roster writer machinery
  described below. `roster/authority.ts` is the #248 part 2 addition and the only definition of
  "this Person holds Lot Authority over this Lot" — Ownership, or Representation of an owning
  Organization, mirroring `board-consequences.ts`'s `qualifiesGuard` — exposed both as Drizzle
  readers (`fetchLotAuthority`, `fetchPersonAuthority`, `fetchLotAuthorityHistory`,
  `hasEverHeldLotAuthority`, `fetchLotAuthorityKeys`) and as the raw-SQL `lotAuthorityExists` fragment the casting
  predicates embed; a `day` of `null` asks "did this authority EVER exist", which is what lets the
  board's pickers still offer a former owner for a past occasion while every USE of that authority
  is refused. `verification/property.ts` is the unchanged-shape legacy backend (minus its
  three retired auto-enqueue paths, and now holding the `getActiveOwnersForProperty` reader that
  moved out of `roster/lookup.ts` when the member surfaces left the legacy roster — it is the only
  caller left) and `verification/rate-limit.ts` holds the shared KV throttles
  both backends call, including the phase 3c per-Person and distinct-claimed-names caps.
- `http.ts`: `readJson` and `stringField` request-body helpers for admin writes.
- `ai/`: the board-only document assistant and report generator — `search.ts` (`retrieve`,
  Cloudflare AI Search/autorag retrieval), `pii.ts` (`buildPseudonymizer`, a reversible
  roster-based PII pseudonymizer with streaming de-anonymization), `sources.ts` (`toSources` maps
  retrieved chunks back to real D1 document rows for citations; `docIdFromFolder` extracts a
  document's uuid from either R2 key shape, `documents/<uuid>/…` or `rag/<uuid>.md`), `context.ts`
  (`buildExcerptContext`, shared by the assistant and the report generator: resolves chunks to real
  documents, drops orphan/empty chunks, and builds the pseudonymized, per-document
  `[Source N]`-numbered excerpt text), `anthropic.ts` (`getAnthropic`, Anthropic client + config
  guard), `assistant.ts` (`answer`, `loadRosterEntries` — the pseudonymization dictionary source,
  unioning Person names and Contact Methods from the live party roster (`people`, `contact_methods`)
  with owner names/phones/emails from the legacy `owners` table and `properties.address`, deduped
  by `(type, value)`; unfiltered by status/interval/void/consolidation so a former owner or an
  ended contact value already used in a document stays masked, redacted rows arrive `NULL` and are
  skipped, and Organization names are deliberately excluded from tokenized name matching (their
  contact methods are still masked) — see #233 and SECURITY.md — and the shared `claudeTextStream`/
  `ClaudeStream` streaming helpers; orchestrates retrieve -> pseudonymize -> Claude generation ->
  de-anonymized streamed output), and `report.ts` (`planSubQueries`, a small Claude Haiku call that
  expands a freeform topic into 3-6 retrieval sub-queries from the pseudonymized topic and returns
  de-anonymized queries, degrading to a single query on any failure; `generateReport`, which uses a
  template's fixed sub-queries or a planned freeform topic, retrieves and pools/dedupes/caps chunks
  at 30, and streams one Claude Opus generation into a five-section governing-documents report).

**Data model.** D1 tables are defined in `src/server/db/schema.ts`. They include `announcements`,
`documents` (metadata including nullable indexed `content_hash`, plus nullable `keep_verified_at`
and `keep_verified_by`, set when a board member explicitly keeps a document during duplicate
review; the document library uses 16 `DOCUMENT_CATEGORIES`, see `src/lib/types.ts`), `settings`
(key/value singletons `dues` and `site`; the site JSON includes `officialMode` and the
fail-closed/default-false `liveVotingEnabled` flag), `reports` (saved AI-generated
governing-documents
reports: `topic`, nullable `template_key` — null means freeform — `content_md` (final
de-anonymized markdown), `sources_json` (a `{id, title, category}` snapshot), indexed
`created_at`, and `created_by` as a plain-text board-user-id audit column with no FK; only a
completed generation is saved, so a failed or client-disconnected generation leaves no row),
`board_people` and `board_terms` (the board roster's identity layer, per
[ADR 0012](./docs/adr/0012-board-record-as-structured-rows.md): `board_people` records a person,
with a nullable `user_id` link to a Better Auth `user` row kept for display only and never for
authorization; `board_terms` records a term of service — `person_id`, nullable `title`,
`term_start`, nullable `term_end` — so a member who serves, leaves, and returns keeps one identity
across terms; deleting a person with a term on record is refused with `409`), `meetings`,
`board_attendance`, `motions`, `board_votes`, `member_attendance`, and `member_votes` (the meeting
record — board and member meetings; proxies may be board-recorded or granted online by homeowners,
with the default-off live-voting lifecycle foundation described in ADR 0020 — per
[ADR 0014](./docs/adr/0014-meeting-record-status-gate.md) and
[ADR 0015](./docs/adr/0015-weighted-member-voting.md), and
[ADR 0020](./docs/adr/0020-digital-ballot-box.md): `meetings` has `body` (`board`/`member`, the
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
[ADR 0018](./docs/adr/0018-proxies-record-via-proxy-consolidation.md). A motion's displayed tally
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

ADR 0022 (`docs/adr/0022-party-roster-derived-access.md`) adds a durable party roster,
immutable audit ledger, and cutover-operational tables in `src/server/db/roster-schema.ts`,
`src/server/db/audit-schema.ts`, and `src/server/db/cutover-schema.ts`, merged into the app schema
by `getDb` in `src/server/db/client.ts` and registered in `drizzle.config.ts`'s schema array.
Migrations `0019`-`0022` (below) create all 29 tables plus the two `properties` columns above;
migration `0023` (below) adds eight server-side views over them. Two naming rules hold until ADR
0022 phase 4 and are worth knowing before touching any of this: there is no `lots` table — the Lot
remains `properties`, and every `lot_id` column here references `properties.id` — and board service
lives in `board_service_terms`, not `board_terms`, because the legacy `board_terms` table still
exists with a different shape and every phase-1 `CREATE TABLE` is `IF NOT EXISTS`, so creating
under the real name would silently no-op.

**Phase 1 ("expand") is complete and behaviorally inert.** **Phase 2 ("backfill and shadow") is
built, and legacy remains fully authoritative throughout it**: every guard resolves through the
legacy roster (`users.role`/`user_property_links`, read only inside `context.ts`'s `legacy` branch
as of phase 3a below), and the only new user-visible surface is a board-only, read-only preview
panel (see `GET /api/admin/roster-preview` above). The operator-only write freeze (below) is not a
counterexample to that reversibility claim: it decides only whether the site accepts mutations at
all, identically for every caller, and never who a caller is, what tier they read, or which Lots
are theirs — with no row written it is bit-for-bit what the site was before the freeze existed.
**Phase 3 ("cutover"), part a (#217), is also now built: `cutover_mode` decides which of the two
models answers, via `cutover-mode.ts` inside the `context.ts` seam** (see the `authz/` entry under
**Server code** above for the full mechanism). Read every "under `legacy` … under `derived`"
description below as a description of the SEAM, not of production: **the flip has happened, and
production runs `derived`** (see the phase 3f paragraph below). The legacy branch is retained,
still reachable by writing the flag back, and deliberately reproduces the old rank ladder, so it
stays bit-for-bit what the site was — the removals derived authorization makes (a board member who
owns no Lot losing the free pass into member surfaces) are live now, as the #206 allow-list
expected. `test/server/adr0022-parity.test.ts` runs every caller class through `getAuthContext`
with `cutover_mode` in both positions, including a board caller who owns no Lot and a revocation
that must take effect on the very next request, to hold that claim to account. **Phase 3 part b
(#218) is also built**: the roster, board-service, and access-grant routes described under **HTTP
endpoints** above, the member correction-request flow, the four System-Administrator-only
technical capabilities (`redactionAuthorize`, `redactionCleanup`, `accessDenialDetail`,
`auditIntegrityViews` — granted only with the `system_admin` grant, in both `guards.ts` and
`derive.ts`), and the #217-decided Access Event for a failed Board-grant re-validation
(`src/server/authz/revalidation-event.ts` — an account-attributed root, day-idempotent by
`operation_key = grant-revalidation:<grant>:<day>`, written only when `derived` is the SERVING
model and never from shadow, errors swallowed so evaluation cannot 500 on a ledger failure). The
shared writer machinery lives in `src/server/roster/`: `audit.ts` (the `AuditCorrelation`
ledger-batch builder, guard helpers, `assertInBatch` — a statement that ERRORS to roll a whole
batch back when an all-or-nothing part failed; gained the `review` detail family in phase 3d, #220
— `review_flag_opened`/`review_flag_resolved`/`review_flag_superseded` events and
`ReviewResolutionCode` — with a documented batch-order exception: flag INSERTs FK-reference the
audit event that opens them, so they are the one write that follows a correlation's own statements
rather than preceding them), `board-consequences.ts` (`qualifiesGuard`,
`noOverlapGuard`, and `lossConsequences` — the substitute-or-terminate engine that ends or
cancels Board Terms, their offices, and their grants when an Ownership or Representation change
removes a qualifying basis; the term ends on the real-world day, the grant always at
recorded-at), and `reads.ts` (the Roster/Board/Access reads, member self-read, and live-derived
advisories, all rendering redacted identities through `personDisplayLabel` in `src/lib/format.ts`
— the identical durable-ID fallback for every viewer, board included). **Phase 3 part c (the
Person Verification / Person Link rewrite, #219) is also now built**: the `/api/verify/*` and
`/api/bootstrap/board` routes described under **HTTP endpoints** above, and the board's
`/api/admin/person-links` and `/api/admin/verification-requests` mirror surfaces. The shared
writer machinery lives beside the phase 3b modules in `src/server/roster/`: `verification.ts` (the
`derived`-mode Person matcher — two-tier name match, uniquely-attributable contact selection, and
the one-batch confirm that writes `person_verifications`/`person_links` plus the write-behind
`user_property_links`/`users.role` mirrors), `identity.ts` (`manualVerificationStatements` and
`endLinkStatements` — the shared batch builders behind manual verification and every unlink path,
including the last-System-Administrator refusal shared by `/api/verify/unlink` and the board's
`unlink` action), and `bootstrap.ts` (the rewritten first-System-Administrator flow).
`/api/verify/request` and `/api/verify/confirm` keep ONE
route contract answered by TWO backends branched on `getCutoverMode` — `legacy` still runs the
pre-existing property flow in `src/server/verification/property.ts` (its three
`manual_approval_queue` auto-enqueue paths removed, per #201's anti-auto-queue rule), `derived`
runs the new Person flow — mirroring the whole program's "authoritative by flag, not code"
philosophy: shipping both backends changed nothing until `cutover_mode` said so, and since the
phase 3f flip that flag says `derived`, so the Person flow is the one production runs. **Phase 3 part d (transfer effects and the review-flag
queue, #220; decided by #204) is also now built**: proxy grantor re-validation in
`proxyUseError` and the live-cast authority predicates in `content/voting.ts` (both described
under **HTTP endpoints** above), the `roster/transfer-effects.ts` engine wired into
`/api/admin/roster-ownerships`'s `end`/`void` and `/api/admin/roster-representations`'s
`end`/`void`/`correctScope`, and the board's `GET`+`POST /api/admin/review-flags` queue. Unlike
phases 1-3c, this one took effect immediately when it shipped — a live behavior change ahead of
the flip rather than one gated behind `cutover_mode`: proxy grantor re-validation refused a stale
proxy from the day it landed, and an Ownership `end` reached through
`/api/admin/roster-ownerships` resets any open member-motion vote for the departing Lot. Its one
compromise is now gone: the grantor check read the LEGACY roster in both cutover modes, because a
proxy named an `owners` row and nothing mapped one to a Party. #248 part 2 re-keyed proxies to
Persons, so the check asks the roster itself through `roster/authority.ts` — the approximation that
survives is only the DAY it asks about (today, not the occasion's), which `proxy-guards.ts`'s
module comment records along with what would now be needed to close it. Migration
`0027` (below) rebuilds `review_flags` — created empty by migration `0020`, given its first writer
here. **Phase 3 part e (the writable board-service, roster, and Person-Link admin surface, #221;
decided by #200/#205) is also now built**: `/api/admin/roles` and `/api/admin/members` are
re-pointed onto the same `cutover_mode` branch (see the board-handoff and member-revocation entries
under **HTTP endpoints** above and the new `src/server/roster/access.ts` module), and five admin
panels — `RosterAdminPanel`, `BoardServicePanel`, `AccessPanel`, `ReviewPanel`, and
`CompliancePanel`, wired through the new `src/lib/roster-admin.ts` — give the board a writable
surface over every phase 3b/3c/3d route for the first time; the phase-2 `RosterPreview` panel is
retired in their favor (its read-only `GET /api/admin/roster-preview` route survives unchanged).
`MembersManager` also gained the verification-review queue — closing the gap where
`verification_review_requests` rows had been invisible to the board since v0.10.0 — and the
correction-requests queue; the legacy manual-approval queue keeps rendering only while it still
holds pending rows. `ProxiesManager` now warns when a chosen grantor no longer holds the lot, the same
proxy the phase 3d grantor re-validation above would refuse at use. These surfaces are now safe to
use: the caveat that stood here — writable in code but erasable by the phase-2 clean-replace
backfill rehearsal — was dissolved by phase 3f's authoritative backfill, which is insert-once and
deletes nothing, permanently retiring clean replace.

**Phase 3 part f — THE FLIP — was EXECUTED on 2026-08-18 UTC (#222, closed).** Production now runs
`cutover_mode = derived` with the write freeze off: derived authorization answers every request,
and `users.role`/`user_property_links` survive only as write-behind mirrors nothing reads for
authorization. The sequence ran under an operator write freeze held for 27 minutes: authoritative
(insert-once) backfill → first System Administrator bootstrapped through `POST /api/bootstrap/board`
(that route is now permanently self-disabled; its `system_admin_bootstrap` singleton is consumed
and a re-run answers `410`) → shadow sweep showing only the two pre-classified rows → flag to
`derived` → smoke → named sign-off lifting the freeze. Steps 5 and 6 of the #222 sequence were
measured VACUOUS on this site (0 legacy board people, 0 legacy terms, one board account classified
technical) and recorded as no-ops rather than skipped. Production roster after the flip: 40 parties,
40 ownerships, 56 contact methods, 159 audit events, one live `system_admin` grant, one live Person
Link, zero open review flags, `verify:invariants --remote` 17/17 under `derived`. **Only phase 4
(#212) remains**: deleting the shadow layer (`shadow.ts`, `shadow-compare.ts`, the offline sweep)
and the `role`/`propertyIds` compatibility aliases. The write freeze, the permission matrix, and
the ballot-privacy suites are retained permanently per #206/#212, not retired with the migration.

Phase 4 also owes a repointing precondition, per #246:
`test/unit/legacy-roster-consumers.test.ts` declares every `src/` module reading one of the six
tables phase 4 drops (`owners`, `user_property_links`, `property_verifications`,
`manual_approval_queue`, `board_people`, and the legacy `board_terms` — `properties` is excluded,
since phase 4 renames it to `lots` rather than dropping it), together with what phase 4 must do
about it. It exists because of #233 — the AI pseudonymizer kept reading `owners` after the flip
made the party roster authoritative, and nothing detected it, because the flip's checklist verified
that AUTHORIZATION stopped reading the legacy model and never enumerated the non-authorization
consumers. Unlike the import-only idiom `authz-legacy-role.test.ts` uses for `users.role`, this scan
checks both imported Drizzle symbols AND raw SQL (`FROM`/`JOIN`/`INTO`/`UPDATE`/`TABLE` followed by
the table name, comments stripped and URLs neutralised first) — an import-only scan would miss
`server/roster/verification.ts`, whose `user_property_links` write-behind mirror is a raw `INSERT`
with no Drizzle symbol imported. Each of its 10 declared modules carries one of five dispositions:
`deleted-with-the-table` (five legacy surfaces #212 deletes outright, including `context.ts`'s
`legacy` branch), `write-behind-mirror` (two modules whose write nothing reads for behavior),
`already-dual-read` (`server/ai/assistant.ts`, the #233 fix — phase 4 drops only its legacy arm),
`needs-repointing` (down from eight modules to two — `content/voting.ts` and
`content/casting-authority.ts`, after #248 part 2 repointed the other six off `owners` — and the
pair that remains is the same question twice: an ACCOUNT's claim on a lot, read from
`user_property_links`. That is not a roster question at all, which is why the roster work did not
close it: the roster says who may act for a lot, `user_property_links` says which lots this LOGIN
was verified for, and phase 4 answers that from `person_links`), and
`blocked-on-person-repointing`, now EMPTY: #248 (part 1 of 2) repointed both modules the category
used to hold (`pages/api/admin/meetings.ts`, `pages/api/admin/candidates.ts`) at the party roster
and closed it, kept as a heading rather than deleted since `board_people` survives until phase 4
drops it and a future reader of it belongs here. A declared entry whose module no longer reads a
dropped table fails the suite as stale, so the list can't rot into a misleading audit.

#248 (part 1 of 2) also closed the `board_people` half of the twelve legacy FK columns this same
paragraph used to enumerate: migration `0028` repointed the five that referenced it —
`board_attendance.person_id`, `motions.mover_person_id`/`second_person_id`, `board_votes.person_id`,
and `candidates.person_id` (renamed from `board_person_id`) — onto `people(party_id)`, and dropped
the parallel `motions.mover_owner_id`/`second_owner_id` pair outright rather than repointing it,
since it referenced `owners`, was never written (phase 3b), measured 0 rows in production, and the
party roster has one Person concept for both board and member motions where legacy needed two FKs
told apart only by the parent meeting's `body`. `board_people` itself now has no referencing FK left
in a table phase 4 keeps.

**#248 part 2 (migration `0029`) closed the `owners` half the same way**, and with it the whole
twelve-column list: `member_attendance.represented_by_person_id`,
`member_votes.cast_by_person_id`, `ballots.cast_by_person_id`, and
`proxies.grantor_person_id`/`holder_person_id` all reference `people(party_id)` now, so **no table
phase 4 keeps references `owners` or `board_people` any more** and #212's steps 3 and 4 are
unblocked. Four of the five were `set null` — the dangerous half, where dropping the parent would
have SUCCEEDED and silently erased who acted from historical records rather than failing loudly.
All five measured 0 non-null values in production on 2026-08-20, before the #212 exercise checklist
(which is what fills them) had run, so it was a pure schema change; the migration's mapping
branches exist for a database where that is not true.

"Who may act for a lot" moved with those columns and now has ONE definition,
`src/server/roster/authority.ts` — Ownership held by the Person, or Representation of an
Organization that owns the Lot — mirroring `board-consequences.ts`'s `qualifiesGuard` so Lot
Authority means the same thing to a board term, a proxy, and a cast. It carries the rule twice on
purpose, for ADR 0020's two layers: a Drizzle reader for preflights and pickers, and a raw-SQL
`lotAuthorityExists` fragment for the mutation-boundary predicates that re-check inside the INSERT.
`test/server/lot-authority.test.ts` runs both over the same fixtures and fails on a divergence,
which is the failure this arrangement is otherwise exposed to.

Phase 2 adds:

- Eight read-only views (migration `0023`) reconstructing corrected audit history, typed event
  subjects, one entity's/one operation's event stream, the open review queue, and redaction
  compliance, plus two integrity views described below. They are query shapes, not authorization
  boundaries, and live authorization never joins them.
- `src/server/authz/write-freeze.ts` — the operator-only write freeze, now enforced. It reads only
  the `cutover_settings.write_freeze` singleton (`test/unit/adr0022-model-boundary.test.ts` pins
  that it references no other new ADR 0022 table). Coverage is deny-by-default: every mutation
  answers `503` while it is on unless its path is one of the two declared exemptions, so
  `/api/admin/*` writes, all of `/api/member/*` and `POST /api/vote`, and `/api/verify/*` are all
  frozen, while reads — public pages, `/api/content/*`, `/api/files/*`, admin `GET`s — stay live
  throughout, as do `/api/auth/*` and `/api/bootstrap/board` on every verb. `cutover_mode` is a
  separate singleton in the same table; see the phase-3 paragraph above and `cutover-mode.ts` under
  **Server code** for what reads it.
- `src/server/authz/derive.ts`, `shadow-compare.ts`, and `shadow.ts` — the derived-authorization
  shadow layer described under **Server code** above. It computes a capability SET
  (`member`/`board`/`systemAdmin`, not a ladder) and re-validates every stored grant against
  current facts on every call; nothing is cached. Wired into `src/middleware.ts` behind
  `env.CUTOVER_SHADOW === 'on'` (an `src/ambient.d.ts` var, deliberately not in `wrangler.toml` —
  see that file's comment), it is mode-aware since phase 3a: it compares whichever context served
  the request against the other model computed fresh, rather than assuming the served context is
  always the legacy side, which self-compared and could never mismatch once `cutover_mode` could
  answer `derived`. It cannot change a response and swallows its own errors. Off by default; still
  deleted only in phase 4 (#212), not at the flip.
- `scripts/migrate-roster.ts` (`npm run roster:backfill`) and `scripts/backfill-plan.ts`: the
  clean-replace roster backfill. Dry-run by default; `--write --operator=<accountId>` applies it,
  writing exception queues for ambiguous cases and an audit baseline (one correlation per migrated
  root entity, `actor_kind = 'migration'`); `--authoritative` is the phase-3 insert-once mode
  (`ON CONFLICT DO NOTHING`, deletes nothing, refuses to run while a flip-blocking exception is
  outstanding). The repeatable `--classify=<accountId>=technical` flag (#222) resolves that
  account's `board_account_unclassified` blocking exception on the record — printed under
  "Operator decisions applied" — and plans no rows, since System Administration Access arrives
  only via `POST /api/bootstrap/board`, never the backfill; an unmatched account id is itself a
  new blocking exception (`classification_unmatched`), and any other classification value exits 2.
  **Post-flip caution:** the default (non-`--authoritative`) `--write` mode is a CLEAN REPLACE. It
  was safe only while the new model was inert; the flip's authoritative backfill has since seeded
  the roster production runs on, so running `--write` against remote D1 without `--authoritative`
  would delete live roster rows and their audit baseline. Any future run against production must
  pass `--authoritative`.
- `scripts/shadow-sweep.ts` (`npm run shadow:sweep`): an offline sweep that derives both
  authorization contexts for every account (not just accounts that sign in during the phase-2
  window) and records mismatches with `source='sweep'`, sharing `derive.ts`'s SQL and
  `shadow-compare.ts`'s comparison with the request-path shadow rather than reimplementing them.
  Local execution still batches through Wrangler's `--file` (D1's query API, per-statement
  results); remote execution goes through order-preserving, command-line-budgeted `--command`
  chunks instead, because remote `--file` is D1's import API (progress lines plus one summary, no
  per-statement results) and would otherwise silently mis-index as data.
- `scripts/wrangler-d1.ts` (#222): pure helpers shared by the scripts above and by
  `verify-invariants.ts` — `parseD1Output` types a `wrangler d1 execute --json` response as
  per-statement results, the import-API summary, or an unrecognized/non-JSON shape rather than
  ever letting one be misread as the other; `chunkStatements` splits SQL into order-preserving,
  Windows command-line-budgeted chunks for remote `--command` execution; `withRetry` bounds a
  retry loop around a `shouldRetry` discriminator.
- `src/server/roster/normalize.ts` gains `normalizeEmail`, `normalizePhone`, and `normalizeName`,
  used by the backfill to detect cross-Party contact ambiguity that legacy data never normalized
  consistently enough to catch on its own.

The 17 invariant queries — none pending — are the shared source of truth in `src/server/db/
invariants.ts` (`INVARIANT_CHECKS`): interval non-overlap on Ownerships/Representations/Board Terms/
Office Assignments, party-subtype completeness, audit-event detail cardinality and causal order,
redaction/review-flag completeness, a check that no `review_flags` column references ballot choices
or candidates, and the two view-backed checks migration `0023` un-stubs
(`audit_integrity_violations_v`, `board_eligibility_violations_v`). `audit_integrity_violations_v`
sits exactly at D1's five-term compound-`SELECT` ceiling; a sixth check there needs a second view
rather than a sixth branch. Two callers run them, and per #240 (decided by #206 — "the checks that
gate a migration are exactly the checks that catch drift afterwards") they must never disagree
about the set, so they cannot share an execution path (a Worker cannot spawn a subprocess) and
share the queries instead, the same shared-source discipline `shadow-compare.ts` was built with:
the operator-run `npm run verify:invariants` (`scripts/verify-invariants.ts`), which still owns the
Wrangler-subprocess machinery and `--local`/`--remote` — that path is why the CLI, not the scheduled
job, is what can point at remote D1 from a laptop — and `src/server/scheduled.ts`'s daily cron job
(see **Deploy** below), which runs `runInvariants(env)` straight through the `DATABASE` binding.
`runInvariants` executes every check sequentially (a daily background job has no latency budget,
and `PRAGMA foreign_key_check` walks every table) and never throws for a violation — a check's
`CheckResult.status` is `ok`/`violated`/`errored`/`pending`, `errored` deliberately distinct from
`ok` because a failed query also returns zero rows and zero rows is this gate's GREEN — leaving the
decision to the caller: the CLI exits non-zero and the scheduled job throws. `formatInvariantRun`
renders IDs-and-codes-only log lines shared by both callers so a violation reads identically in
Wrangler output and Workers Logs; nothing about a violation is stored, since a real one re-fires
every day until fixed. The CLI's own query execution still retries up to 3 attempts
(`scripts/wrangler-d1.ts`'s `withRetry`), absorbing an intermittent Node 26/Windows Wrangler libuv
exit-crash after the query already
succeeded; a deterministic failure — stdout carrying Wrangler's own `--json` error object — fails
immediately instead of burning retries on a repeatable error, and a response shaped as anything
other than exactly one statement result throws rather than being read as zero rows (this gate's
green). `test/server/invariants.test.ts` runs all 17 checks through the real `DATABASE` binding
(including `PRAGMA foreign_key_check` and both views) and pins `runScheduledJobs`'s throw on a
violation; `test/unit/invariants-single-source.test.ts` is the anti-drift guard, asserting neither
caller contains a `SELECT`/`PRAGMA` of its own and that the shared list stays non-trivial.

`resolutions` (the resolutions book — standing rules the board adopts, per
[ADR 0016](./docs/adr/0016-resolutions-supersession-chain.md)) is a durable record: amending one
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

`elections`, `election_eligibility`, `candidates`, `ballots`, and `ballot_choices` (the recorded
paper-election workflow plus the default-off conducted-election foundation — per
[ADR 0017](./docs/adr/0017-elections-secret-by-construction.md) and
[ADR 0020](./docs/adr/0020-digital-ballot-box.md)): `elections` has a nullable `meeting_id`
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
totals from the retained rows. The boundary is pinned by a two-layer suite #206 says outlives the
migration: `test/unit/ballot-privacy-boundary.test.ts` statically scans `src/` for the term
`ballot_choices`/`ballotChoices` and `candidate_id`/`candidateId`, allow-listing only the schema
definition, the cast path, and conducted close's tally derivation, letting the two modules that
prose-declare the rule (`transfer-effects.ts`, `audit-schema.ts`'s `review_flags` header) mention
it only in comments, and hard-denying the phase 3d discovery/flag/ledger/export machinery any
reference at all; a third allow-list category, `CHOICE_NAMED_NOT_QUERIED`, holds exactly
`server/db/invariants.ts` — moving the check list into `src/` for #240 brought its
`no_flag_references_ballot_choices` check under this scan for the first time, since it spells
`ballot_choices` in its own check name and operator-facing meaning string (code, not prose, so the
prose-only exemption doesn't fit), and a separate assertion denies that file any `FROM`/`JOIN`/
`INTO`/`UPDATE` against the table or any `candidate_id`/`candidateId` mention, since its SQL only
inspects `pragma_table_info('review_flags')` for column names and reads no choice row;
`test/server/ballot-privacy.test.ts` is the runtime half, proving
`ballot_choices` rows are byte-identical before and after a transfer and that the review-flag
register exposes only the turnout row. `verify:invariants`'
`no_flag_references_ballot_choices` is the third leg, checked live against D1.
The legacy `board_terms` table still carries a nullable `election_id` referencing `elections` on
delete-set-null, but as of phase 3b nothing writes it: certification's provenance now lands on
`board_service_terms.election_id`, and the legacy board-roster routes are retired (#218).

`proxies` (the proxies record — either entered from paper by the board or granted online by a
homeowner for a lot they control, per
[ADR 0018](./docs/adr/0018-proxies-record-via-proxy-consolidation.md) and
[ADR 0019](./docs/adr/0019-homeowner-writes-official-mode-gate.md)): one Person
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
always) — see the `assembleMeetingDetail`/`includeProxyIds` note under **Server code** above.

Every document has two R2 representations keyed by its D1 uuid, per
[ADR 0009](./docs/adr/0009-rag-index-separate-from-download-library.md): the human-readable original
at `documents/<uuid>/<filename>`, served by `GET /api/files/<id>` with tier checks, and a derived
Markdown twin at `rag/<uuid>.md` that AI Search indexes (see **Cloudflare bindings** and the
board-only document assistant above). `docIdFromFolder` (`src/server/ai/sources.ts`) resolves a
document's uuid from either key shape so citations always point back to the real, tier-checked
download. The document library (444 human documents, 429 Markdown twins) is (re)built by the
operator-run `scripts/import-corpus.ts` as a clean replace; see SETUP.md §7.

Migration `0002` split homes and people into `properties` and `owners`. Migration `0003` adds
uniqueness constraints (`properties.address_normalized`, `user_property_links (user_id,
property_id)`) and hot-path indexes. Migration `0004` adds `documents.content_hash` and
`documents_content_hash_idx` for duplicate detection. Migration `0005` reconciles foreign keys and
enums on the roster/verification tables. Migration `0006` adds `documents.keep_verified_at` and
`documents.keep_verified_by`. Migration `0007` adds `documents.rag_status`. Migration `0008` adds
the `reports` table and its `reports_created_at_idx` index. Migration `0009` adds the
`board_people` and `board_terms` tables, with indexes on `board_terms.person_id` and
`board_terms.term_end`. Migration `0010` adds the `meetings`, `board_attendance`, `motions`, and
`board_votes` tables, with `meetings_status_date_idx`, `meetings_body_idx`, and
`motions_meeting_id_idx`, plus unique indexes enforcing one attendance row per meeting per person,
one vote per motion per person, and one motion per meeting per `sequence`. Migration `0011` adds
`properties.vote_weight`, the `member_attendance` and `member_votes` tables with unique indexes
enforcing one attendance row per meeting per property and one vote per motion per property, and
nullable `motions.mover_owner_id`/`motions.second_owner_id`. Migration `0012` adds the
`resolutions` table with `resolutions_number_unq`, `resolutions_supersedes_unq`, and
`resolutions_status_idx`. Migration `0013` adds the `elections`, `candidates`, and `ballots` tables
— `elections_status_idx`,
`elections_meeting_id_idx`, `candidates_election_id_idx`, `candidates_election_sequence_unq`,
`ballots_election_property_unq`, and `ballots_election_id_idx` — plus a nullable
`board_terms.election_id` column. Migration `0014` adds the `proxies` table —
`proxies_property_meeting_unq`, `proxies_property_election_unq`,
`proxies_meeting_id_idx`, and `proxies_election_id_idx`, plus the `proxies_one_occasion` CHECK
constraint. Migration `0015` drops `via_proxy` from `member_attendance`, `member_votes`, and
`ballots` and adds each table's `proxy_id` column. All committed migrations through `0015` were
verified as applied to production on 2026-08-05. Migration `0016` adds `ballot_choices`,
`election_eligibility`, `motion_eligibility`, and `motions.voting_state`. Migration `0017` adds
`motions.voting_revision`, an integer `NOT NULL DEFAULT 0` used as the live-motion
compare-and-swap token. Migration `0018` adds the `meetings.approved_by_motion_id` foreign key to
`motions.id` with delete-set-null, retaining valid legacy links and clearing dangling values.
Migration `0019` is ADR 0022 phase 1's party-roster core: `parties`, `people`, `organizations`,
`contact_methods`, `ownerships`, `representations`, `representation_lots`,
`person_verifications`, `person_links`, `board_service_terms`, `board_office_assignments`,
`access_grants`, and the `system_admin_bootstrap` singleton, every `CREATE TABLE IF NOT EXISTS`.
Migration `0020` adds the immutable audit ledger: `audit_events`, its seven typed detail tables
(`roster_changes`, `board_service_changes`, `identity_events`, `access_events`,
`roster_redactions`, `review_events`, `audit_record_corrections`), subject/delta tables
(`roster_change_subjects`, `board_service_change_subjects`, `audit_scalar_changes`,
`audit_sensitive_field_changes`), `review_flags`, and `redaction_tasks`. Migration `0021` adds the
two cutover-operational tables, `cutover_settings` (the operator-only `cutover_mode`/
`write_freeze` singletons) and `cutover_shadow_mismatches`. Migration `0022` adds
`properties.retired_day`/`properties.retired_at` via two plain `ALTER TABLE ADD COLUMN`
statements — the one non-idempotent file in the set, isolated to its own migration because SQLite
has no `ADD COLUMN IF NOT EXISTS`. Migration `0023` adds the eight ADR 0022 phase-2 views —
`audit_event_effective_v`, `audit_event_subjects_v`, `audit_entity_history_v`,
`audit_operation_timeline_v`, `audit_review_queue_v`, `audit_redaction_compliance_v`,
`audit_integrity_violations_v`, and `board_eligibility_violations_v` — every statement
`CREATE VIEW IF NOT EXISTS`, so the file is safe to re-run. Migration `0024` (phase 3b, #218)
adds `correction_requests` (the operational member-request table whose free text never enters the
ledger) and REBUILDS `board_service_changes` so its reason-code CHECK accepts
`legacy_migration_baseline` — the code the backfill's board-term baseline emits, a latent
flip-blocker until this migration; the rebuild drops and 0025 recreates the two views that
reference the table (SQLite's `ALTER ... RENAME` reparses every view), and uses D1's
`PRAGMA defer_foreign_keys`, not the unsupported `PRAGMA foreign_keys`. Migration `0025` also
REDEFINES `board_eligibility_violations_v` twice over: concluded terms are excluded (eligibility
is owed only while a term is current or scheduled — without this, every mutation-boundary
termination would light the view up), and a Representation's FUTURE end day now reads as
authority until it arrives, matching #202. Migration `0026` (phase 3c, #219) REBUILDS three more
tables inside `PRAGMA defer_foreign_keys`: `contact_methods` gains `party_kind` plus a composite FK
to `parties(id, kind)` and a `UNIQUE (id, party_kind)` index — the target that lets
`person_verifications` structurally require a PERSON's contact rather than an Organization's
(#202); `person_verifications` gains the paired `contact_method_party_kind` column (composite FK,
CHECK-pinned to `'person'`) replacing its old single-column contact FK, plus a
`person_verifications_bootstrap_shape` CHECK closing the shape gap the automatic/manual CHECKs left
open; and `identity_events` — provably empty, having never had a writer — is DROP+CREATEd to add
the opaque `evidence_request_id` locator and an `identity_events_evidence_exactly_one` CHECK
mirroring `roster_changes`, dropping the `election` evidence kind (an election proves nothing about
who an account is) while leaving `reason_code` deliberately unchecked, the same discipline-over-CHECK
lesson `0024`'s `board_service_changes` rebuild already recorded. The same file also adds two new
operational tables, `verification_codes` (pending Automatic Person Verification codes: matched
Person, contact, claimed Lot, code hash, attempts, expiry) and `verification_review_requests` (board
review requests — `claimed_address`/`claimed_name` are applicant free text that never enters the
ledger, one open row per account by partial unique index), and drops-then-recreates the two views
that reference `identity_events` (`audit_event_effective_v`,
`audit_integrity_violations_v`) verbatim, per the `0024`/`0025` precedent. Migration `0027` (phase
3d, #220) gives the never-written `review_flags` table (created empty by migration `0020`) its
first writer: a plain DROP+CREATE, the `0026` `identity_events` precedent. It adds
`impacted_motion_id` (FK restrict to `motions` — a `vote_reset_on_transfer` flag names the motion
whose vote was reset, since the reset DELETES the `member_votes` row the old shape would have
pointed at), widens the at-most-one impact CHECK to cover it, and converts the four legacy-record
impacted FKs (`impacted_proxy_id`, `impacted_member_attendance_id`, `impacted_member_vote_id`,
`impacted_ballot_id`) from RESTRICT to `ON DELETE SET NULL` — proxy deletion is the entire
revocation model and `setMemberAttendance`/`setMemberVotes`/`setBallots` are full-replacement
corrections, so a flag must survive the referenced record's deletion with its source event and
ledger context intact rather than freezing that record in place. `audit_review_queue_v` (which
references the table) is dropped first and recreated at the end with the new `motion` impacted
kind, the `0024`/`0025`/`0026` view precedent. Migration `0028`
(ADR 0022 phase 4 precondition, #248 part 1 of 2) repoints five FK columns off the legacy
`board_people` onto `people(party_id)` — `board_attendance.person_id`,
`motions.mover_person_id`/`second_person_id`, `board_votes.person_id`, and `candidates.person_id`
(renamed from `board_person_id`) — and drops the parallel `motions.mover_owner_id`/`second_owner_id`
pair outright, since nothing ever wrote it (phase 3b). In the same file, and for an unrelated
reason, `ballot_choices.candidate_id` moves from `ON DELETE RESTRICT` to `NO ACTION`: RESTRICT is
checked immediately while NO ACTION is checked at end-of-statement, and only the latter makes an
election delete — which cascades to `candidates` and `ballot_choices` alike — independent of which
cascade SQLite happens to run first; a bare candidate delete is refused identically either way. All
five rebuilt tables use the `__new`-copy-and-rename dance (the `0024`/`0026` precedent, not `0027`'s
DROP+CREATE), since they are only provably empty in production, not everywhere; `motions` is
rebuilt last, since six FKs point into it. A legacy identity that cannot be mapped to a
`people.party_id` (the backfill's `derivedId` mapping is a JS digest SQL cannot compute) is dropped
rather than invented — nullable columns become `NULL`, and the two `NOT NULL` columns
(`board_attendance.person_id`, `board_votes.person_id`) drop the row — though this measured a no-op
in the strictest sense, since all five tables held 0 rows in production on 2026-08-20. Migration
`0029` (#248 part 2 of 2) does the same for the `owners` half, rebuilding `member_attendance`,
`member_votes`, `ballots`, and `proxies` so
`represented_by_person_id`/`cast_by_person_id`/`grantor_person_id`/`holder_person_id` reference
`people(party_id)`, each keeping its ON DELETE action bit-for-bit. `proxies` is rebuilt LAST, since
the other three cite it — the same reasoning that put `motions` last in `0028` — and their
`proxy_id` FKs are recreated deliberately actionless (see the `proxies` paragraph above). It
follows `0028`'s identity rule: a value is carried over only when it already resolves to a Person,
so the four nullable columns become `NULL` and `proxies.grantor_person_id`, being `NOT NULL`, drops
the row rather than fabricate a grantor — and each citing table's rebuild nulls any `proxy_id`
whose proxy row this same file drops, so no dangling reference survives the deferred FK check. See
the ADR
0022
paragraph above for what these tables and views are and what now reads them (the phase-2 shadow
layer, the board-only roster-preview panel, the operator write freeze, `cutover-mode.ts`, and — as
of phase 3b/3c/3d — the roster/board-service/access/person-link/verification/review-flag routes;
legacy authorization itself still reads none of the roster tables). Migrations `0016`
through `0022` were verified as applied to production on 2026-08-14, against the `d1_migrations`
ledger rather than assumed. Migrations `0023` through `0027` were applied to production manually
(`db:migrate:remote`) on 2026-08-17, after sitting unapplied for days under deployed v0.12.0 code —
the observation that falsified the deploys-apply-migrations doctrine below. Migration `0028` was applied to
production manually (`db:migrate:remote`) on 2026-08-21, immediately after the change that needs it
merged — the deployment-ordering hazard immediately below is why it could not wait. Migration
`0029` carries the same hazard and the same rule: apply it before or with its deploy.

**Committed migrations do NOT reach production on their own.** Deploys never apply D1
migrations. This doctrine previously said the opposite, inferred from `0016`-`0022` landing at one
timestamp shortly after their merge; that inference was falsified on 2026-08-17, when deploys had
succeeded daily while migrations `0023`-`0027` sat unapplied under v0.12.0 code — the earlier
observation was almost certainly a manual catch-up misread as the deploy's work. The real path is
the operator running `npm run db:migrate:remote`, which applies any unapplied files and is safe to
re-run (Wrangler tracks applied files in D1 and skips them).

**Migrations `0028` and `0029` break the safe-in-either-order rule the next paragraph describes,
and are the first two migrations in this project to do so.** Every migration through `0027` was written so that code
merged before or after its application worked against either schema shape, which is exactly why
merged code running ahead of the production schema for days (as `0023`-`0027` just did) is
tolerable. `0028` is not that: it renames `candidates.board_person_id` to `candidates.person_id` and
repoints `board_attendance.person_id`/`board_votes.person_id`/`motions.mover_person_id`/
`motions.second_person_id` off `board_people` onto `people(party_id)`, and the merged application
code (`GET /api/admin/meetings?roster=people`, `/api/admin/candidates`,
`assembleMeetingDetail` in `src/server/content/reads.ts`) reads and writes only the new column and
table. That code did deploy ahead of the migration — Workers Builds deploys on merge — and the admin
meeting-record people picker and the candidate-link write path failed against the still-legacy
schema until the operator ran `npm run db:migrate:remote` minutes later, on 2026-08-21. The
standing rule this leaves behind: a migration of this kind is applied before or together with its
change's deploy, never on the otherwise safe any-time-before-the-next-freeze schedule the rest of
this section describes.

`0029` is the second of the kind and was written knowing it: it renames four columns the merged
code reads and writes (`represented_by_owner_id` → `represented_by_person_id`, both
`cast_by_owner_id` → `cast_by_person_id`, `grantor_owner_id` → `grantor_person_id`,
`holder_owner_id` → `holder_person_id`), so the member attendance, member vote, ballot, and proxy
surfaces fail against the pre-`0029` schema exactly as the meeting-record picker did against the
pre-`0028` one. Treat the merge and `db:migrate:remote` as ONE operator step, ideally under the
write freeze. Phase 4's `properties` → `lots` rename is the next of this kind.

Two consequences worth internalising, migrations `0028` and `0029` aside. Merged code can run **ahead of the
production schema** for
days, so a schema change and the code that depends on it must be safe in either order — which is
the whole reason ADR 0022 phase 1 is behaviorally inert. And schema parity is a **standing
pre-freeze check**: before any write freeze, backfill, or other schema-dependent operation,
`npx wrangler d1 migrations list DATABASE --remote` must list nothing unapplied.

Migrations are applied locally with `npm run db:migrate:local` via
Wrangler, which tracks applied files in D1 independently of Drizzle's `meta/` snapshots. `0002` and
`0003` were hand-authored SQL, but the Drizzle snapshot history has been reconciled through `0003`,
so `npm run db:generate` should diff cleanly for future changes.

**Glossary — "board" names three separate things.** They are deliberately distinct; conflating them
in code or copy is the mistake this table exists to prevent. Use these words in that sense.

| Term              | Is                                                                     | Lives in                                                                                                                                    | Has history?                                                                                   |
| ----------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **board admin**   | An access level. Grants admin writes _and_ the top content tier.       | `access_grants` (a live `board` or `system_admin` grant) since the phase 3f flip; `user.role = 'board'` is now only its write-behind mirror | The grant has an interval, so ending one is recorded; the mirror column is current-state only. |
| **board member**  | A person who serves on the board.                                      | `board_people`                                                                                                                              | Yes — the record is the point.                                                                 |
| **office / term** | One period of service, optionally with a title (President, Treasurer). | `board_terms`                                                                                                                               | Yes — a person may hold several, with gaps.                                                    |

Sign-in access still has its own panel — **Board access (legacy)** (`BoardAccessManager`) — and
neither sense ever writes the other's data. The legacy roster panel (`BoardPanel`) and its routes
were retired by phase 3b (#218): board service is now recorded in `board_service_terms` through
`/api/admin/board-service`, and the writable Board surface is the phase-3e (#221) **Board** panel
(`BoardServicePanel`). The meeting and elections records no longer name a `board_people` identity
at all — #248 (part 1 of 2, an ADR 0022 phase 4 precondition) repointed `board_attendance`,
`board_votes`, `motions`' mover/second, and `candidates` onto the party roster's Person, so
attendance, roll call, mover/second, and a candidate's optional resident link now name whoever is
on the roster, not specifically a **board member** in this table's sense; `board_people` survives
only as the still-independent record of service that row describes, referenced by `board_terms`
and (for now) nothing else in a table phase 4 keeps. A board member
need not be a board admin, and a board admin need not be a board member. The content
visibility tier `board` is a fourth use of the word and follows the access sense: it means "visible
to a board admin". See [ADR 0012](./docs/adr/0012-board-record-as-structured-rows.md) for why the
record is independent of `user` rows.

**Roles and access.** Roles are `visitor`, `homeowner`, and `board`; content visibility tiers are
`public`, `homeowner`, and `board`. Access is enforced server-side and fail-closed: anonymous users
resolve to visitor, unknown states resolve to the most restrictive behavior. `users.role` is still
a column on the user record, but since the ADR 0022 phase 3f flip it is a **write-behind mirror,
not the authority**: production runs `cutover_mode = derived`, so a caller's capabilities and
content tier are derived per request from the party roster — Person Link, Ownerships and
Representations, Board Terms, and Access Grants — and `users.role` is written only to keep the
legacy read model and Better Auth sessions coherent. It is read for authorization nowhere outside
`context.ts`'s `legacy` branch (pinned by `test/unit/authz-legacy-role.test.ts`).

The board-only API is gated in **two** places, deliberately. `src/middleware.ts` rejects
`/api/admin/*` before the route runs (503 while the operator write freeze is on for a mutating
verb, 401 anonymous, 403 authenticated non-board), and every handler under `src/pages/api/admin/`
additionally opens with `requireBoard`, which checks the freeze first. Admin reads stay live during
a freeze; only POST/PUT/PATCH/DELETE are refused. The per-route call is the
**enforced and tested** layer — the Workers test pool invokes handlers directly and never runs
middleware — while the middleware gate is the production backstop for a route shipped without its
guard. `test/server/admin-routes-all-gated.test.ts` enumerates every admin route module and asserts
each exported verb rejects an anonymous caller, so a new endpoint cannot ship ungated.
`test/server/permission-matrix.test.ts` goes further, asserting every `/api/admin/*`,
`/api/member/*`, and `/api/vote` route's DECLARED capability against every caller class —
including a board caller who owns no Lot and an authenticated caller linked to nothing — rather
than only that anonymous is refused; per #206 it outlives the migration rather than being retired
at the flip. Do not remove
the per-route guards in favor of the middleware: that would leave the behavior untested. See
[ADR 0013](./docs/adr/0013-admin-api-gated-in-middleware.md). `/api/bootstrap/board` sits outside the
gated prefix on purpose — it is the fail-closed first-System-Administrator bootstrap and must stay
reachable, and for the same reason it is one of the write freeze's two exemptions.

**The write freeze inverts that enumeration, deliberately.** The auth gates above name the surfaces
they protect, which is why `admin-routes-all-gated.test.ts` has to exist — coverage is a function of
what somebody remembered to list. `freezePolicyFor` runs the other way: every mutation is frozen
unless its path is named live, so a route added tomorrow is covered before anyone thinks about it,
and `test/unit/freeze-coverage.test.ts` fails if a mutating route escapes without being declared in
two files. When adding a route, you must remember its auth guard; you do not have to remember the
freeze. Site sign-in access for board admins is managed in the admin app's
**Board access (legacy)** panel — re-pointed onto `cutover_mode` by ADR 0022 phase 3e (#221; see the
board-handoff entry under **HTTP endpoints** above): a board admin can promote another account to
`board` and demote a board admin, except the last remaining board admin cannot be demoted. A board
admin cannot escalate their own access beyond `board`. This is distinct from the admin app's
phase-3e **Board** panel (`BoardServicePanel`), which records who serves on the board and their
terms of service (`board_service_terms`/`board_office_assignments`, see **Data model** above) and is
deliberately independent of `user` rows — promoting or demoting a site account has no effect on the
roster, and a person can be recorded there with no site login at all; the legacy
`board_people`/`board_terms` shape it replaces for new writes is described in
[ADR 0012](./docs/adr/0012-board-record-as-structured-rows.md). The first System Administrator
account is bootstrapped through the permanent fail-closed `POST /api/bootstrap/board` endpoint
(rewritten by #219; see the ADR 0022 phase 3c HTTP-endpoints entry above), which self-disables once
its `system_admin_bootstrap` singleton is consumed — not merely once a board account exists, since
an account can also reach `board` by ordinary promotion; guard and batch logic live in
`src/server/roster/bootstrap.ts`. The retired `src/server/auth/seed-board.ts` and
`scripts/seed-board.ts` (the old BOARD_EMAIL/BOARD_PASSWORD/BOARD_NAME signup path) are deleted.
These role changes are direct D1 writes under `legacy`, and Access Grant writes under `derived`,
never Better Auth admin API calls. The Better Auth admin plugin's impersonation, ban, and set-role
endpoints are not granted to board sessions; see `src/server/auth/permissions.ts`.

The official-mode homeowner-write API repeats that two-layer pattern. Middleware gates
`/api/member/*`, and every handler independently opens with `requireMemberApi`; mode off is checked
first and returns `404`, then the operator write freeze returns `503` for every verb on this
surface (it has no read-only half worth keeping live), then anonymous is `401` and an authenticated
visitor is `403`. `test/server/member-routes-all-gated.test.ts` enumerates the member route
modules. Successful calls
are scoped again through `AuthContext.propertyIds` (and active roster rows where identity matters),
so homeowner role alone never grants access to an arbitrary lot. See
[ADR 0019](./docs/adr/0019-homeowner-writes-official-mode-gate.md).

The live-voting API has the same middleware-plus-handler structure but a stricter fixed route-gate
order: both feature flags (`404`), the operator write freeze (`503`), exact required-Origin
equality (`403`), JSON media type (`415`), session (`401`), then homeowner rank (`403`). The freeze
sits immediately after the feature flags and before the header/session checks — it is a statement
about the server, not the request, so no cast can land during the flip's authoritative backfill.
`test/server/member-routes-all-gated.test.ts` includes
`/api/vote`, `voting-guards.test.ts` pins the flags/Origin/media-type/session/role order, and
`write-freeze.test.ts` pins the freeze's position ahead of the Origin and media-type checks. A successful
preflight still grants no general lot authority: `voting.ts` repeats the caller's active own-lot or
occasion-scoped held-proxy predicate inside the insert, together with visibility, frozen
eligibility, open state, both feature flags, and duplicate exclusion. `voting-reads.ts` applies the
same caller and tier boundary to its server-only open-voting projection.

## Testing Guidelines

Add or update tests alongside behavior changes. Use `npm test` for jsdom-based unit and component
tests, and `npm run test:server` for Cloudflare Worker or D1 behavior. Test names should describe
visible behavior, for example `shows an empty state`. Prefer small focused tests over broad
snapshots unless the UI is intentionally static.

`npm test` uses `vitest.config.ts` and covers files under `test/unit/**` plus component
`*.test.tsx` files. `npm run test:server` uses `@cloudflare/vitest-pool-workers` with
`vitest.workers.config.ts` for files under `test/server/**`; these tests import `{ env,
applyD1Migrations }` from `cloudflare:test` and mostly invoke handlers directly. Pool 0.21 takes
Miniflare's config-based `WorkerOptions` through `cloudflareTest({ miniflare: ... })`; supported
overrides there merge over `wrangler.test.toml`. Keep the config's `es-module-lexer` alias and its
Astro Vite plugin graph: it merges Astro's plugins (minus its Cloudflare adapter plugin, which
collides with `cloudflareTest`'s own Cloudflare Vite plugin) into the Workers test pool, so `.astro`
pages can also be rendered directly through the Astro Container API inside the real Workers
runtime — see `test/server/meeting-pages.test.ts`. A shared `isCloudflarePlugin` predicate in the new
`vitest.shared.ts` identifies that plugin for both `vitest.config.ts` (which strips it, since it's
incompatible with the jsdom/node test environments) and `vitest.workers.config.ts` (which strips
Astro's copy in favor of `cloudflareTest`'s own), so the two configs can't drift on what counts as
"a Cloudflare plugin." This `test/unit` vs. `test/server` split matches the type-checking split
described under Commands above: `test/unit/**` is checked by the Node-side `tsconfig.node.json`,
while `test/server/**` — which imports `cloudflare:test` — stays in the Workers-side
`tsconfig.json`. `src/worker.ts` itself cannot be imported by the Workers test pool: it imports
Astro's Cloudflare handler, which resolves a build-time virtual module. That's why the cron body
lives in `src/server/scheduled.ts` instead — `test/unit/scheduled.test.ts` exercises
`runScheduledJobs` directly, and `test/unit/worker.test.ts` only asserts that `src/worker.ts`
delegates to it.

## Deploy

```bash
npm run build
npx wrangler deploy -c dist/server/wrangler.json
```

The root `wrangler.toml` uses `main = "src/worker.ts"` so the Worker can expose both Astro SSR
handling and the daily `0 7 * * *` scheduled trigger. `src/worker.ts` is a thin adapter — `fetch`
delegates to Astro's `handle`, `scheduled` delegates to `src/server/scheduled.ts`'s
`runScheduledJobs(env)`, which runs the verification-state retention sweep and the ADR 0022
invariant drift check (`runInvariants`, see the invariant-gate paragraph above) independently, so a
broken sweep can't hide an invariant violation or vice versa, and throws if either failed so a
partial-success invocation still shows red in the dashboard. Manual deploys still use the
adapter-emitted `dist/server/wrangler.json`.

## Commit & Pull Request Guidelines

Recent commits use short, imperative summaries, often lowercase, such as
`fix forgot password reset flow`. Keep commit subjects concise and action-oriented. PRs should
include a clear description, link related issues when applicable, and mention the commands run
locally. If a change affects UI or admin workflows, include screenshots or a short note describing
the user-visible result.

## Security & Configuration Tips

Do not commit real roster data, secrets, or production credentials. Keep environment examples in
`.env.example` and `.dev.vars.example`. Schema changes should go through Drizzle migrations, and
access control must stay server-side and fail closed.

Do not commit implementation scratchpads, security reviews, import artifacts, resident-data-derived
files, or detailed operational runbooks. Keep those under `private/`; public docs should describe
supported architecture and workflows, not exploit analysis, private execution notes, or
resident-data handling details.

## Agents & Docs Automation

Project subagents live in `.claude/agents/`: `docs-updater` keeps `AGENTS.md`, `README.md`,
`SETUP.md`, `SECURITY.md`, and `CHANGELOG.md` in sync with the code; `code-reviewer` reviews diffs
against tier-enforcement, two-layer API gating (`/api/admin`, `/api/member`, `/api/vote`),
transition-only fields, ballot secrecy, numeric-coercion, D1 write-integrity, and Drizzle FK-trap
rules before merging.

**One source of truth, two CLIs.** `.agents/skills` is the authored source for complete skill
directories. Run `npm run format` before `npm run sync:agents`; the latter regenerates
`.claude/skills` for Claude Code and `.codex/agents` from authored `.claude/agents`. Never edit
generated trees or reintroduce skill symlinks: with `core.symlinks=false`, Git stages linked
contents as duplicate files. Each authored Claude custom agent is rendered as a Codex custom-agent
TOML file, preserving its name, description, and developer instructions. The `PostToolUse` hook in
`.claude/settings.json` re-syncs after authored inputs change, and CI plus `/ship` run
`npm run sync:agents -- --check` to reject generated-tree drift. See
[ADR 0021](./docs/adr/0021-authored-agent-skills-generate-tool-specific-trees.md).

The user-invokable `ship` skill (`.claude/skills/ship/`) takes a branch from code-complete to an
open PR: it classifies the complete branch diff as a major, minor, or build release, applies any
major/minor package-version change idempotently, invokes `docs-updater` scoped to that branch's
diff, writes the `CHANGELOG.md` section for the version `scripts/next-version.sh` predicts (see the
Changelog Version workflow above), runs the fast
`sync:agents -- --check`/`format:check`/`lint`/`lint:coercions`/`check` gates, then pushes and opens or
updates the PR.
Documentation is kept in sync at ship time through that `docs-updater` pass, so there is no
per-turn docs hook.

The user-invokable `end-session` skill (`.claude/skills/end-session/`) closes out a work session
across the four stores that live outside the tracked tree and therefore rot silently: project
memory, GitHub issues, `private/` (see **Security & Configuration Tips** below), and the local
workspace — uncommitted or untracked strays, stale `.worktrees/` and scratch directories, and
generated-tree drift (`sync:agents -- --check`, `format:check`, `types:worker:check`). It is a
maintainer routine, not a build step: it never pushes, merges, or opens PRs (that is `/ship`),
never rewrites the docs `docs-updater` owns, never runs a remote-D1 write, and shows every deletion
as a list before acting.

## Agent skills

### Issue tracker

Issues live in GitHub Issues at `jwh3times/valleys-at-ashebrook-hoa`, managed with the `gh` CLI. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its role name. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root plus `docs/adr/`. See
`docs/agents/domain.md`.
