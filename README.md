# The Valleys at Ashebrook Residents

An independent, resident-run website for the Valleys at Ashebrook neighborhood — **not**
the official Valleys at Ashebrook HOA site. It's built and maintained by a resident as a
convenience for neighbors. An admin-toggleable **official mode** (off by default) lets a
board that wants to adopt the site turn on HOA branding and dues/board copy; while it's
off, the site presents as an unofficial resident hub with a "not affiliated with the
HOA" disclaimer (see `/about`) and hides dues and homeowner-business surfaces.

It provides:

- 📣 **Announcements** — community news
- 📅 **Community calendar** — meetings and events via Google Calendar,
  with Google Meet links for virtual meetings
- 📄 **Governing documents** — bylaws, CC&Rs, minutes, and forms, with board-side
  duplicate detection and cleanup tools
- 🗳️ **Meeting record** — board-authored, board-approved minutes at `/meetings`: date,
  attendance, motions, and roll-call votes for board meetings, plus weighted per-property
  attendance and votes for member meetings, including paper proxies the board records against a
  lot's attendance, vote, or ballot; a default-off live-voting workflow lets the board open,
  close, and reopen member motions against a frozen eligible-lot and weight snapshot
- 📜 **Resolutions book** — standing rules the board adopts, published at `/resolutions`;
  amending a resolution creates a new one that supersedes the old, forming a walkable chain
- 🏛️ **Elections** — recorded paper elections plus a default-off conducted-election lifecycle and
  identity-unlinked ballot-box schema; `/elections` publishes only closed/certified candidates,
  results, and aggregate turnout; when the board enables live voting, verified homeowners cast
  final ballots at `/vote` while the board opens, monitors, closes, and reviews elections in the
  admin panel
- 📝 **Homeowner proxies** — in official mode, a verified homeowner can grant or revoke a proxy
  for one of their lots at an upcoming member meeting or election and review proxies they granted
  or hold at `/proxies`; the board can still record and administer paper proxies
- 🤖 **Board-only AI document assistant** — ask natural-language questions about the
  document library and get a streamed, cited answer (Cloudflare AI Search + Claude),
  with known resident PII pseudonymized before anything reaches the model
- 📊 **Board-only AI governing-documents reports** — generate a saved, citable markdown
  report from a curated template (rentals, fences/improvements, assessments, enforcement,
  meetings/voting, maintenance) or a freeform topic, built on the same AI Search + Claude
  - pseudonymization pipeline as the document assistant
- 💳 **Dues & payments** — annual dues amount and payment options (shown in official
  mode)
- ✉️ **Contact form** — reaches the resident who maintains the site (or the board, in
  official mode)
- 🔐 **Admin panel** — a built-in, password-protected admin panel (`/admin`) for site
  administrators (the `board` role) to manage everything without touching code,
  including the official-mode toggle

Homeowners can create accounts (verified against the owner roster via a one-time code) to access
homeowner-only content. When the board enables official mode, verified homeowners can also conduct
supported association business such as granting or revoking a proxy for a lot they control. If the
separate live-voting setting is also enabled, eligible homeowners can cast final election ballots
and member-motion votes for their own lots or proxies they hold. Content visibility has three tiers:
public, homeowner, and board.

## Tech stack

| Concern            | Choice                                                                                                                                                              | Cost        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Framework          | [Astro](https://astro.build) (SSR) + React                                                                                                                          | Free        |
| Hosting / runtime  | [Cloudflare Workers](https://workers.cloudflare.com)                                                                                                                | Free tier   |
| Database           | [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite, Drizzle ORM)                                                                                        | Free tier   |
| File storage       | [Cloudflare R2](https://developers.cloudflare.com/r2/)                                                                                                              | Free tier   |
| Sessions           | [Cloudflare KV](https://developers.cloudflare.com/kv/)                                                                                                              | Free tier   |
| Auth               | [Better Auth](https://www.better-auth.com) (email/password)                                                                                                         | Free        |
| Verification email | [Resend](https://resend.com)                                                                                                                                        | Free tier   |
| Verification SMS   | [Twilio](https://twilio.com)                                                                                                                                        | ~1¢/text    |
| Bot protection     | [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/)                                                                                                | Free        |
| Calendar / Meet    | Public Google Calendar                                                                                                                                              | Free        |
| Contact email      | [Web3Forms](https://web3forms.com) → Gmail                                                                                                                          | Free        |
| AI doc assistant   | [Cloudflare AI Search](https://developers.cloudflare.com/ai-search/) (retrieval) + [Anthropic Claude](https://www.anthropic.com) (generation), optional, board-only | Pay-per-use |

The whole site runs on free tiers with **no recurring cost** (Twilio SMS is ~1¢ per
text; the optional AI document assistant is pay-per-use against the Anthropic API; a
custom domain is optional, ~$10–15/yr).

## Getting started

See **[SETUP.md](./SETUP.md)** for setup and deployment guidance. The public architecture overview
lives in [docs/architecture.md](./docs/architecture.md).

This project targets the Node version in [`.nvmrc`](./.nvmrc) (run `nvm use`).

Quick commands:

```bash
npm install        # install dependencies
npm run dev        # local dev server at http://localhost:4321
npm run build      # build the SSR Worker to dist/
npm test           # run the Vitest spec suite
npm run check      # TypeScript 7 + Astro type checks
npm run lint       # type-aware Oxlint correctness and React Hooks checks
npm run format     # format all files with Prettier
npm run docs:dedupe # dry-run document duplicate report
npm run deploy     # build + deploy to Cloudflare Workers
```

## Testing & formatting

- **Tests:** [Vitest](https://vitest.dev) + [Testing Library](https://testing-library.com).
  Component specs live next to each component (`*.test.tsx`); unit tests live under
  `test/unit/`; Worker/D1 integration tests live under `test/server/` and run via
  `npm run test:server`. Run `npm test` (or `npm run test:watch`).
- **Formatting and linting:** [Prettier](https://prettier.io) with `prettier-plugin-astro`, plus
  type-aware Oxlint using the TypeScript 7 `typescript-go` backend. Run `npm run format` and
  `npm run lint`; CI enforces both.
- **Type checking:** The project compiler is TypeScript 7. Until Astro supports its native
  compiler API, `npm run check` generates Astro's project types, runs TypeScript 7 directly, and
  scopes TypeScript 6 only to the temporary `vendor/astro-check-ts6` adapter used for `.astro`
  diagnostics.
- **CI:** `.github/workflows/build.yml` runs format, lint, type checks, tests,
  and build on every push and pull request. CodeQL code scanning runs via GitHub's
  default setup (configured in repo Settings — there is intentionally no CodeQL
  workflow file in the repo). Deploys from `main` are handled by Cloudflare Workers
  Builds, not a GitHub deploy workflow.

## Project layout

```
src/
  pages/              Astro pages + API routes (SSR)
    api/              Same-origin API endpoints (content, admin, auth, verify, files)
  layouts/            Shared page shell
  components/         Header/Footer + React islands
    admin/            The board admin app
    member/           Verified-homeowner islands
  lib/                Client helpers (content.ts, admin.ts, member.ts, site.ts, format.ts,
                      types.ts, reports.ts, auth-client.ts)
  server/             Server-only code
    ai/               Board-only document assistant + report generator: AI Search
                       retrieval, PII pseudonymization, Anthropic client, orchestration
    auth/             Better Auth config, Resend + Twilio senders
    authz/            getAuthContext, role/board/member API guards, Turnstile check
    content/          Visibility logic (tierAllows / visibleTiers) + read helpers
    db/               Drizzle schema, client (getDb), migrations/
    roster/           Owner roster helpers
    verification/     One-time code flow
  styles/             Global CSS
wrangler.toml         Cloudflare bindings (D1, KV, R2, AI)
drizzle.config.ts     Drizzle ORM config
src/server/db/migrations/   D1 migration files
```

## How content is edited

Board members go to `/admin`, sign in with their email + password (Better Auth), and manage
announcements, documents, duplicate cleanup, dues, site text, the board roster, meetings,
resolutions, recorded and conducted elections, proxies, and saved AI reports through on-screen
forms. Board admin sign-in access itself is also managed in the admin app, under **Board access**: a board
admin can promote another account to `board` and demote a board admin (the last
remaining board admin can't be demoted), which supports handing the site off to a new
board over time. A board admin can't escalate their own access beyond `board`, and
the Better Auth admin plugin's impersonation/ban/set-role endpoints are not granted to
board sessions. A separate **The Board** tab records who serves on the board and their terms of
service, independent of who can sign in. The _first_ board account is bootstrapped through a
permanent, fail-closed `POST /api/bootstrap/board` endpoint that self-disables once any board
account exists — see SETUP.md §6.

## Live voting workflow

Live voting remains disabled by default and should stay disabled until the association formally
adopts the process and the board is ready to operate it. The board workflow is:

1. In **Site settings**, enable official mode and then **Live voting**. Both settings must be on to
   open an occasion or accept a cast. Turning either one off globally pauses every open occasion
   without closing it or deleting its frozen electorate, turnout, votes, or choices; restoring both
   settings resumes an occasion that is still open.
2. For an election, create a **Conducted** draft in **Elections**, choose public or homeowner
   visibility, and add the candidates. **Open** freezes the active lots and their voting weights.
   The **Active** view shows turnout by lot count and weight plus the turnout/eligibility registers,
   but never live candidate totals or a lot-to-choice link. **Close** is final, derives candidate
   totals, and moves the election to **History**, where the existing certify/uncertify/void record
   workflow continues; a conducted election cannot reopen.
3. For a member motion, create or edit the motion under a draft member meeting, then use **Open
   voting**. First open freezes the same active-lot denominator. The board can monitor the recorded
   motion tally and frozen eligible weight, **Close voting**, and **Reopen voting** while the meeting
   remains draft; reopening retains the original snapshot and votes. The bulk vote editor is not
   available while the motion is open.
4. A verified eligible homeowner follows **Vote** to `/vote`, chooses the lot and owner or valid
   held proxy, selects up to the election's seat count or chooses Yes/No/Abstain for a motion, and
   reviews the selection and provenance in a labeled confirmation dialog. The dialog moves and
   traps keyboard focus, supports Escape or **Go back** cancellation with focus restoration, and
   disables every background voting control while open. It warns that the homeowner cannot change,
   recover, or recast the submitted selection through `/vote`. A successful cast is replaced by a
   receipt containing only the occasion title and lot address, never the selection. For conducted
   elections, choices are then undisplayable and irreplaceable throughout the application; a vote
   on a member motion remains attributable and can be corrected by the board after voting closes.

## Contributing & support

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for the workflow and local
checks, and [AGENTS.md](./AGENTS.md) for the architecture and conventions. Future work is tracked
in [ROADMAP.md](./ROADMAP.md), and durable architecture decisions live in
[docs/adr](./docs/adr/README.md).
By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md). For help and bug
reports, see [SUPPORT.md](./SUPPORT.md); report vulnerabilities privately per
[SECURITY.md](./SECURITY.md). Shipped changes are tracked in the [changelog](./CHANGELOG.md).
