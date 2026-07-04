# Roadmap Status & Handoff

**Updated:** 2026-07-04

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

## Next — remaining §3 items (priority order), with blockers

1. **§3.1 Flip CSP to enforced.** One-line change in `src/middleware.ts`
   (`Content-Security-Policy-Report-Only` → `Content-Security-Policy`). **BLOCKED / gated:** the real
   work is verifying no legitimate resource is blocked — needs production CSP-violation observation
   (open question #2). Don't merge until the operator confirms a clean report window.
2. **§3.2 Verification-flow polish (#14).** Three parts: reset the Turnstile widget on a spent token,
   name the (masked) requester in the OTP message, and a post-confirm redirect/success state. **One
   product decision:** redirect target (`/documents` vs. a dedicated "you're verified" page — plan
   default: success state then `/documents`).
3. **§3.7 D1 constraints & indexes (#8).** Add Drizzle `uniqueIndex`/`index` defs + migration
   `0003`. **BLOCKED on data audit:** run the duplicate check against **remote** D1 first —
   `wrangler d1 execute ashebrook-hoa --remote --command "SELECT addressNormalized, count(*) c FROM properties GROUP BY 1 HAVING c>1"` — before shipping the unique on `properties.addressNormalized` (open question #3).
4. **§3.4 Seed-board bootstrap hardening (#21).** New fail-closed `POST /api/bootstrap/board`
   endpoint (self-disabling once a board exists) + secrets; retire the temp-route runbook.
5. **§3.13 Custom 404 + robots.txt + sitemap (#16)** — small, SEO.
6. **§3.10 Server-render public content (#12)** — biggest UX/SEO win; frontmatter reads.
7. **§3.11 Signed-in user presence in the chrome (#13).**
8. **§3.12 Consolidate duplicated UI logic (#15).**
9. **§3.5 Admin-managed disclaimer / About copy.**

§4 is design-gated backlog (Google Drive import, per-owner private data, tenants/payments, cron
cleanup, deploy workflow, PII stance note) — each needs its own spec or an operator/board decision.

## Gotchas for a resuming agent

- **Auth in tests:** post-§3.3 you can inject a board caller via `locals: { authContext: { userId, role: 'board', propertyIds: [] } }`, **or** keep the existing module-level
  `vi.mock('../../src/server/authz/context', () => ({ getAuthContext: async () => ({...}) }))` pattern
  (routes fall back to `getAuthContext` when `locals` is absent).
- **Input validation** lives in `src/lib/types.ts` (`normalize*Input`, `INPUT_LIMITS`) with malformed-body
  helpers in `src/server/http.ts` (`readJson`, `stringField`). Extend that pattern rather than adding a
  validation library.
- **CSP directive list** is in `src/middleware.ts`; changing third-party resources means updating it.
- **Dependabot #26** (`@cloudflare/workers-types` 4→5, a **major** bump) is open and unreviewed — verify
  the build/types before merging; not part of this roadmap.
- The `docs-updater` project subagent is **not** invokable via the Agent tool's `subagent_type`; use a
  `general-purpose` agent and have it read `.claude/agents/docs-updater.md` for conventions.
