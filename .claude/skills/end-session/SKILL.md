---
# GENERATED — do not edit. Source: .agents/skills/end-session/SKILL.md
name: end-session
description: End the day's work session cleanly — capture what was learned into memory, bring GitHub issues and private/ docs up to date, and clean the local workspace. Use when the user says "end session", "wrap up", "done for the day", or asks to clean things up before stopping.
---

# End session

The charter, verbatim:

> clean up the local workspace, update any private/ docs and/or github issues that need it from
> this session.

**Announce at start:** "I'm using the end-session skill to close out this session."

## Why this exists

A session's durable output is not just the diff. It also produces things that live in four places
outside the tracked tree, each of which rots silently if nobody writes to it: **memory** (what you
now know about this project that the code doesn't say), **GitHub issues and the project board**
(two trackers and the ordered view across them — decisions, follow-ups, closures, and
gates), **the private companion and `private/`** (operator procedures, evidence, and
anything resident-data-derived, which is gitignored and therefore invisible to every code review),
and the **local workspace** (scratch files, stale worktrees, generated-tree drift that fails the
next session's CI for reasons that have nothing to do with it).

This skill is a sweep over those four, in that order, at the end of a work session.

## Ground rules

- **Nothing invented.** If a lane has nothing to record, say "nothing to record" for that lane and
  move on. A speculative memory or a filler issue comment is worse than silence.
- **Nothing destroyed without a yes.** Every deletion or discard is shown as a list first.
- This skill does **not** push, merge, or open PRs — `/ship` owns that — and does **not** rewrite
  `AGENTS.md`, `README.md`, `SETUP.md`, `SECURITY.md`, or `CHANGELOG.md`, which belong to `/ship`'s
  `docs-updater` pass.

## Steps

### 1. Scope the session

Establish what actually happened before writing anything. Read the conversation, and confirm it
against the repo:

```bash
git status --porcelain
git branch --show-current
git log --oneline main..HEAD          # this branch's commits
git log --oneline --since=midnight    # anything landed today, any branch
gh pr list --author @me --state all --limit 5
```

Then name, out loud, the session's four buckets: what was **learned**, what **issue** work it
touched, what **operational/private** state it changed, and what **files** it left behind. The rest
of the skill works that list.

### 2. Update memory

Memory lives outside the repo, in this project's memory directory
(`~/.claude/projects/C--Users-jerry-OneDrive-Documents-VSCodeProjects-valleys-at-ashebrook-hoa/memory/`),
one fact per file with `name` / `description` / `metadata.type` (`user`, `feedback`, `project`,
`reference`) frontmatter, indexed by a one-line pointer in `MEMORY.md`.

- **Prefer updating an existing file to creating a new one.** This repo's long-running memories are
  the usual landing spots: `adr0022-migration-program.md` (migration phase state — the flip is
  executed, phase 4 / #212 is what remains), `workers-scripts-windows-traps.md` (D1, Wrangler,
  Windows, and Vitest traps), `changelog-per-release-tag.md`, `main-branch-protection-ruleset.md`,
  `codex-vs-claude-agent-asset-paths.md`, `subagent-model-preference.md`.
- **Don't save what the repo already records.** `AGENTS.md`, `CONTEXT.md`, `docs/adr/`, the
  changelog, and git history are already durable — this repo's `AGENTS.md` in particular is
  extremely detailed. Memory is for what _isn't_ written down: a trap that cost an hour, a
  preference the user stated, a constraint discovered in production.
- Convert relative dates to absolute (`today` → `2026-08-20`), and link related memories with
  `[[slug]]`.
- **Delete or correct memories this session falsified.** A memory that is now wrong is worse than a
  missing one — the deploys-don't-apply-migrations correction is the standing example.

### 3. Update GitHub issues and the project board

Issues are the tracker (`docs/agents/issue-tracker.md`); labels are in
`docs/agents/triage-labels.md`. Use `gh`, which infers the repo from the clone.

**There are two trackers.** Inferring the repo from this clone gives you the public one, which is
right for almost everything. Work whose _body_ cannot be public — production identifiers, resident
data, operator procedure detail, unfixed security specifics — belongs in the private operations
repository instead (`--repo jwh3times/valleys-at-ashebrook-hoa-ops`, or run from `private/`). The
routing rule is in `docs/agents/issue-tracker.md`.

For each issue this session touched:

- **Record decisions where the code cites them.** This codebase cites issue numbers as the durable
  record of a decision (`#202`/`#204`/`#206` are quoted throughout `AGENTS.md`). A decision reached
  in conversation and never commented onto its issue is effectively lost:
  `gh issue comment <n> --body "..."`.
- **Close what shipped**, with a comment saying what landed and where:
  `gh issue close <n> --comment "..."`. If the work is merged but a follow-up remains, close it and
  open the follow-up rather than leaving a half-done issue open.
- **Open issues for deferred work discovered this session** — the thing you noticed and decided not
  to do now: `gh issue create --title "..." --body "..."` with a heredoc for the body.
- **Fix labels** so the next AFK pass sees the truth — `gh issue edit <n> --add-label ...` and
  `--remove-label ...`, using the strings in `docs/agents/triage-labels.md` (`needs-triage`,
  `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`).
- If the session used a wayfinder map, append to its Decisions-so-far and close resolved children
  per the wayfinding section of `docs/agents/issue-tracker.md`.

Then update the **board** — [Ashebrook](https://github.com/users/jwh3times/projects/6), the private
ordered view across both trackers. The issue stays the record; these fields are only what makes the
next session cheap to start:

- **Move what changed.** `Status` for items that started or finished. `Gate` only for an item whose
  blocker genuinely opened or closed — a board decision taken, an upstream release, a spec written.
  Do not re-gate an item because it feels stuck.
- **Refresh `Next Action` and `Blocking Item`** on anything this session touched. A stale Next
  Action is worse than an empty one, because it will be believed.
- **Add any issue you opened above.** A new issue does not join the board on its own.

`gh project` writes need the `project` token scope and **fail silently without it** — the
`gh project` call errors, nothing else does, and the session still looks clean. That is how the
previous board drifted for weeks. Check `gh auth status` for `project` (not `read:project`); if it
is missing, say so in the report rather than skipping this lane quietly. The fix
(`gh auth refresh -h github.com -s project`) needs a real terminal and cannot be done from an agent
shell.

### 4. Update the private companion and `private/`

Durable private TEXT lives in the private companion repository, cloned into the gitignored `private/` by
`npm run bootstrap:private` (its locator comes from 1Password and is never committed here). It is versioned: commit and push it before ending the session. Resident-derived
artifacts, generated import SQL/manifests, and other records also live under `private/` (the
default `ASHEBROOK_PRIVATE_ROOT`) but are ignored by the companion's `.gitignore` and must never be
committed to it — check `git -C private status` shows none of them.

What lives in the companion and what changes it:

- **`operations/OPERATIONS.md`** — production identity, roster import, and the post-flip
  removal/erasure procedure. Update it when the session changed an operator procedure, a resource
  name, or a bootstrap/backup step.
- **`operations/recovery.md`** and **`operations/cross-computer-portability-plan.md`** — the
  fresh-workstation runbook and the portability plan's "Resume Here" checkpoint. Update the
  checkpoint (last checkpoint, current work item, status table, execution log) whenever a phase's
  state changed.
- **`operations/history/`** — cutover execution records (`RUNBOOK.md`, `EVIDENCE-LOG.md`,
  `ALLOW-LIST.md`). Append evidence when the session produced any (an invariant run, a sweep
  result, a measurement).
- **`handoffs/`** — the current resumable session context; archive superseded ones under
  `handoffs/archive/`.
- **`incidents/`**, **`research/`**, **`design-history/`**, **`inventories/`** — private analyses,
  research, reviewed plans/specs, and non-resident migration manifests.
- **`config/1password/`** — unresolved `op://` templates only. Add a variable there (and in the
  matching Ashebrook item) when the session introduced a new secret or binding.

Before committing the companion, inspect the staged diff for credentials, personal data, sensitive
filenames, production identifiers, and undisclosed vulnerabilities — its `.gitignore` rejects the
obvious file types, not their contents. Dumps and backups go to encrypted records storage per the
portability plan, never to either Git repository.

Also sweep the other direction: if this session left a scratchpad, security review, runbook, or
anything resident-data-derived **in the tracked tree**, move it to the companion (text) or under
`private/` (records), or delete it now. That rule is in `AGENTS.md` and a gitignored file can't be
caught by review.

### 5. Note (don't write) public-doc debt

If the session made a durable architectural decision with no ADR, or introduced vocabulary missing
from `CONTEXT.md`, say so and record it as an issue — `/domain-modeling` writes `docs/adr/` and
`CONTEXT.md`, and `/ship` refreshes `AGENTS.md` and friends. Don't do either job here.

### 6. Clean the local workspace

Show findings before acting. Work through:

- **Uncommitted work** — `git status --porcelain`. Ask what to do with it; never commit silently and
  never discard. If it's mid-flight work the user is returning to, leaving it dirty is a valid
  answer, but say so in the report.
- **Untracked strays** — `git status --porcelain --untracked-files=all` and `git clean -nd`
  (dry run). Show the list and get a yes before `git clean -fd`. **Never `git clean -x`**: the
  ignored set here includes `private/`, `.dev.vars`, `.env`, `.wrangler/`, and `node_modules/`.
- **Scratch areas this repo declares** — `.scratch/`, `.superpowers/`, `docs/superpowers/`, and the
  OS temp scratchpad for this session. Clear finished scratch; keep anything a live branch depends
  on.
- **Stale worktrees and branches** — `git worktree list`, then `git worktree remove <path>` and
  `git worktree prune` for finished ones; `git branch --merged main` to spot local branches whose
  PR already merged (`gh pr merge --merge --delete-branch` removes the remote side at merge time,
  not the local one).
- **Generated-tree and formatting drift** — leaving it red makes the next session's CI fail for
  unrelated reasons:

  ```bash
  npm run sync:agents -- --check   # .claude/skills + .codex/agents match .agents/skills + .claude/agents
  npm run format:check             # Prettier over the whole repo
  npm run types:worker:check       # generated Cloudflare types match wrangler.toml + .env.example
  ```

  Fix with `npm run sync:agents`, `npm run format`, `npm run types:worker`. Never hand-edit
  `.claude/skills/` or `.codex/agents/` — they are generated (ADR 0021).

- **Nothing staged that must never be committed** — `git diff --cached --name-only` must contain no
  `private/`, `.env`, `.dev.vars`, `dist/`, `.wrangler/`, roster/dump SQL, or any file with real
  resident data.

### 7. Report

One short paragraph per lane — memory, issues and board, private companion, workspace — naming what
changed and what was deliberately left alone. Say explicitly if the board lane was skipped for a
missing `project` scope; that is the one failure that otherwise looks identical to success. End with
**what's still open**: the branch mid-flight, the unanswered question, the issue awaiting a reply.
That paragraph is what makes the next session cheap to start.

## Do not

- Push, merge, or open PRs — that's `/ship`.
- Run anything that touches production data: `npm run db:migrate:remote`, `npm run roster:backfill
--write`, `npm run shadow:sweep --remote`, or any `wrangler ... --remote` write. Post-flip these
  reach live resident data; a cleanup pass has no business there. (`npm run verify:invariants
--remote` is read-only and fine if the user asks.)
- Move anything out of `private/` into the tracked tree.
- Delete uncommitted or untracked files without showing the list first.
- Invent memories, issue comments, or `private/` entries to make a lane look productive.
