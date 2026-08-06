# Architecture

The Valleys at Ashebrook Residents site is an independent, resident-run Astro SSR app on
Cloudflare Workers. It defaults to unofficial resident mode and can switch to official HOA
presentation only through the board-admin official-mode setting.

## Runtime Shape

- **Astro SSR on Cloudflare Workers** renders pages and hosts API routes.
- **React islands** power interactive forms and the board admin panel.
- **D1** stores content metadata, settings, accounts, roles, roster records, and verification state.
- **R2** stores document file bytes.
- **KV** backs adapter/session needs and lightweight verification rate limits.
- **Better Auth** provides email/password accounts and role-aware sessions.

The custom Worker entrypoint handles normal `fetch` requests and the scheduled cleanup trigger.

## Roles and Visibility

Roles are `visitor`, `homeowner`, and `board`. Content visibility tiers are `public`,
`homeowner`, and `board`.

Authorization is enforced server-side. Public pages and APIs receive only content allowed for the
resolved role, and document downloads check the document tier before streaming from R2.

## Homeowner Verification

Homeowners create accounts through Better Auth, then verify a property by requesting a one-time
code sent to the phone or email already on the owner roster. Successful verification links the user
to the property and grants homeowner access.

The roster contains personal data and is used only for verification. Roster source files, import
artifacts, and deployment-specific handling procedures belong under `private/`.

## Content and Documents

Announcements, dues, site settings, and document metadata live in D1. Document bytes live in R2
and are served only through the gated `/api/files/[id]` route.

Document uploads use a server-side extension allowlist, canonical content types, SHA-256 content
hashes, and duplicate detection. Exact duplicate uploads are blocked; near duplicates require board
confirmation.

## Structured Association Record

The board maintains association business as structured D1 rows rather than uploaded transcripts:

- `board_people` and `board_terms` record service independently of site login access.
- `meetings`, attendance, motions, and roll-call votes record board and member meetings. Member
  attendance and voting are property-based. A live-voting motion freezes active properties and
  weights on first open, retains that record-date snapshot across close/reopen cycles, and uses a
  monotonic revision to keep stale board corrections from overwriting a later session.
- `resolutions` form a permanent supersession chain: adopting, superseding, and repealing are
  explicit transitions, while an in-force or historic resolution cannot be deleted.
- `elections`, candidates, and ballots record both the existing paper workflow and the lifecycle
  foundation for later site-conducted elections. A conducted election freezes eligible properties
  and weights when it opens. Per-lot ballots establish turnout and provenance only; anonymous
  `ballot_choices` retain weighted candidate selections with no link back to a ballot, lot, owner,
  proxy, caster, or timestamp. Conducted tallies remain absent while open and are derived from the
  retained choices only when the election closes.
- `proxies` record one lot's grantor and holder for exactly one meeting or election. Member
  attendance, votes, and election ballots cite the canonical proxy row instead of carrying an
  unverified "via proxy" flag.

Public meeting, resolution, and election pages are rendered server-side from tier-filtered read
helpers. Draft meetings and resolutions, plus draft or void elections, stay on board-only admin
reads even when the caller has the board role; the public read path always enforces its publication
status independently of role.

Live voting is inert by default. The `liveVotingEnabled` site setting normalizes to `false`, and
opening a conducted election or member-motion vote requires both that flag and official mode in
the database-conditioned transition. This slice provides board-only preparation and lifecycle
foundations; no `/vote`, `/api/vote`, ballot-casting workflow, or homeowner voting UI has shipped.

## Official-Mode Homeowner Actions

Official mode is both a presentation switch and the outer authorization gate for homeowner HOA
business. When it is off, `/proxies` and `/api/member/*` return the generic not-found surface. When
it is on, a verified homeowner can grant or revoke a proxy for a lot linked to their account and can
review proxies they granted or hold. The member API repeats the mode/role check in every handler,
while middleware independently gates the namespace as a production backstop.

Owner lookup for naming a proxy holder accepts one exact active-property address and returns only
active owner names plus opaque ids, never contact data. The complete proxy register and all paper
proxy administration remain board-only.

## Board-Only Document Assistant

Board members can ask natural-language questions about the document library from `/admin` and get a
streamed, cited answer generated by Claude over content retrieved from a dedicated Cloudflare AI
Search index. Every document has two R2 representations: the human-readable original residents
download, and a derived Markdown twin that only AI Search indexes. Retrieval is not tier-aware, so
the assistant is board-only; known resident PII is pseudonymized before any excerpt, question, or
chat history reaches the model. See [ADR 0009](./adr/0009-rag-index-separate-from-download-library.md)
and `SECURITY.md` for the constraints this design must preserve.

## Board-Only Governing-Document Reports

The admin panel can generate a saved report from one of six curated topics or a freeform subject.
Curated topics use fixed retrieval queries; freeform subjects are expanded into several queries by
a small Claude planning call. Retrieved chunks are pooled, deduplicated, and passed through the
same pseudonymization and citation pipeline as the chat assistant before a five-section Markdown
report is streamed to the board member.

Completed reports persist in D1 with a point-in-time source snapshot and can be reopened or deleted
from the admin panel. Failed or disconnected generations do not leave partial report rows. Saved
report text is de-anonymized board data and currently has no automatic retention policy.

## Admin Surface

Board members manage content, documents, duplicates, dues, site settings, roster records, homeowner
access, board admin sign-in access, the board roster, meetings, resolutions, elections, proxies,
the document assistant, and saved reports through `/admin`. The roster of who serves on the board
and their terms is independent of who can sign in with board access.

The first board account is created through a fail-closed bootstrap endpoint. Later handoff of board
admin sign-in access is managed through the Board access admin section. Board sessions are not
granted Better Auth impersonation, ban, or generic set-role capabilities.

## Operations

Deploys from `main` are handled by Cloudflare Workers Builds. GitHub Actions verifies formatting,
types, unit/component tests, Worker/D1 integration tests, and production builds. Worker deployment
does not apply D1 migrations; operators apply the committed migration ledger separately with the
documented remote migration command.

The Worker has a daily scheduled cleanup that removes old consumed/expired verification rows and
resolved manual-approval rows. HSTS is a pending Cloudflare zone-level operator action, not an app
header controlled by this repo.

## Tests

- `npm test` runs Vitest unit and component tests.
- `npm run test:server` runs Worker/D1 integration tests through the Cloudflare Vitest pool.
- `npm run check` runs Astro and TypeScript checks.
- `npm run build` verifies the production SSR build.

## Related Decisions

See [ADR 0020](./adr/0020-digital-ballot-box.md) for the digital ballot-box and frozen-electorate
boundary, and the [ADR index](./adr/README.md) for all durable architecture and operating decisions.
