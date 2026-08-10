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
npm run check             # Astro + TypeScript type check
npm test                  # jsdom component/unit tests (Vitest)
npm run test:watch        # Vitest in watch mode
npm run test:server       # Worker/D1 integration tests (vitest-pool-workers)
npm run format            # Prettier write
npm run format:check      # Prettier check, enforced by CI
npm run sync:agents       # regenerate the Claude skills and Codex agents
npm run sync:agents -- --check # fail if generated agent trees drifted, enforced by CI
npm run lint:coercions    # fail on `Number(x) || <default>`, enforced by CI
npm run db:generate       # generate Drizzle migration files
npm run db:migrate:local  # apply migrations to local D1 with Wrangler
npm run db:migrate:remote # apply migrations to the live D1 database
npm run auth:generate     # regenerate Better Auth schema from config
npm run roster:import     # import owner roster for homeowner verification
npm run docs:import       # generate documents-manifest.json; see SETUP.md
npm run docs:dedupe       # dry-run document duplicate report; see SETUP.md
npm run corpus:import     # clean-replace R2/D1 doc + rag-twin corpus import; see SETUP.md §7
npm run ocr:scanned       # OCR scanned/"unsupported" PDF uploads into search twins; see SETUP.md
npm run deploy            # build and deploy with Wrangler
```

Run a single test file or test name with:

```bash
npx vitest run test/unit/example.test.ts
npx vitest run -t "shows an empty message"
npx vitest run --config vitest.workers.config.ts test/server/api.test.ts
```

CI (`.github/workflows/build.yml`) runs `format:check`, `sync:agents -- --check`, `lint:coercions`,
`check`, `test`, `test:server`, then `build` on every PR and push to `main`; run the relevant checks
locally before pushing. On every
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
  `liveVotingEnabled` (`404`), exact equality of the required `Origin` header with
  `new URL(request.url).origin` (`403`), `application/json` media type (`415`), authenticated
  session (`401`), then `homeowner`-or-higher role (`403`). Only then are the action and resource
  resolved. Out-of-tier or unknown occasions are masked as `404`; own-lot or occasion-scoped
  held-proxy authority, frozen-snapshot eligibility and weight, open state, both feature flags, and
  one cast per lot are re-checked inside the mutation SQL. Election turnout and identity-unlinked
  retained choices are a single checked D1 batch, and a race with close, pause, authority change,
  or another cast returns `409` without a partial write. Conducted ballots are final: supported
  reads expose only `hasCast`, never choices for display or replacement. Turning either flag off
  pauses new opens and casts without deleting lifecycle state, snapshots, turnout, votes, or
  choices; an occasion still open resumes when both flags return true.
- Board-only writes: `/api/admin/{documents,announcements,dues,site}`,
  `/api/admin/{properties,owners,members}`, and `/api/admin/{board-people,board-terms}`.
  `GET /api/admin/board-people` returns board people with their terms nested, mirroring the
  properties/owners read. Deleting a board person who has a term of service on record returns
  `409` from `DELETE /api/admin/board-people` — ending the term is the intended action instead —
  and a term's `person_id` cannot be reassigned via `PATCH /api/admin/board-terms`; `DELETE
/api/admin/board-terms` itself returns `409` for a term created by certifying an election
  (`board_terms.election_id` set) — uncertify that election instead of deleting the term directly.
  The same board-people `DELETE` also returns `409` if the person appears anywhere in the meeting
  record (attendance, as a motion's mover/second, or a roll-call vote) or holds a candidacy
  (`candidates.board_person_id`), pre-checking all six RESTRICT foreign keys so the response is
  deterministic rather than a raw D1 FK error.
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
  flips `status` (`approve` returns `409` if already approved or if a child motion vote is open,
  with the open-vote check in the conditional status update so approval cannot win that race;
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
  covers an election held at that meeting; a standalone election accepts only its own) — and an
  entry carrying both `proxyId` and `representedByOwnerId`/`castByOwnerId` is `400`, since who acted
  lives on the canonical proxy row, never beside it. All verbs on both routes are
  `requireBoard`-gated.
- Board-only resolutions book (standing rules the board adopts; a durable record — amending one
  creates a **new** resolution that supersedes the old, forming a walkable chain; see
  [ADR 0016](./docs/adr/0016-resolutions-supersession-chain.md)): `/api/admin/resolutions` supports
  `GET`/`POST`/`PATCH`/`DELETE`, all `requireBoard`-gated. `GET` lists every resolution including
  drafts, with no tier filter. `POST` creates a `draft` (`201 { id }`); with
  `{ action: 'adopt', id, effectiveDate, motionId? }` moves a `draft` to `in_force`; with
  `{ action: 'supersede', id, supersedesId, effectiveDate, motionId? }` puts the (draft) resolution
  `id` in force and marks `supersedesId` `superseded`, both writes in one `db.batch()`; with
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
  `certify` takes per-winner
  `{candidateId, termStart, termEnd?, title?}` and, in one `db.batch()`, creates `board_people`
  rows for winners who lack one, backfills `candidates.board_person_id`, opens one `board_terms`
  row per winner carrying `election_id`, sets `candidates.won`, and moves the election to
  `certified`; its first statement reserves the closed election and re-checks the existing-person
  open-term invariant at the mutation boundary, so concurrent certifications cannot open two terms
  for the same person. It returns `409` for a winner who already holds an open term and `400` for
  two winners resolving to the same person. `uncertify` reverses it, deleting the terms it created but
  never the `board_people` rows. `DELETE` removes only a `draft` election; a `certified` election
  cannot be voided directly (`void` returns `409` — uncertify first). `/api/admin/candidates`
  supports `POST`/`PATCH`/`DELETE`, `requireBoard`-gated; `sequence` is server-assigned, candidates
  can be added or deleted only while the election is a draft, and conducted candidates become
  immutable after open except that a not-yet-withdrawn candidate may be withdrawn once while open.
  The homeowner cast path is `POST /api/vote`, reached only through the feature-gated `/vote` page
  for verified callers. The page renders selection-free receipts that contain only the item title
  and lot address. Its labeled review modal summarizes the pending selection and provenance, moves
  and traps focus, supports Escape/cancel with focus restoration, and disables every background
  voting control. The admin Elections panel separates draft/open Active records from
  closed/certified/void History, exposes conducted Open/Close and count/weight turnout monitoring,
  and never exposes a live conducted tally or editable conducted ballot/choice rows.
- Board-only complete proxies record (including paper proxies entered by the board and online
  grants created by homeowners — one owner authorising one named holder to act for one lot at
  exactly one meeting or election; see
  [ADR 0018](./docs/adr/0018-proxies-record-via-proxy-consolidation.md)): `/api/admin/proxies`
  supports `GET`/`POST`/`PATCH`/`DELETE`, all `requireBoard`-gated. `GET` returns every proxy with
  its property address and grantor/holder names resolved — the same full-detail-on-list shape as
  `/api/admin/resolutions` and `/api/admin/elections`; the member sibling described below is
  lot-scoped rather than a complete register. `POST` returns `201 { id }` with a readable `404` for
  each of the five FKs it
  can write (`propertyId`, `grantorOwnerId`, `holderOwnerId`, `meetingId`, `electionId`), `400` if
  the grantor doesn't belong to the given property, `400` if grantor and holder resolve to the same
  owner, `409` if `meetingId` resolves to a board-body meeting ("Proxies apply to member meetings —
  this is a board meeting" — proxies are cited only by member attendance/votes/ballots, so a
  board-meeting proxy could never be used; election occasions are unaffected), and `409` on a
  duplicate occasion (`proxies_property_meeting_unq`/`proxies_property_election_unq`, "This lot
  already has a proxy for this occasion"). `PATCH`
  allow-lists `holderName`/`holderOwnerId`/`grantorOwnerId` — `propertyId`, `meetingId`, and
  `electionId` are rejected on key presence by `normalizeProxyInput`, since moving a proxy to
  another lot or occasion is a different proxy, not an edit — and re-checks grantor-≠-holder against
  the effective stored-plus-payload values. `DELETE` returns `409` naming which of `attendance`,
  `votes`, or `ballots` still cites the proxy ("Proxy is in use (…) — remove those records first"),
  else deletes; deletion is the entire revocation model, there is no `revoked_at`.
- Official-mode homeowner proxies: `/api/member/proxies` supports `GET`/`POST`/`DELETE`, and
  `/api/member/owner-lookup` supports `POST`. Every handler calls `requireMemberApi`, while
  middleware independently gates `/api/member/*`: `officialMode` off returns `404`, then anonymous
  is `401` and callers below `homeowner` are `403`; board callers pass the rank check. `GET` returns
  only proxies granted for the caller's verified lots plus proxies naming an active owner of those
  lots as holder. Own-lot rows retain occasion title/date even above the caller's tier; held rows
  for another lot redact those fields above tier. `POST` requires one caller-controlled lot, an
  active owner of that lot selected as grantor, a different active owner as holder, and exactly one
  visible upcoming member meeting or non-terminal election. Both the picker read and write path
  expose only minimal scheduled-occasion metadata at the occasion's visibility tier even while its
  record remains draft; dates use the `America/New_York` association day. `DELETE` is limited to
  the caller's lots and refuses both past occasions and proxies already cited by attendance, votes,
  or ballots. The address lookup resolves one typed active-property address to active owner names
  and opaque IDs only (never contact data); verified homeowners can repeat such lookups, an accepted
  disclosure documented with the lot-control/self-asserted-owner trust model in
  [ADR 0019](./docs/adr/0019-homeowner-writes-official-mode-gate.md).
- Board-only duplicate review: `GET /api/admin/duplicates` lazy-backfills document hashes from R2
  and returns exact or near groups, each member annotated with a `verifiedAt` timestamp; groups
  where every member is already kept-verified are hidden until a matching upload resets one.
  `POST /api/admin/duplicates` takes `{ action: 'resolve', keepIds, deleteIds }`, deletes each
  `deleteIds` document (D1 row + R2 object), and marks the surviving `keepIds` as kept-verified;
  `keepIds` must be non-empty and disjoint from `deleteIds`, while `deleteIds` may be empty for a
  keep-all/mark-reviewed resolution.
- Board handoff: `GET /api/admin/roles` lists current board; `POST /api/admin/roles` accepts
  `{ action: 'promote', email }` or `{ action: 'demote', userId }` and returns 409 when attempting
  to demote the last board member.
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
- Homeowner verification: `/api/verify/{request,confirm}`.
- First-board bootstrap: `POST /api/bootstrap/board`, which is fail-closed, self-disables once a
  board account exists, and requires bootstrap secret/config values.
- Better Auth handler: `/api/auth/[...all]`.

**Client helpers.**

- `src/lib/content.ts` handles public reads from `/api/content/*` endpoints.
- `src/lib/member.ts` handles the official-mode homeowner proxy API: `fetchMyProxies`,
  `grantProxy`, `revokeProxy`, and `lookupOwners`, with the write/lookup request shapes kept beside
  those helpers.
- `src/lib/admin.ts` handles board writes to `/api/admin/*` endpoints, typed document duplicate
  errors, duplicate-resolution helpers, saved-report list/fetch/delete helpers (`fetchReports`,
  `fetchReport`, `deleteReport`), board roster helpers (`fetchBoardPeople`, `saveBoardPerson`,
  `deleteBoardPerson`, `saveBoardTerm`, `deleteBoardTerm`), meeting-record helpers
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
  `VotingLot`, `VotingOwnerOption`, `VotingProxyOption`), cast inputs/results (`VoteAction`,
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
- `authz/`: `getAuthContext`, `resolveAuthContext` (middleware-first caller resolution with a
  fail-closed fallback), `requireRole`, `requireBoard`, `requireMemberApi` (official-mode-first
  homeowner-write gate), `requireVotingApi` (feature flags, exact Origin, JSON media type, session,
  then homeowner role, in that order), per-property access checks, and Turnstile checks.
- `content/`: `visibility.ts` (`tierAllows`, `visibleTiers`), `reads.ts` (per-role reads for
  announcements, documents, and now the meeting record — `fetchMeetingsFor`/`fetchMeetingFor`
  filter `status = 'approved'` UNCONDITIONALLY, including for a board caller, so a draft meeting is
  reachable only through the board-only `fetchAdminMeetings`/`fetchAdminMeeting`; a shared
  `assembleMeetingDetail` builds the attendance/motions/roll-call body for both pairs and carries no
  status or tier logic itself — see [ADR 0014](./docs/adr/0014-meeting-record-status-gate.md).
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
  `setMemberVotes`, and `setBallots` each call before writing a `proxyId`), `voting-state.ts`
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
  with its property address and grantor/holder owner names resolved, the same
  full-detail-on-list shape as `fetchAdminResolutions`/`fetchAdminElections`. Homeowner proxy reads
  use `fetchUpcomingOccasionsFor` (minimal tier-filtered scheduled-event metadata regardless of
  draft status), `fetchMemberLots` (the caller's active lots and active owners), and
  `fetchMemberProxies` (lot-scoped granted/held lists with the ADR 0019 own-lot occasion exception
  and held-row tier redaction); these are not a public or complete tier-gated proxy register.
- `db/`: Drizzle `schema.ts`, `auth-schema.ts`, `client.ts` (`getDb(env)`), and migrations.
- `roster/` and `verification/`: homeowner verification support.
- `http.ts`: `readJson` and `stringField` request-body helpers for admin writes.
- `ai/`: the board-only document assistant and report generator — `search.ts` (`retrieve`,
  Cloudflare AI Search/autorag retrieval), `pii.ts` (`buildPseudonymizer`, a reversible
  roster-based PII pseudonymizer with streaming de-anonymization), `sources.ts` (`toSources` maps
  retrieved chunks back to real D1 document rows for citations; `docIdFromFolder` extracts a
  document's uuid from either R2 key shape, `documents/<uuid>/…` or `rag/<uuid>.md`), `context.ts`
  (`buildExcerptContext`, shared by the assistant and the report generator: resolves chunks to real
  documents, drops orphan/empty chunks, and builds the pseudonymized, per-document
  `[Source N]`-numbered excerpt text), `anthropic.ts` (`getAnthropic`, Anthropic client + config
  guard), `assistant.ts` (`answer`, `loadRosterEntries`, and the shared `claudeTextStream`/
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
(default `board`), approval provenance `approved_at`/`approved_by`/`approved_by_motion_id`, and
`created_by`; `board_attendance` is one present/absent row per meeting per `board_people` row,
unique per pair; `motions` records one motion per meeting with a server-assigned `sequence` unique
per meeting, board mover/second referencing `board_people` on delete-restrict, plus nullable
`mover_owner_id`/`second_owner_id` referencing `owners` — pre-placed for a later phase; nothing
writes them yet, and the mover/second pickers are hidden on member meetings — and a board-entered
`outcome` (`passed`/`failed`/`withdrawn`/`tabled`). Member motions also carry `voting_state`
(`none`/`open`/`closed`) and a monotonic `voting_revision`: every open, close, and successful
member vote-set replacement advances the revision, so a stale correction cannot overwrite an
intervening live session even when the lifecycle state returns to `closed`; `motion_eligibility`
is unique per `(motion_id, property_id)`, cascades with its motion, restricts property deletion,
and freezes each active property's non-negative weight at first open for unchanged reuse on reopen.
`board_votes` is one roll-call vote per motion per `board_people` row (`choice`:
`yes`/`no`/`abstain`/`recused`/`absent`), unique per pair;
`member_attendance` is one present/absent row per meeting per `properties` row, unique per pair,
with nullable `represented_by_owner_id` and a nullable `proxy_id` referencing `proxies` (see below;
carries no `ON DELETE` action, deliberately); `member_votes` is one vote per
motion per `properties` row — that uniqueness is what enforces one vote per lot — with nullable
`cast_by_owner_id` and the same nullable, actionless `proxy_id`, a `weight` column snapshotting
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
member-meeting vote and is rejected at zero, see ADR 0015 — `owners`, `user_property_links`,
`property_verifications`, `manual_approval_queue`), and Better Auth tables (`user`, `session`,
`account`, `verification`).

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
`board_person_id` referencing `board_people` on delete-restrict (backfilled by `certify` for a
winner who had none, so a returning board member keeps one identity across terms per ADR 0012), a
server-assigned `sequence` unique per election, a nullable `votes` (`NULL` = not yet recorded,
`0` = recorded as zero — and always `NULL` while a conducted election is open), `won`, and
`withdrawn`; it deliberately carries no `updated_at`. `ballots` references `elections` on
delete-cascade and `properties` on delete-restrict, is unique per `(election_id, property_id)`, and
records only turnout: a `weight` snapshot, nullable actionless `proxy_id`, nullable
`cast_by_owner_id` referencing `owners` on delete-set-null, and `recorded_at`.
`ballot_choices` is the identity-unlinked retained digital ballot box: `id`, `election_id` on
delete-cascade, `candidate_id` on delete-restrict, and non-negative `weight`, indexed only by
election. It deliberately has no ballot/property/owner/proxy/caster/timestamp/shared-receipt field
or other explicit identity/correlation column; none may be added, and supported reads never join a
choice to a turnout row. This is not mathematical anonymity: because turnout and choice rows retain
the same snapshotted weight, a rare or unique weight may identify or narrow a property's
selections, while SQLite insertion order and D1 Time Travel add temporal inference risk. A
conducted `POST /api/vote` cast writes the per-lot turnout row and every independent choice row in
one checked D1 batch, taking both weights from `election_eligibility`. The supported caller read
returns only `hasCast`, so a conducted ballot is final; conducted close derives final candidate
totals from the retained rows.
`board_terms` also carries a nullable `election_id` referencing `elections` on delete-set-null,
recording which election produced that term; `certify` opens it, `uncertify` deletes it, and
`DELETE /api/admin/board-terms` refuses to delete a term with one set.

`proxies` (the proxies record — either entered from paper by the board or granted online by a
homeowner for a lot they control, per
[ADR 0018](./docs/adr/0018-proxies-record-via-proxy-consolidation.md) and
[ADR 0019](./docs/adr/0019-homeowner-writes-official-mode-gate.md)): one owner
(`grantor_owner_id`, referencing `owners` on delete-restrict) authorising one named holder
(`holder_name`, required — a holder need not be an owner) to act for one lot (`property_id`,
referencing `properties` on delete-restrict) at exactly one occasion, a nullable `meeting_id` or
`election_id` (each referencing its table on delete-cascade), never both, never neither — enforced
by a schema `CHECK` (`proxies_one_occasion`) rather than left to application code alone, so it holds
even against a direct write that bypasses the route. A unique index per occasion kind
(`proxies_property_meeting_unq`, `proxies_property_election_unq`) enforces one proxy per lot per
occasion, the same NULLs-are-distinct trick `resolutions_supersedes_unq` already relies on. An
optional `holder_owner_id` (referencing `owners` on delete-set-null) is recorded when the holder
happens to be an owner, plus `created_by`/`created_at`/`updated_at`. `member_attendance.proxy_id`,
`member_votes.proxy_id`, and `ballots.proxy_id` each reference `proxies.id` but carry no `ON DELETE`
action at all — they were added by `ALTER TABLE` against tables that predate this feature, and
drizzle-kit silently drops any `ON DELETE` action on an ALTER-added FK column, the same trap already
on record for `properties.vote_weight` and `board_terms.election_id`; `proxy-schema.test.ts` pins
that the generated SQL carries none. Because that FK can't enforce a refusal itself, `DELETE
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
compare-and-swap token. Migrations after `0015` are not yet recorded here as applied to production.
Migrations are applied with
`npm run db:migrate:{local,remote}` via
Wrangler, which tracks applied files in D1 independently of Drizzle's `meta/` snapshots. `0002` and
`0003` were hand-authored SQL, but the Drizzle snapshot history has been reconciled through `0003`,
so `npm run db:generate` should diff cleanly for future changes.

**Glossary — "board" names three separate things.** They are deliberately distinct; conflating them
in code or copy is the mistake this table exists to prevent. Use these words in that sense.

| Term              | Is                                                                     | Lives in              | Has history?                                                    |
| ----------------- | ---------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------- |
| **board admin**   | An access level. Grants admin writes _and_ the top content tier.       | `user.role = 'board'` | No — current state only. Demoting rewrites "now", never "then". |
| **board member**  | A person who serves on the board. What motions and votes reference.    | `board_people`        | Yes — the record is the point.                                  |
| **office / term** | One period of service, optionally with a title (President, Treasurer). | `board_terms`         | Yes — a person may hold several, with gaps.                     |

The two are managed in separate admin panels — **Board access** (`BoardAccessManager`) for sign-in
access, **The Board** (`BoardPanel`) for the roster — and neither writes the other's data. A board
member need not be a board admin, and a board admin need not be a board member. The content
visibility tier `board` is a fourth use of the word and follows the access sense: it means "visible
to a board admin". See [ADR 0012](./docs/adr/0012-board-record-as-structured-rows.md) for why the
record is independent of `user` rows.

**Roles and access.** Roles are `visitor`, `homeowner`, and `board`; content visibility tiers are
`public`, `homeowner`, and `board`. Access is enforced server-side and fail-closed: anonymous users
resolve to visitor, unknown states resolve to the most restrictive behavior. A user's role is a
column on the user record.

The board-only API is gated in **two** places, deliberately. `src/middleware.ts` rejects
`/api/admin/*` before the route runs (401 anonymous, 403 authenticated non-board), and every handler
under `src/pages/api/admin/` additionally opens with `requireBoard`. The per-route call is the
**enforced and tested** layer — the Workers test pool invokes handlers directly and never runs
middleware — while the middleware gate is the production backstop for a route shipped without its
guard. `test/server/admin-routes-all-gated.test.ts` enumerates every admin route module and asserts
each exported verb rejects an anonymous caller, so a new endpoint cannot ship ungated. Do not remove
the per-route guards in favor of the middleware: that would leave the behavior untested. See
[ADR 0013](./docs/adr/0013-admin-api-gated-in-middleware.md). `/api/bootstrap/board` sits outside the
gated prefix on purpose — it is the fail-closed first-board bootstrap and must stay reachable. Site sign-in access for board admins is managed in the admin app's
**Board access** panel: a board admin can promote another account to `board` and demote a board
admin, except the last remaining board admin cannot be demoted. A board admin cannot escalate their
own access beyond `board`. This is distinct from the admin app's **The Board** panel, which records
who serves on the board and their terms of service (`board_people`/`board_terms`, see **Data
model** above) and is deliberately independent of `user` rows — promoting or demoting a site
account has no effect on the roster, and a person can be recorded there with no site login at all;
see [ADR 0012](./docs/adr/0012-board-record-as-structured-rows.md). The first board account is
bootstrapped through the permanent fail-closed
`POST /api/bootstrap/board` endpoint, which self-disables once a board exists; guard logic lives in
`src/server/auth/seed-board.ts` and is re-exported as `seedBoard` from `scripts/seed-board.ts`.
These role changes are direct D1 writes, not Better Auth admin API calls. The Better Auth admin
plugin's impersonation, ban, and set-role endpoints are not granted to board sessions; see
`src/server/auth/permissions.ts`.

The official-mode homeowner-write API repeats that two-layer pattern. Middleware gates
`/api/member/*`, and every handler independently opens with `requireMemberApi`; mode off is checked
first and returns `404`, then anonymous is `401` and an authenticated visitor is `403`.
`test/server/member-routes-all-gated.test.ts` enumerates the member route modules. Successful calls
are scoped again through `AuthContext.propertyIds` (and active roster rows where identity matters),
so homeowner role alone never grants access to an arbitrary lot. See
[ADR 0019](./docs/adr/0019-homeowner-writes-official-mode-gate.md).

The live-voting API has the same middleware-plus-handler structure but a stricter fixed route-gate
order: both feature flags (`404`), exact required-Origin equality (`403`), JSON media type (`415`),
session (`401`), then homeowner rank (`403`). `test/server/member-routes-all-gated.test.ts` includes
`/api/vote`, while `voting-guards.test.ts` pins that order and Origin behavior. A successful
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
applyD1Migrations }` from `cloudflare:test` and mostly invoke handlers directly. That config also
merges Astro's own Vite plugins (minus its Cloudflare adapter plugin, which collides with
`cloudflareTest`'s own Cloudflare Vite plugin) into the Workers test pool, so `.astro` pages can
also be rendered directly through the Astro Container API inside the real Workers runtime — see
`test/server/meeting-pages.test.ts`. A shared `isCloudflarePlugin` predicate in the new
`vitest.shared.ts` identifies that plugin for both `vitest.config.ts` (which strips it, since it's
incompatible with the jsdom/node test environments) and `vitest.workers.config.ts` (which strips
Astro's copy in favor of `cloudflareTest`'s own), so the two configs can't drift on what counts as
"a Cloudflare plugin."

## Deploy

```bash
npm run build
npx wrangler deploy -c dist/server/wrangler.json
```

The root `wrangler.toml` uses `main = "src/worker.ts"` so the Worker can expose both Astro SSR
handling and the scheduled cleanup trigger. Manual deploys still use the adapter-emitted
`dist/server/wrangler.json`.

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
`sync:agents -- --check`/`format:check`/`lint:coercions`/`check` gates, then pushes and opens or
updates the PR.
Documentation is kept in sync at ship time through that `docs-updater` pass, so there is no
per-turn docs hook.

## Agent skills

### Issue tracker

Issues live in GitHub Issues at `jwh3times/valleys-at-ashebrook-hoa`, managed with the `gh` CLI. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its role name. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root (not yet created) plus `docs/adr/`. See
`docs/agents/domain.md`.
