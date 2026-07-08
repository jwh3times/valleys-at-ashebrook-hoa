# Roadmap Status & Handoff

**Updated:** 2026-07-08

This is the **resume point** for executing [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md)
(the outstanding-roadmap plan). Read this first, then the plan for per-item detail. The plan itself
carries authoritative status (per-item `Status: Done` headers and the §1/§2 tables); this file is the
short "where are we, what's next, what to watch out for" overview.

## How this roadmap is being executed

- **One small PR per §3 item, off `main`.** Each item is independent; land them **sequentially**.
- **Every §3 item edits `CHANGELOG.md` `[Unreleased]`**, so two open branches collide there. Merge
  one, then branch the next off the updated `main`. (Conflicts are trivial/additive — keep both
  bullets, Keep-a-Changelog order: Added, Changed, Removed, Fixed, Security.)
- **Test-driven.** Write the failing test first (unit in `test/unit/**`, Worker/D1 in
  `test/server/**`), watch it fail, then implement.
- **Full gate before every push:**
  `npm run format:check && npm run check && npm test && npm run test:server && npm run build`.
- **Merging:** auto-merge is **disabled** on this repo and branch protection requires CI (`build` +
  CodeQL `Analyze` + `Workers Builds`) to pass. Merge with
  `gh pr merge <n> --merge --delete-branch` once checks are green. Do **not** use `--admin` to bypass
  CI unless the user explicitly asks.
- Commit-message conventions are given per item in the plan (e.g.
  `fix(admin): … (#9)`), ending with the `Co-Authored-By` trailer.

## Done — merged to `main`

| Item | Finding | PR | Summary |
| --- | --- | --- | --- |
| §3.9 | #11 | #33 | `GET /api/content/documents` projects only the `DocumentItem` contract (no r2Key/filename/sizeBytes/contentType leak). |
| §3.14 | #18 (2/3) | #34 | `[observability]` (Workers Logs) enabled; stray `console.log` removed. Cron cleanup is still §4.7. |
| §3.15 | #19 | #35 | Firebase `.gitignore` block dropped; `SESSION` binding + `requirePropertyAccess` proved load-bearing and were **documented in place**, not removed. |
| §3.3 | #10 | #36 | `resolveAuthContext(locals, request, env)` — routes resolve the caller once from `locals.authContext` (middleware-first, fail-closed fallback); `requireBoard` takes `locals`. |
| §3.6 | — | #37 | Docs sync: `SECURITY.md` + `CHANGELOG.md` brought current with the P0 hardening; plan status updated. |
| §3.8 | #9 | #38 | Reject-loud admin-write input normalizers (`normalize{Announcement,Property,Owner}Input`, `INPUT_LIMITS`), `readJson` malformed-body guards, public `?limit` clamp, members-approve property check (404/409). |
| §3.2 | #14 | #40 | Verification polish: Turnstile widget reset on a spent token, masked-email OTP requester line, and a post-confirm success state + homeowner redirect. |
| §3.4 | #21 | #41 | Fail-closed first-board bootstrap endpoint `POST /api/bootstrap/board` (self-disabling once a board exists); retires the temp-route runbook. |
| §3.13 | #16 | #42 | Custom 404 page + `public/robots.txt` + an SSR `/sitemap.xml` route. |
| §3.7 | #8 | #43 | D1 uniqueness + hot-path indexes (migration `0003`) across the roster/verification/content tables. |
| §3.7 follow-up | #8 | — | App-owned D1 foreign keys added for owners, property links, verification rows, and manual approvals; pre-migration orphan audit documented in `scripts/audit-orphans.sql`. |
| — | — | #44 | Follow-up: reconciled the Drizzle meta snapshots so `npm run db:generate` works again. |
| §3.10 | #12 | #45 | Server-render public announcements/documents/dues in Astro frontmatter (SSR/SEO win). |
| §3.11 | #13 | #46 | Signed-in account presence in the header + `SignOutButton`. |
| §3.12 | #15 | #47 | Shared `useAdminResource` hook consolidated across the six admin managers. |
| §3.5 | — | #48 | Board-editable disclaimer + About copy (settings-backed, with hardcoded fallbacks). |
| §3.1 | #3 | #49 | CSP flipped from Report-Only to enforced; the Cloudflare Web Analytics beacon is now allowed. |
| — | — | #50 | Follow-up: added `http://localhost:4321` to Better Auth `trustedOrigins` so local dev sign-in works. |

## §3 is complete — remaining work is the §4 backlog

Every §3 item is merged to `main` (see the table above). The §3.1 CSP flip is done: a window of
production `Content-Security-Policy-Report-Only` observation caught the Cloudflare Web Analytics
beacon, which is now explicitly allowed in the enforced policy — so the CSP is served enforced with
no legitimate resource blocked.

The only remaining roadmap work is the **§4 backlog**, which is design-gated: each item needs its
own spec under `docs/superpowers/specs/` or a board/operator decision before build.

- **§4.1 Google Docs/Sheets/Drive import** — service-account export pipeline into the existing document store.
- **§4.2 Per-owner private data** (dues balances / violations) — blocked on a board decision to publish per-owner data at all.
- **§4.3 Roster quality-of-life** — bulk import UI, ownership transfer, `Account #` capture.
- **§4.4 Homeowner uploads / signed-PUT large files** — dormant until the 25 MB body cap bites.
- **§4.5 Tenants/renters accounts; online payments; OCR/AI assistant** — each board-decision- or spec-gated.
- **§4.6 Operational (non-code)** — HSTS zone toggle; GitHub repo + Cloudflare D1/R2 resource renames.
- **§4.7 CI/CD rounding-out + scheduled cleanup cron — DONE in this close-out.** Coverage thresholds are set from the measured baseline, daily verification/manual-approval cleanup runs through the custom Worker `scheduled()` handler, and deploy-on-main remains intentionally handled by Cloudflare Workers Builds while GitHub Actions stays the verification gate.
- **§4.8 PII stance note — DONE** in this close-out: roster data handling, neighbor removal requests, and backup/retention are documented in `SETUP.md` §5 and `SECURITY.md`.

## Gotchas for a resuming agent

- **Auth in tests:** post-§3.3 you can inject a board caller via `locals: { authContext: { userId, role: 'board', propertyIds: [] } }`, **or** keep the existing module-level
  `vi.mock('../../src/server/authz/context', () => ({ getAuthContext: async () => ({...}) }))` pattern
  (routes fall back to `getAuthContext` when `locals` is absent).
- **Input validation** lives in `src/lib/types.ts` (`normalize*Input`, `INPUT_LIMITS`) with malformed-body
  helpers in `src/server/http.ts` (`readJson`, `stringField`). Extend that pattern rather than adding a
  validation library.
- **CSP directive list** is in `src/middleware.ts`; the policy is now **enforced** (not Report-Only, per
  PR #49) and includes the Cloudflare Web Analytics beacon — adding a third-party resource means updating
  the directive list *and* re-verifying nothing is blocked before deploy (one-line revert to Report-Only if it is).
- **`npm run db:generate` works again** — PR #44 reconciled the drifted Drizzle meta snapshots; the
  roster/verification/content indexes shipped as migration `0003` (§3.7), so regenerate from a clean baseline.
- **Before remote FK migration:** run
  `npx wrangler d1 execute ashebrook-hoa --remote --file scripts/audit-orphans.sql` and confirm every
  `orphan_count` is `0`, then apply the D1 migrations.
- **Dependabot #26** (`@cloudflare/workers-types` 4→5, a **major** bump) is open and unreviewed — verify
  the build/types before merging; not part of this roadmap.
- The `docs-updater` project subagent is **not** invokable via the Agent tool's `subagent_type`; use a
  `general-purpose` agent and have it read `.claude/agents/docs-updater.md` for conventions.
