---
name: ship
description: Ship the current branch — classify its release impact, select the major, minor, or build version this merge will mint, refresh docs and CHANGELOG, run fast checks, push, and open or update the PR. Use when a feature branch is ready for review, or when the user says "ship it", "open a PR", or "push this".
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
`/ship` classifies the branch's release impact, computes that version, and writes the
entry. The `Changelog Version` CI job
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

### 3. Classify the release impact

Review the complete branch diff from `git merge-base main HEAD` through `HEAD`, including
schema, API, configuration, deployment, and user-visible behavior. Ignore mechanical version and
changelog edits as impact evidence. Classify the **project's** release impact — a dependency's own
major/minor label does not decide this:

- **Major:** an incompatible change to a supported application, data, API, configuration, or
  deployment contract that requires consumers or operators to coordinate their upgrade.
- **Minor:** a backward-compatible new capability or material expansion of existing behavior.
- **Build:** fixes, security hardening, dependency updates, docs, tests, refactors, and other
  compatible changes that add no material capability.

Choose the highest impact present in the diff. State the classification and concrete evidence to
the user before continuing. If the evidence is genuinely ambiguous, stop and ask the user to choose.

Use the `package.json` version at the merge base as the release-line baseline. For a major change,
set the next version to `<major + 1>.0.0`; for a minor change, set it to
`<major>.<minor + 1>.0`; for a build change, leave the version unchanged. Apply a major/minor result
idempotently with:

```bash
npm version <exact-version> --no-git-tag-version --allow-same-version
```

This updates both `package.json` and `package-lock.json`. Derive the exact version from the merge-base
baseline, not the branch's possibly already-bumped version, so rerunning `/ship` never advances the
release line twice. If the branch already contains a conflicting release-line change, stop and
surface the mismatch instead of overwriting it.

### 4. Compute the target version

```bash
bash scripts/next-version.sh
```

This prints a bare SemVer (e.g. `0.3.21`) — no `v` prefix. The script mirrors the
tag-creation algorithm in `.github/workflows/version.yml` (the workflow that actually
mints the tag). Do not compute this yourself — run the script so `/ship` and the
workflow agree.

The result must match step 3: a major/minor classification starts the selected line at build
`0`; a build classification increments the current line's build number.

### 5. Refresh the docs

Invoke the `docs-updater` subagent, scoped to **this branch's diff only** — not a
full audit:

```bash
git diff $(git merge-base main HEAD)..HEAD --stat
```

Tell it exactly what changed and let it update the docs it owns: `AGENTS.md`,
`README.md`, `SETUP.md`, `SECURITY.md`. It owns `CHANGELOG.md` too, but **you** write
the changelog section in step 6 — tell it to **leave `CHANGELOG.md` alone** so you
don't fight over the file. (It does not maintain `design/` or `docs/superpowers/`.)

### 6. Write the CHANGELOG entry

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

### 7. Fast checks — refuse to push if any fail

The full `test`, `test:server`, and `build` suites are **not** run here; CI owns them.
These are the cheap gates that catch most mistakes in seconds:

```bash
npm run sync:agents -- --check # generated agent trees match their authored inputs (CI gate)
npm run format:check   # Prettier over the WHOLE repo — .md, .astro, .ts, .tsx, .json, .css
npm run lint:coercions # no `Number(x) || <default>` form coercions (CI gate)
npm run check          # astro check (Astro + TypeScript type check)
```

`npm run format:check` is a single project-wide command that covers the docs and
changelog you just edited (there is no separate markdown run to forget). Run it
**after** the step 5/6 edits. Fix formatting with `npm run format` (writes in place).
If any check is red, stop and report — do not push.

### 8. Commit the release-line, docs, and changelog changes

```bash
git add -A
git commit -m "docs: prepare release v<version>"
```

### 9. Push and open or update the PR

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

### 10. Report

Give the user: the PR URL, the release-impact classification, the version this merge will mint,
and anything the fast checks or backfill surfaced. State plainly that `test`, `test:server`, and
`build` run in CI, not locally — do not imply the branch is verified beyond the fast checks.

## Do not

- Merge the PR. `/ship` stops at "PR open".
- Push to `main`.
- Run the full test/build suites — that is CI's job and it makes this skill slow.
- Invent the version number. Always call `scripts/next-version.sh`.
