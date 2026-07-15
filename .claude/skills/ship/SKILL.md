---
name: ship
description: Ship the current branch — refresh docs, write the CHANGELOG entry for the version this merge will mint, run fast checks, push, and open or update the PR. Use when a feature branch is ready for review, or when the user says "ship it", "open a PR", or "push this".
---

# Ship

Take the current branch from "code is done" to "PR is open and green-able", and
make sure the changelog names the version this merge will actually create.

**Announce at start:** "I'm using the ship skill to open a PR for this branch."

## Why this exists

Every merge to `main` is auto-tagged `v<major>.<minor>.<build>` by
`.github/workflows/version.yml`, where `build` auto-increments per merge on the
release line. So a branch's changelog entry must be written for **the version its
merge will mint** — a bare `[Unreleased]` entry is always wrong the moment it lands.
`/ship` computes that version and writes the entry, and the `Changelog Version` CI job
(`.github/workflows/changelog.yml`) verifies the prediction still holds at merge time:
it fails the PR unless `CHANGELOG.md` has a `## [<target>]` section for the version this
merge will mint. That guard **exempts dependabot**, which is exactly why the backfill in
step 2 exists.

## Steps

### 1. Preconditions — stop if any fail

- **Not on `main`.** `main` is protected; work must be on a branch. If on `main`,
  stop and offer to create one (`git checkout -b <topic>`).
- **Clean working tree.** Run `git status --porcelain`. If anything is uncommitted,
  stop and ask the user whether to commit it — do not commit silently.
- **`gh` authenticated.** `gh auth status` must succeed.

### 2. Backfill any undocumented released versions

Compare git tags against `CHANGELOG.md`:

```bash
git fetch --tags -q origin
git tag -l "v*" --sort=v:refname | tail -8
sed -nE 's/^## \[([0-9]+\.[0-9]+\.[0-9]+)\].*/\1/p' CHANGELOG.md | head -8
```

Any tag with **no** matching `## [x.y.z]` section is a released version with no entry —
in practice a merged dependabot PR, which the `Changelog Version` guard exempts.
Backfill each one now: read what that tag actually changed (`git show --stat <tag>`,
plus the `package.json` diff for dependency bumps) and add a dated section for it in the
right position, newest-first. Keep it factual — name the packages and versions.

This is what makes the bot exemption safe. Skipping it lets the changelog silently lose
versions.

### 3. Compute the target version

```bash
bash scripts/next-version.sh
```

This prints a bare SemVer (e.g. `0.3.21`) — no `v` prefix. The script mirrors the
tag-creation algorithm in `.github/workflows/version.yml` (the workflow that actually
mints the tag). Do not compute this yourself — run the script so `/ship` and the
workflow agree.

Note: to bump the **minor or major** line, edit `package.json`'s `version` to
`x.y.0` first (e.g. `0.4.0`); then the script predicts `0.4.0` for the first merge on
that line. Otherwise the build number just increments on the current line.

### 4. Refresh the docs

Invoke the `docs-updater` subagent, scoped to **this branch's diff only** — not a
full audit:

```bash
git diff $(git merge-base main HEAD)..HEAD --stat
```

Tell it exactly what changed and let it update the docs it owns: `AGENTS.md`,
`README.md`, `SETUP.md`, `SECURITY.md`. It owns `CHANGELOG.md` too, but **you** write
the changelog section in step 5 — tell it to **leave `CHANGELOG.md` alone** so you
don't fight over the file. (It does not maintain `design/` or `docs/superpowers/`.)

### 5. Write the CHANGELOG entry

Insert a section for the target version immediately below `## [Unreleased]`:

```markdown
## [Unreleased]

## [0.3.21] - 2026-07-15

### Added

- ...
```

Rules:

- `## [Unreleased]` **stays**, left empty (no placeholder text). This is the
  convention the file already uses — the new dated section goes directly beneath it.
- Date is today, `YYYY-MM-DD`.
- Group under Keep a Changelog headings — `Added`, `Changed`, `Fixed`, `Removed`,
  `Security`. Use **one** heading of each kind per section.
- Describe user-visible behavior and its consequences, derived from the branch diff —
  match the prose style of existing entries (a sentence or two per change, bold lead-in
  for the headline change). Not a commit log.
- **Idempotent:** if you already wrote a section for this version on a previous
  `/ship` of this branch, **rewrite it in place** — never stack a second one. If the
  target version changed since last time (someone else merged first, so
  `next-version.sh` now prints a higher number), renumber the existing section rather
  than adding a new one — the `Changelog Version` CI job fails a PR whose section no
  longer matches the version its merge will mint, so renumbering is what turns it green.

### 6. Fast checks — refuse to push if any fail

The full `test`, `test:server`, and `build` suites are **not** run here; CI owns them.
These are the cheap gates that catch most mistakes in seconds:

```bash
npm run format:check   # Prettier over the WHOLE repo — .md, .astro, .ts, .tsx, .json, .css
npm run check          # astro check (Astro + TypeScript type check)
```

`npm run format:check` is a single project-wide command that covers the docs and
changelog you just edited (there is no separate markdown run to forget). Run it
**after** the step 4/5 edits. Fix formatting with `npm run format` (writes in place).
If either check is red, stop and report — do not push.

### 7. Commit the docs and changelog

```bash
git add -A
git commit -m "docs: update docs and changelog for v<version>"
```

### 8. Push and open or update the PR

```bash
git push -u origin "$(git branch --show-current)"
```

Then check whether a PR already exists for this branch:

```bash
gh pr list --head "$(git branch --show-current)" --state open --json number -q '.[0].number'
```

- **No PR** → `gh pr create --base main` with a title and a body derived from the
  changelog section you just wrote.
- **PR exists** → `gh pr edit <number>` to refresh the body. Do not open a second PR.

### 9. Report

Give the user: the PR URL, the version this merge will mint, and anything the fast
checks or backfill surfaced. State plainly that `test`, `test:server`, and `build`
run in CI, not locally — do not imply the branch is verified beyond the fast checks.

## Do not

- Merge the PR. `/ship` stops at "PR open".
- Push to `main`.
- Run the full test/build suites — that is CI's job and it makes this skill slow.
- Invent the version number. Always call `scripts/next-version.sh`.
