# Docs

Settings the shared `docs-updater`, `end-session` and `ship` skills read (installed from
`jwh3times/skills`, ADR 0029). Each `##` heading is one setting.

## Doc map

- `AGENTS.md` — loaded on every turn, so only what binds **every** change: commands, coding rules,
  architecture at altitude, roles, the glossary, testing, deploy, and the pointer table into
  `docs/agents/`. Detail belongs in `docs/agents/`; add a new surface as a `docs/agents/` file plus
  one pointer row, not a new section. **When:** an npm script is added or renamed (the Commands
  block); a Cloudflare binding or secret changes (the bindings paragraph); the two-layer API gating
  pattern changes; roles, visibility tiers, official mode or the verification flow change ("What
  This Is", Roles and access); a skill or agent is added, removed or replaced ("Agents & Docs
  Automation").
- `docs/agents/http-endpoints.md` — each route's contract: guard order, status codes, re-checks.
  **When:** an endpoint under `src/pages/api/**` is added or changed.
- `docs/agents/data-model.md` — each table's entry. **When:** `src/server/db/*schema.ts` changes.
- `docs/agents/migrations.md` — the migration ledger; a described entry only when one rebuilds
  tables or breaks the safe-in-either-order rule. **When:** a migration lands under
  `src/server/db/migrations/`.
- `docs/agents/module-map.md` — a map, not an index. **When:** a module under `src/lib/` or
  `src/server/` lands whose purpose or boundary its filename does not make evident.
- `docs/agents/roster-and-access.md` — authorization, the roster, Access Grants, the write freeze.
  **When:** any of those changes.
- `docs/agents/voting-and-ballots.md` — elections, motions, ballots, voting flags. **When:** any of
  those changes.
- `docs/agents/ci-and-release.md` — the pipeline, versioning, the changelog guard, Dependabot.
  **When:** CI, Dependabot, versioning or the changelog workflow changes.
- `docs/agents/dev-flow.md`, `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`,
  `docs/agents/domain.md` — the conventions the flow skills read. **When:** a convention or route changes.
- `docs/agents/` settings (`workspace`, `human-follow-up`, `docs`, `releases`, `ship`, `handoffs`,
  and the settings sections of `issue-tracker`) — what the shared skills read. **When:** a setting
  changes.
- `README.md` — human developers: overview and local setup. **When:** a setup step or an npm script
  that is part of setup changes.
- `SETUP.md` — the deployer's guide: Cloudflare resources, secrets, roster import, docs import.
  **When:** a resource, secret, command or port actually changes — a binding or secret in
  `wrangler.toml`, a new migration step that changes deployment. Touch its steps for nothing else.
- `SECURITY.md` — the reporting process, consistent with the roles and visibility model. **When:**
  the auth, visibility or access model changes.
- `CONTRIBUTING.md` — the workflow and standards. **When:** the development flow or a required check
  changes.
- `SUPPORT.md` — where to ask for help. **When:** the issue templates or the support route change.
- `CODE_OF_CONDUCT.md`, `LICENSE` — `owner-only`.
- `THIRD_PARTY_NOTICES.md` — the license notices of third-party files kept here. `owner-only`: report
  the change when a skill's source changes.
- `ROADMAP.md` — a pointer to the trackers and the board, and the board's vocabulary; it lists no
  work. **When:** where planned work lives, or a board field's meaning, changes.
- `vendor/astro-check-ts6/README.md` — why the Astro checker runs on a TypeScript 6 bridge.
  **When:** the bridge's pins or its wiring into `npm run check` change, or Astro's checker
  supports TypeScript 7.
- `docs/workstation-bootstrap.md` — prerequisites and value-free commands for a new workstation.
  **When:** a prerequisite or bootstrap command changes.
- `CHANGELOG.md` — release notes, one dated section per merge. `ship-owned`.
- `CLAUDE.md` — the Claude Code entry point beside `AGENTS.md`. **When:** only a Claude-specific
  note changes.
- `CONTEXT.md` — the domain glossary, written through `/domain-modeling`. `frozen` for this skill:
  report a term the code contradicts instead of editing it.
- `docs/adr/*.md` — durable decisions, written deliberately, not synced. `frozen`: report a change
  that contradicts an ADR instead of editing it.
- `docs/plans/`, `docs/specs/` — dated historical records. `frozen`.
- `design/` — a reference-only mockup. `frozen`.
- `.agents/skills/*/**` — skills, mirrored to `.claude/skills/`: the `mattpocock/skills` set and
  `end-session`, `handoff`, `lets-go`, `ship` and `docs-updater` from `jwh3times/skills`, all locked
  in `skills-lock.json`. `frozen`. **When:** a skill is added, removed or replaced: `AGENTS.md`'s
  "Agents & Docs Automation" and, for a shared skill, ADR 0029.
- `.claude/agents/code-reviewer.md` — the reviewer's correctness rules. **When:** a rule it reviews
  against changes (tier enforcement, API gating, ballot secrecy, D1 write integrity).
- `private/operations/OPERATIONS.md` — production identity, roster import, the post-flip
  removal/erasure procedure. **When:** an operator procedure, a resource name, or a bootstrap or
  backup step changes.
- `private/operations/recovery.md` and `private/operations/cross-computer-portability-plan.md` — the
  fresh-workstation runbook and the portability plan's "Resume Here" checkpoint. **When:** a phase's
  state changes (the last checkpoint, current work item, status table, execution log).
- `private/operations/history/` — cutover execution records (runbook, evidence log, allow-list).
  `append-only`: add evidence a session produced (an invariant run, a sweep result, a measurement).
- `private/session-history/` — history only; nothing new belongs in it. `frozen`.
- `private/incidents/`, `private/research/`, `private/design-history/`, `private/inventories/` —
  private analyses, research, reviewed plans and specs, non-resident manifests. **When:** a session
  produces one.
- `private/config/1password/` — unresolved `op://` templates only. **When:** a session adds a secret
  or binding (and the matching Ashebrook item).

**Never in public docs:** resident or roster data, production identifiers, operator procedure
detail, the specifics of an unfixed security problem, secret values; historical narrative belongs in
`CHANGELOG.md` and `docs/adr/`, not in either agent doc.

## Drift probes

- API endpoints: `src/pages/api/**/*.ts`
- D1 tables: `sqliteTable\(` in `src/server/db/schema.ts`
- Migrations: `src/server/db/migrations/*`
- npm scripts: `scripts` in `package.json`
- Bindings: `binding` in `wrangler.toml`
- Lib helpers: `src/lib/*.ts`
- CI steps: the `run:` lines of `.github/workflows/build.yml`
- Required status checks: `gh api repos/jwh3times/valleys-at-ashebrook-hoa/rules/branches/main`

## Docs validation

- `node scripts/check-docs.mjs`
- `npm run format:check` — Prettier over the whole repository, Markdown included.
