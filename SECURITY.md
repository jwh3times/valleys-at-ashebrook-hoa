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
  proves control of a lot, while the grantor selects which active owner of that lot is acting.
  Identity within a jointly owned lot is therefore self-asserted, matching the explicit trust
  decision in [ADR 0019](./docs/adr/0019-homeowner-writes-official-mode-gate.md), rather than bound
  to a specific owner row on the user's verification link.
- **The proxy holder lookup deliberately discloses a narrow roster slice to verified
  homeowners.** `POST /api/member/owner-lookup` resolves one explicitly typed active-property
  address to that lot's active owner names and opaque IDs, never phone numbers or email addresses;
  a non-board caller with no currently verified lot is refused. This makes online grants usable by
  a holder in the later voting flow without exposing a browsable roster, but a verified homeowner
  can still repeat address queries to collect those names and IDs. That accepted tradeoff and a
  possible future rate limiter are recorded in ADR 0019.
- **`board` is never self-grantable, and board handoff is a supported workflow.** A user's role is
  a column on the user record. A board admin can promote another account to `board` and demote a
  board admin from the admin panel's **Board access** section (the last remaining board admin
  can't be demoted), but cannot escalate their own access beyond `board`. These are direct database
  writes: the Better Auth admin plugin's impersonation, ban, and set-role endpoints are deliberately
  not granted to board sessions. The first board account is bootstrapped through a permanent,
  fail-closed `POST /api/bootstrap/board` endpoint that is inert once any board account exists and
  requires a constant-time secret match plus `BOARD_*` config (see `SETUP.md` §6).
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
  proxies for the caller's verified lots plus proxies naming an active owner of those lots as
  holder. An own-lot grant always includes its occasion title/date so the homeowner can understand
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
  `board_votes` reference `board_people`, not addresses, and a board meeting's roll call has always
  named board members, never homeowners.
- **Election turnout and candidate choices have no explicit identity link or join key.** `ballots`
  records only that a lot participated — election, property, frozen record-date weight, and
  owner-or-proxy provenance. A successful conducted ballot atomically inserts that turnout row and
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
  require the request's `Origin` header to equal `new URL(request.url).origin` exactly (`403` when
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
- **Homeowner verification is possession-based and throttled.** Sign-up is verified against the
  owner roster via a one-time code sent to the phone/email already on file (Resend / Twilio), gated
  by Cloudflare Turnstile. Codes are stored only as keyed HMAC-SHA-256 hashes and compared in
  constant time, so a leaked database backup can't be reversed with a precomputed table.
  Verification requests are rate-limited in KV — a short per-user cooldown plus daily caps per user
  and per property — to curb abuse of the SMS/email fan-out.
- **The ADR 0022 migration shadow layer cannot change an authorization decision and records only
  non-personal comparison data.** `src/server/authz/derive.ts` computes a second, independent
  authorization context from the new party-roster tables; legacy `users.role`/
  `user_property_links` remain the sole source of truth for every request. Comparison
  (`src/server/authz/shadow.ts`, wired into `src/middleware.ts` behind the off-by-default
  `env.CUTOVER_SHADOW === 'on'`) runs only after the legacy context already decided the request,
  returns no value, and swallows its own errors rather than propagating them — it is structurally
  incapable of denying or granting anything. A disagreement is recorded to
  `cutover_shadow_mismatches` as account id, role/tier codes, and lot **counts** only, never a lot
  id, name, address, or other roster detail, and repeats collapse onto one row per account rather
  than accumulating a per-request log. The companion offline sweep (`npm run shadow:sweep`) writes
  the same shape from an operator machine, not the Worker. The new board-only
  `GET /api/admin/roster-preview` panel is read-only by design — the phase-2 backfill clean-replaces
  the underlying tables, so a write here would be silently erased — and exposes only structural
  counts (including the count of unexplained shadow mismatches), never resident names, addresses,
  or contact data.
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
  proxy holder lookup. Active owner names and opaque IDs support the official-mode proxy
  grant/holder workflow described above. Public docs describe the purpose and high-level handling;
  deployment-specific removal, erasure, backup, and retention runbooks belong under `private/`.
- **The admin document assistant is board-only and pseudonymizes known PII before it leaves the
  Worker.** `POST /api/admin/assistant` is gated by `requireBoard` (fail-closed, same as every other
  admin endpoint). Answering a question sends retrieved document excerpts, the question, and recent
  chat history to Anthropic; before any of that text is transmitted, every roster owner name and
  property address is swapped for a realistic, consistent placeholder — including each individual
  name token (so a resident's standalone first name or surname is also replaced, not just their full
  name) — except tokens that are common English words, which are left intact so ordinary document
  text is not garbled — and any email address found anywhere in the text is pseudonymized the same
  way; roster phone numbers are pseudonymized in any format (including bare digits), and any number
  written in a standard phone format (parenthesized area code or separators) is pseudonymized
  whether or not it matches the roster. Document titles are pseudonymized the same way and sent as
  part of each excerpt label; citations
  reference retrieved excerpts by index label and are resolved back to real documents server-side.
  This is **best-effort, not a guarantee**: it only catches PII matching a current roster entry or
  the email/phone patterns, so it does not cover non-resident names or other free text that doesn't
  match those patterns, and has narrow documented edge cases (for example, a roster value whose
  closing abbreviation period is glued directly to the next word with no separating space).
- **The board-only report generator shares the assistant's pseudonymization and is also board-only
  end to end.** `POST /api/admin/reports` is gated by `requireBoard` the same as every other admin
  endpoint. For one of six curated templates, hand-tuned retrieval sub-queries are used directly;
  for a freeform topic, a small Claude Haiku call first expands the **pseudonymized** topic into 3-6
  retrieval sub-queries and the returned queries are de-anonymized before retrieval, so search still
  runs over real document text — any planning failure degrades to a single query on the raw topic
  rather than failing the request. The report-writing Claude Opus call receives the same
  pseudonymized excerpt and title context as the chat assistant, built from one shared
  pseudonymizer instance per request, and the streamed markdown is de-anonymized server-side before
  it reaches the board member's browser. Retrieval itself is not tier-aware for the same reason
  described below, so this endpoint stays board-only rather than being exposed to homeowners.
- **Saved reports persist real, de-anonymized text in D1 — unlike the chat assistant, which saves
  nothing.** `reports.content_md` and `reports.sources_json` store the final report and its cited
  document metadata so a board member can reopen it later; this is equivalent exposure to the
  documents it cites, and is protected by the same board-only access as every other admin surface,
  not by any additional encryption. A saved report is a point-in-time snapshot with no retention or
  cleanup policy yet; removing one is a manual, board-only action (`DELETE /api/admin/reports`).
  Only a completed generation is saved — the row is inserted before the SSE `done` frame is emitted,
  so a failed or client-disconnected generation leaves no row.
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
