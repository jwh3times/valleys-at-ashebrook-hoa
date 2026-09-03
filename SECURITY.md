# Security Policy

## Supported versions

This repository powers a single, continuously deployed website (Cloudflare Workers). The latest
state of `main` is the only supported version — there are no released versions or backports.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

- Preferred: open a private report via **GitHub → Security →
  [Report a vulnerability](https://github.com/jwh3times/valleys-at-ashebrook-hoa/security/advisories/new)**.
- Alternatively, email **<jerryholland00@gmail.com>** with the details and reproduction steps.

Please include the affected URL/endpoint or component, the impact, and steps to reproduce. We aim
to acknowledge within a few days and will coordinate a fix and disclosure timeline with you.

## Security model

- **Access is enforced server-side and fail-closed.** Roles are `visitor | homeowner | board`;
  content visibility tiers are `public | homeowner | board`. Anonymous users resolve to `visitor`
  and unknown states resolve to the most restrictive tier. Document downloads are tier-checked on
  the server before the R2 object is served.
- **Homeowner business is available only after the board enables official mode.** The `/proxies`
  page and every `/api/member/*` handler fail closed to 404 while `officialMode` is off. When it is
  on, the page offers sign-in/verification guidance while the API returns 401 to anonymous callers
  and 403 to callers below `homeowner`. Each handler calls
  `requireMemberApi`, and middleware independently gates the whole prefix as a production
  backstop. Proxy writes are then scoped to the caller's verified `propertyIds`; verification
  proves control of a lot, while the grantor selects which of the Persons currently holding Lot
  Authority there is acting — Ownership, or Representation of an owning Organization (#248 part 2
  moved that question from the lot's `owners` rows to the party roster).
  Identity within a jointly owned lot is therefore self-asserted, matching the explicit trust
  decision in [ADR 0019](./docs/adr/0019-homeowner-writes-official-mode-gate.md), rather than bound
  to a specific roster row on the user's verification link.
- **The proxy holder lookup deliberately discloses a narrow roster slice to verified
  homeowners.** `POST /api/member/owner-lookup` resolves one explicitly typed active-property
  address to the names and opaque IDs of the Persons who may act for that lot, never phone numbers
  or email addresses;
  a non-board caller with no currently verified lot is refused. This makes online grants usable by
  a holder in the later voting flow without exposing a browsable roster, but a verified homeowner
  can still repeat address queries to collect those names and IDs. That accepted tradeoff and a
  possible future rate limiter are recorded in ADR 0019.
- **`board` is never self-grantable, and board handoff is a supported workflow.** `POST
/api/admin/roles` (`promote`/`demote`, the admin panel's **Board access (legacy)** section — the
  last remaining board admin can't be demoted, and a board admin can't escalate their own access
  beyond `board`) was re-pointed by ADR 0022 phase 3e (#221) onto the same `cutover_mode` branch as
  `/api/verify/*`: under `legacy` it still writes the `users.role` column directly (the demote race
  is now closed by folding the live-board-count check into the update's own `WHERE` instead of a
  separate count-then-update); under `derived` it instead grants or ends a `board` Access Grant
  against the account's Person Link and current-or-scheduled Board Term
  (`src/server/roster/access.ts`, shared with `/api/admin/access-grants` so the two surfaces can
  never write different grants), carrying `users.role` along only as a write-behind mirror. Both
  branches preserve the last-board-member refusal and the no-self-escalation rule exactly. These are
  direct database writes either way: the Better Auth admin plugin's impersonation, ban, and set-role
  endpoints are deliberately not granted to board sessions. The first System Administrator account
  is bootstrapped through a
  permanent, fail-closed `POST /api/bootstrap/board` endpoint (rewritten by #219) that self-disables
  (`410`) the moment its one-time `system_admin_bootstrap` record is written — not merely "once a
  board account exists," since an account can also be promoted board by ordinary means. It requires,
  in order, a constant-time `x-bootstrap-secret` match against `BOOTSTRAP_SECRET`, an already
  authenticated session, and a body naming an existing, unconsolidated roster Person to link (see
  `SETUP.md` §6). The retired BOARD_EMAIL/BOARD_PASSWORD/BOARD_NAME signup path — which used to
  create a brand-new account directly from board credentials — is gone. **On this deployment the
  singleton was consumed during the ADR 0022 phase 3f flip on 2026-08-18, so the endpoint is now
  permanently disabled and answers `410` to every caller**; further System Administrators are
  granted through `/api/admin/access-grants` by an existing one, and the last live `system_admin`
  grant cannot be revoked.
- **A homeowner can end their own Person Link at any time, and a board caller can end anyone's.**
  `POST /api/verify/unlink` (session-gated only — deliberately outside `officialMode` and
  `/api/member/*`, since an account must always be able to disown a bad link) and the board's
  `/api/admin/person-links` `unlink` action both end a Person Link and every Access Grant it
  currently supports in one atomic batch, so an ended link never leaves a stray Board or System
  Administrator grant live. Ending the sole `system_admin` grant is refused (`409`) on both paths,
  and the refusal is permanently recorded as a denied Access Event so an attempted lockout leaves a
  durable trace even though nothing changes. Manual board verification (`POST
/api/admin/person-links` `manualVerify`, and its `POST /api/admin/verification-requests` `accept`
  counterpart) only ever links an EXISTING Person to an account — it never creates a Person and
  never grants access on its own — keeping identity and authority as separate decisions.
  `POST /api/admin/members`'s `revoke` action ends the same way under `derived` (phase 3e, #221:
  `endLinkStatements`, reason `no_longer_qualifies`, refusing a current board member — demote that on
  the board-handoff surface first); under `legacy` it keeps clearing `users.role` and deleting
  `user_property_links` directly, unchanged.
- **A public member meeting publishes each represented property's address alongside its vote,
  gated only by the meeting's own visibility tier.** The meeting record's public pages
  (`/meetings`, `/meetings/[id]`, rendered server-side via `fetchMeetingsFor`/`fetchMeetingFor` —
  there is no `/api/content/meetings` JSON endpoint) render, for a `public`-visibility member
  meeting, a per-motion roll call listing each property's street address next to its
  `yes`/`no`/`abstain` choice, weight, and a derived `viaProxy` flag; the attendance summary above
  the motions (the "N of M votes represented" line) is aggregate-only and names no property.
  **Who held a lot's proxy is absent from public meeting and election reads.** `viaProxy`
  (`proxy_id IS NOT NULL`) is the only proxy fact those tier-filtered records expose; the real
  `proxyId` — which would let a caller work backward to the named holder recorded on `proxies` — is attached to
  `MemberAttendanceRow`/`MemberVoteRow` only for the admin caller (the same admin-only-field
  pattern `ElectionDetail.ballots` already uses, see [ADR 0017](./docs/adr/0017-elections-secret-by-construction.md)),
  and `ElectionDetail.ballots[].proxyId`, already board-only, carries it unconditionally. There is
  no public proxy register. In official mode, `GET /api/member/proxies` separately returns only
  proxies for the caller's verified lots plus proxies naming a Person with authority over one of
  those lots as holder. An own-lot grant always includes its occasion title/date so the homeowner can understand
  and revoke it; for a proxy held on another lot, those fields are redacted when the occasion is
  above the caller's visibility tier. The complete `GET /api/admin/proxies` list remains
  `requireBoard`-gated. See [ADR 0018](./docs/adr/0018-proxies-record-via-proxy-consolidation.md)
  and [ADR 0019](./docs/adr/0019-homeowner-writes-official-mode-gate.md).
  **No resident name is ever published**: `castByName` and `representedByName` are present on the
  `fetchMeetingFor` payload for the admin panel's use, but the public template never interpolates
  them, and a test (`test/server/meeting-pages.test.ts`) pins that a name on the payload does not
  reach the rendered HTML. This is a deliberate data-contract decision, not an oversight: which lot
  voted which way is the kind of detail a member meeting's minutes traditionally record, and the
  existing `visibility` tier (`public`/`homeowner`/`board`) is the only gate — a board member who
  sets a member meeting's visibility to `public` is warned about the address exposure directly on
  the admin panel's visibility control. Board meetings are unaffected: `board_attendance`/
  `board_votes` reference a party-roster Person (`people`, repointed from the legacy `board_people`
  by #248), not addresses, and a board meeting's roll call has always named board members, never
  homeowners.
- **A proxy's grantor is re-validated as currently holding the lot every time the proxy is used,
  not only when it is granted.** The ADR 0022 phase 3d grantor re-validation (#220, decided by
  #204) adds a check to the shared `proxyUseError` guard behind `setMemberAttendance`,
  `setMemberVotes`, and `setBallots`, and to both live-cast authority predicates behind
  `POST /api/vote`: a proxy whose grantor no longer holds Lot Authority over the proxy's lot is
  refused (`409`) rather than accepted on the strength of having been valid when granted. Since
  #248 part 2 that question is asked of the party roster — Ownership, or Representation of an
  owning Organization, through the single definition in `src/server/roster/authority.ts` — rather
  than of the legacy `owners.status`. It remains a deliberate approximation in ONE respect, the day
  it asks about: it refuses whenever the grantor does not hold the lot _today_, which can also
  refuse a proxy that was genuinely valid on the day it was used if the grantor has since sold. The
  board's escape for a legitimate late record-keeping entry is to record it without the proxy
  reference. A live cast is unaffected, since for it "today" is the occasion. Exact occasion-day
  interval containment is now mechanically possible for the first time — the intervals are
  queryable and the day is on the occasion row — and is deliberately left to its own change rather
  than folded into a schema repointing.
- **Election turnout and candidate choices have no explicit identity link or join key.** `ballots`
  records only that a lot participated — election, property, frozen record-date weight, and
  person-or-proxy provenance. A successful conducted ballot atomically inserts that turnout row and
  one independent `ballot_choices` row per selection, using only the weight frozen in
  `election_eligibility` when the election first opened. Each choice retains an independent id,
  election, candidate, and non-negative weight. It deliberately has no `ballot_id`, `property_id`,
  owner/proxy/caster field, timestamp, shared receipt, or other explicit correlation field; none may
  be added through schema, types, APIs, logs, or exports, and supported reads never join choices to
  turnout. This does not guarantee mathematical anonymity: `ballots.weight` and
  `ballot_choices.weight` retain the same snapshotted value, so a rare or unique weight may identify
  or narrow a property's selections. Conducted ballots are final: the caller-specific read model
  returns only a per-lot `hasCast` receipt and never resolves retained choices for display, editing,
  or replacement. `candidates.votes` remains `NULL` while a conducted election is open and is
  derived from the retained choice rows only in the atomic close operation, so there is no live
  tally to diff. For recorded paper elections, `candidates.votes` remains the board-entered
  aggregate and no choice row exists. The public `/elections` read still exposes only
  closed/certified results and aggregate turnout; per-lot ballots and frozen eligible-property rows
  are board-only. SQLite insertion order and D1 Time Travel add residual operator-level temporal
  correlation risks that application schema cannot fully remove. See
  [ADR 0017](./docs/adr/0017-elections-secret-by-construction.md) for the paper-election baseline and
  [ADR 0020](./docs/adr/0020-digital-ballot-box.md) for the retained digital ballot box and its
  limits.
- **The ADR 0022 phase 3d transfer-effects and review-flag machinery is held to the same
  ballot-secrecy boundary.** A property transfer's automatic discovery of a not-yet-concluded
  conducted ballot (`ballot_final_after_transfer`) reaches only the identity-linked turnout
  `ballots` row and the election occasion — it never reads, joins, names, or counts
  `ballot_choices` or a candidate selection, and the board's `GET /api/admin/review-flags` queue
  exposes the same limited reach. A two-layer test suite (`test/unit/ballot-privacy-boundary.test.ts`,
  a static scan of `src/`; `test/server/ballot-privacy.test.ts`, a runtime proof that
  `ballot_choices` rows are byte-identical across a transfer) plus a `verify:invariants` check
  hold that boundary as a permanent gate on the discovery/flag/ledger/export machinery, not a
  point-in-time review. As of #240, that invariant check reaches production two ways: on demand
  as the operator-run `npm run verify:invariants`, and automatically every day on the Worker's
  existing cron trigger (`src/server/db/invariants.ts`, shared by both), so a violation of this
  boundary is caught the day it occurs rather than only when someone thinks to check.
- **Live-vote eligibility and lifecycle history are immutable records.**
  `election_eligibility` and `motion_eligibility` are the record-date snapshots: they freeze every
  active property and its vote weight at first open, and every live ballot or motion vote stamps its
  weight only from the corresponding frozen row. Later roster or weight edits therefore cannot
  change eligibility, rewrite a cast vote, or alter the historic tally. An opened election cannot
  return to draft, and a motion or parent meeting with live-voting history cannot be deleted. Board
  `setMemberVotes` corrections are refused while voting is open and use a
  state-plus-monotonic-revision compare-and-swap in one D1 batch, preventing a stale replacement
  from erasing votes from an intervening close/reopen session. Meeting approval conditionally
  re-checks that no child motion vote is open. Recorded tally/ballot replacements reserve their
  parent election in the same batch, so a racing certification or void cannot leave stale child
  data behind; certification likewise reserves the closed election and re-checks the open-term
  invariant so concurrent elections cannot open two terms for the same existing person.
- **The live-voting API is default-off, same-origin, and independently guarded.** Middleware and
  `POST /api/vote` both enforce the surface. The route guard's fixed order is: require
  `officialMode` and `liveVotingEnabled` to be literal JSON booleans `true` (`404` otherwise);
  require the operator-only write freeze to be off (`503` otherwise, see below); require the
  request's `Origin` header to equal `new URL(request.url).origin` exactly (`403` when
  missing or different); require an `application/json` media type (`415` otherwise); resolve a
  session (`401` when anonymous); then require at least the `homeowner` role (`403` otherwise).
  Only after those gates does input normalization run. Resource reads then mask out-of-tier or
  unknown elections and motions as `404`, while own-lot and held-proxy authority, frozen-snapshot
  eligibility, open state, and one-cast-per-lot constraints are checked server-side.
- **Casting re-checks authority and live state at the mutation boundary.** The insert predicates
  repeat the caller's own-lot or occasion-scoped held-proxy authority, visibility tier, frozen
  eligibility, open lifecycle state, and both feature flags inside D1. Election turnout and all
  retained choices are one checked batch; motion voting checks the single insert result. A close,
  duplicate cast, authority change, or global-pause race therefore records nothing and maps to
  `409` rather than relying on the earlier preflight. Turning off either flag pauses new opens and
  casts without deleting open state, snapshots, turnout, votes, or retained choices; re-enabling
  resumes an occasion that is still open.
- **The homeowner voting experience preserves finality and selection non-disclosure.** There is no
  GET voting API: the feature-gated SSR `/vote` page calls the server-only `fetchOpenVotingFor`
  projection, which returns visible open occasions and eligible lots the caller controls directly
  or through a held proxy, their frozen weights and provenance options, election candidates, and
  only a `hasCast` receipt — never a retained ballot choice or live conducted-election tally. Before
  `POST /api/vote` sends either `castBallot` or `castMotionVote`, the labeled modal review names the
  pending selection and owner/proxy provenance, moves and traps focus, supports Escape/cancel with
  focus restoration, and disables background voting controls. It warns that the homeowner cannot
  change, recover, or recast that submitted selection through `/vote`. A successful exact-204
  response replaces the form with a receipt containing only the occasion title and lot address.
  Only conducted-election choices are undisplayable, unrecoverable, uneditable, and irreplaceable
  throughout the supported application because they have no identity link. Member-motion votes
  remain attributable and board-visible, and the board-only correction workflow may replace them
  after voting closes. Admin election history exposes turnout and final aggregate results without a
  lot-to-choice link.
- **Homeowner verification is possession-based, throttled, and answers uniformly regardless of
  whether anything matched.** `POST /api/verify/request` takes `{ address, name, channel,
turnstileToken }` and, once past the write freeze/session/Turnstile gates — none of which touch
  the roster — returns the exact same `200 { ok: true, message: 'If the information matches our
records, a code has been sent.' }` for success, an unknown address, an unmatched or ambiguous
  name, an organization-owned lot, a shared/unattributable contact, an already-linked account or
  Person, and every rate limit. This closes the address-existence oracle the previous
  `queued`/`rateLimited` distinction (and its `429`) exposed; there is no longer a way to learn from
  the response alone whether an address, a name, or a rate limit caused a given outcome.
  `POST /api/verify/confirm` is equally non-committal: every internal failure collapses to
  `{ ok: false, reason: 'mismatch' }` except `expired`/`locked`, which keep their own reason. Which
  backend answers is decided by `cutover_mode` (see below), which since the phase 3f flip reads
  `derived` in production. Under the retained `legacy` backend, sign-up matches by address only and
  fans the code out to every active owner contact on file for the chosen channel, matching no name.
  Under `derived`, which is what production runs, sign-up additionally matches the claimed name
  against the Lot's current Person owners
  (an exact normalized match, or a first-and-last-token match if none matched exactly) and sends a
  single code to that one matched Person's own contact — never a fan-out — and only if that contact
  is uniquely attributable to one Party roster-wide. Codes are stored only as keyed HMAC-SHA-256
  hashes and compared in constant time, so a leaked database backup can't be reversed with a
  precomputed table. Requests are rate-limited in KV: a short per-account cooldown, a daily cap per
  account, a daily cap per Lot (both modes), a daily cap per matched Person (`derived` only, so a
  Person owning several Lots isn't re-sendable once per Lot), and a cap on the number of distinct
  names one account may try against one Lot per day — the roster-walking control. Nothing
  auto-queues for board review anymore: an applicant who can't complete the code flow must take the
  explicit `POST /api/verify/review` action (session-gated, one open request per account), with one
  exception — a claimed Person already linked to a different account auto-creates that review row,
  since #201 treats that specific collision as worth a board look regardless of the uniform
  response the requester sees.
- **`cutover_mode` decides which authorization model answers, and fails safe to the model already
  serving production.** The ADR 0022 phase-3 flip switch (`src/server/authz/cutover-mode.ts`,
  reading the uncached `cutover_settings.cutover_mode` singleton) sits inside the single seam every
  guard resolves its caller through (`src/server/authz/context.ts`). It fails closed to
  **`legacy`** — the opposite polarity from the operator write freeze below, because refusing is
  not the safe answer on this axis; the safe answer is whichever model has already been serving
  production. **The phase 3f flip executed on 2026-08-18, so the singleton now reads `derived` and
  the party roster decides every request**: capabilities and content tier are recomputed per
  request from the caller's Person Link, Ownerships, Representations, Board Terms, and Access
  Grants, with every stored grant re-validated against current facts. Legacy
  `users.role`/`user_property_links` are written behind as mirrors and read for authorization only
  if the flag is written back to `legacy`, which remains possible and is what an absent row means.
- **The ADR 0022 derived-authorization layer cannot change a live authorization decision and
  records only non-personal comparison data.** `src/server/authz/derive.ts` computes a second,
  independent authorization context from the new party-roster tables, re-validating every stored
  Board grant against its qualifying term on every call — a live grant whose term has lapsed, been
  cancelled, or been voided is refused, independent of whether the write path already ended it.
  Comparison (`src/server/authz/shadow.ts`, wired into `src/middleware.ts` behind the off-by-default
  `env.CUTOVER_SHADOW === 'on'`) is mode-aware: it runs after whichever context answered the
  request is already resolved and computes the other model fresh for the comparison — never the
  served context compared with itself — returns no value, and swallows its own errors rather than
  propagating them; it is structurally incapable of denying or granting anything. A disagreement is
  recorded to `cutover_shadow_mismatches` as account id, role/tier codes, and lot **counts** only,
  never a lot id, name, address, or other roster detail, and repeats collapse onto one row per
  account rather than accumulating a per-request log. The companion offline sweep
  (`npm run shadow:sweep`) writes the same shape from an operator machine, not the Worker. The new
  board-only `GET /api/admin/roster-preview` panel is read-only by design — the phase-2 backfill
  clean-replaces the underlying tables, so a write here would be silently erased — and exposes only
  structural counts (including the count of unexplained shadow mismatches), never resident names,
  addresses, or contact data.
- **An operator-only write freeze can halt mutations site-wide without a deploy.** The
  `cutover_settings.write_freeze` singleton (built for the ADR 0022 phase-3 flip and retained
  afterward as a general maintenance switch) is read uncached on every covered request, in two
  layers — the per-route guards and a middleware backstop. Coverage is **deny-by-default**: a single
  `freezePolicyFor(path)` freezes every mutation unless the path is one of two declared exemptions,
  so admin writes, the whole homeowner-write surface (`/api/member/*`, `POST /api/vote`, frozen on
  reads too), homeowner verification, and any route added later are all covered without being
  enumerated. `test/unit/freeze-coverage.test.ts` fails the build if a mutating route escapes.
  Reads stay live throughout — public pages, `/api/content/*`, `/api/files/*`, and admin `GET`s —
  so a frozen site remains fully readable. The two exemptions are `/api/auth/*` and
  `/api/bootstrap/board`, each because freezing it would break the freeze's own purpose: an operator
  locked out of sign-in cannot run the flip, and the flip creates its first System Administrator
  while the freeze is on. A frozen request answers `503`, never `404`, so a frozen site does not
  appear to mask a surface's existence. Reading the setting fails closed: an error is treated as
  frozen, and an absent row is the normal un-frozen state. It is written only by direct D1 access
  (`wrangler d1 execute`); it is not exposed in the admin Site panel, because pausing the site is an
  operator action rather than a board decision.
- **Every response carries baseline security headers.** Middleware sets `X-Content-Type-Options:
nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and an **enforced**
  Content-Security-Policy that allowlists only the third-party resources the site uses (Google
  Fonts, the Google Calendar embed, Turnstile, Web3Forms, and the Cloudflare Web Analytics beacon).
  HSTS is not enabled by the Worker or repository yet; it remains a Cloudflare zone-level operator
  action.
- **Document files are constrained on upload and download.** Uploads are limited to an extension
  allowlist with a server-derived canonical content type and a size cap (HTML and SVG are excluded
  as stored-XSS vectors; disallowed types are rejected with `415`). Downloads are sent with
  `nosniff`, forced to `attachment` for anything other than PDF, and given a sanitized filename.
- **Secrets never live in the repo.** Runtime secrets (auth, Resend, Twilio, Turnstile) are set as
  Cloudflare Worker secrets via `wrangler secret put` (see `SETUP.md`); only `PUBLIC_*` build-time
  variables are non-secret. `.env` files are git-ignored.
- **The roster is personal data, used for verification and lot-scoped association workflows.**
  Owner names, emails, and phone numbers live only in the D1 database — never in committed files.
  Contact data delivers the one-time verification code to the contact already on file and also
  contributes matching values to the AI pseudonymizer described below; it is never returned by the
  proxy holder lookup. Names and opaque IDs of Persons who currently hold Lot Authority support
  the official-mode proxy grant/holder workflow described above. Public docs describe the purpose
  and high-level handling; deployment-specific removal, erasure, backup, and retention runbooks
  live in the private operations companion repository (see `AGENTS.md`), never in this repo.
- **The admin document assistant is board-only and pseudonymizes known PII before it leaves the
  Worker.** `POST /api/admin/assistant` is gated by `requireBoard` (fail-closed, same as every other
  admin endpoint). Answering a question sends retrieved document excerpts, the question, and recent
  chat history to Anthropic; before any of that text is transmitted, every roster name, contact
  value, and Lot address is swapped for a realistic, consistent placeholder — including each individual
  name token (so a resident's standalone first name or surname is also replaced, not just their full
  name) — except tokens that are common English words, which are left intact so ordinary document
  text is not garbled — and any email address found anywhere in the text is pseudonymized the same
  way; roster phone numbers are pseudonymized in any format (including bare digits), and any number
  written in a standard phone format (parenthesized area code or separators) is pseudonymized
  whether or not it matches the roster. Document titles are pseudonymized the same way and sent as
  part of each excerpt label; citations
  reference retrieved excerpts by index label and are resolved back to real documents server-side.
  The dictionary is built from **both roster models** — Person names and Contact Methods from the
  live party roster (`people`, `contact_methods`) and owner names, phones, and emails from the
  legacy `owners` table, unioned with Lot addresses — so a resident recorded through the admin
  Roster panel after the ADR 0022 flip is masked exactly like one carried over by the backfill. It
  is deliberately not filtered by status, interval, void, or consolidation: a former owner or an
  ended contact value still appears in old documents and must still be masked. A redacted name or
  contact value arrives as a NULL and contributes nothing, so redaction is never undone by the
  dictionary.
  This is **best-effort, not a guarantee**: it only catches PII matching a current roster entry or
  the email/phone patterns, so it does not cover non-resident names or other free text that doesn't
  match those patterns, and has narrow documented edge cases (for example, a roster value whose
  closing abbreviation period is glued directly to the next word with no separating space).
  **Organization names are deliberately excluded** from the dictionary: name entries are matched
  per token, so registering an organization named for the neighborhood itself would rewrite that
  name into a surrogate person throughout every excerpt. An organization's contact methods are
  still masked; a person's name embedded in an organization's legal name is not.
- **The board-only report generator shares the assistant's pseudonymization and is also board-only
  end to end.** `POST /api/admin/reports` is gated by `requireBoard` the same as every other admin
  endpoint. For one of six curated templates, hand-tuned retrieval sub-queries are used directly;
  for a freeform topic, a small Claude Haiku structured-output call first expands the
  **pseudonymized** topic into 3-6 retrieval sub-queries and the returned queries are de-anonymized
  before retrieval, so search still runs over real document text — any planning failure degrades to
  a single query on the raw topic rather than failing the request. Retrieval that yields no usable
  excerpt returns before a report-writing model call. Otherwise the Claude Opus call receives the same
  pseudonymized excerpt and title context as the chat assistant, built from one shared
  pseudonymizer instance per request, and the streamed markdown is de-anonymized server-side before
  it reaches the board member's browser. Retrieval itself is not tier-aware for the same reason
  described below, so this endpoint stays board-only rather than being exposed to homeowners.
- **Saved reports retain real, de-anonymized text in D1 for 90 days — unlike the chat assistant,
  which saves nothing.** `reports.content_md`, the freeform-capable topic, and
  `reports.sources_json` carry the final report and its cited document metadata so a board member
  can reopen it during that window; this is equivalent exposure to the documents it cites, is
  protected by the same board-only access as every other admin surface, and has no additional
  encryption. The daily scheduled job replaces all three text-bearing fields with a fixed non-PII
  removal state after 90 days while retaining the report ID, template key, creator ID, and timestamp.
  Any authorized Person-name or Contact Method redaction performs that purge for every saved report
  in the same D1 batch, so an old de-anonymized copy cannot outlive the roster erasure. A board
  member may still delete the retained row manually (`DELETE /api/admin/reports`). Only a completed
  generation is saved — the row is inserted before the SSE `done` frame is emitted, so a failed or
  client-disconnected generation leaves no row.
- **The AI Search index is not tier-aware, which is why the assistant stays board-only.** Retrieval
  runs over a single Cloudflare AI Search index built from every document's Markdown text
  (`rag/<uuid>.md`) regardless of that document's visibility tier, and returns un-pseudonymized
  excerpt **text** for the model to compose an answer from — only the citation _link_ is tier-checked
  (`/api/files/<id>`), not the retrieved text itself. Exposing `POST /api/admin/assistant` to
  `homeowner` or public callers would let board-tier document text (financials, per-owner
  correspondence, legal/collections) surface verbatim in an answer even though the citation download
  would still correctly return 403 — a tier bypass through the answer body, not the download. See
  §2 of [ADR 0009](./docs/adr/0009-rag-index-separate-from-download-library.md) for the constraint
  in full: relaxing the board-only gate requires per-caller retrieval filtering or separate per-tier
  indexes, plus a re-review of the PII-pseudonymization boundary described above.
- **Uploaded document content is converted to build the search index.** `POST /api/admin/documents`
  produces the `rag/<uuid>.md` twin by running binary uploads (pdf/docx/xls/xlsx/doc) through
  Cloudflare Workers AI's `env.AI.toMarkdown`, while text-native uploads (md/txt/csv) are used
  as-is with no AI call. Either way this stays within Cloudflare (not a third-party egress like the
  Anthropic answer-generation step); the resulting index text is un-pseudonymized and board-only,
  consistent with the non-tier-aware index described above.

## Automated safeguards

- **Dependabot** — dependency update PRs and security alerts (`.github/dependabot.yml`).
- **CI** — every push and PR runs format, type-check, unit tests, Worker/D1 integration tests
  (`test:server`), and build gates (`.github/workflows/build.yml`).

## Responsible disclosure

We will not pursue legal action against good-faith security research that respects residents'
privacy, avoids data destruction, and gives us reasonable time to remediate before public
disclosure.
