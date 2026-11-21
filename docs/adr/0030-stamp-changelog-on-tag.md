# ADR 0030: Each Merge's Changelog Section Is Stamped When It Is Tagged, Not When It Ships

**Status:** Accepted
**Date:** 2026-11-20

Every merge to `main` is a release, and `CHANGELOG.md` gives each one a dated section. Until now the
rule was `per-merge`: `/ship` predicted the version a branch's merge would mint and wrote that
section, and the Changelog Version check failed the PR unless the prediction still held. So every
merge invalidated every open PR's section. Whichever of two open PRs merged second had to renumber
its section, a renumbering once renamed an already-released `[1.0.22]` and deleted it from the
record, and a footer link was missed (v2.11.34). Dependabot PRs were exempt from the check, so they
shipped with no section and the next human PR backfilled them.

A branch no longer names the version its merge will mint. `ship` writes the branch's entries to its
own `changelog.d/<branch-slug>.md` fragment and never edits `CHANGELOG.md`. After the merge,
`.github/workflows/version.yml` runs `scripts/stamp-changelog.mjs`, which turns each untagged
merge's fragments (or, with none, its PR title) into a dated section with its footer link, commits
the sections with `[skip ci]`, and tags the merge commit. The version is still
`scripts/next-version.mjs`'s computation from the `package.json` line, now made once, at tag time,
over the merges in the order they landed. Fragments cannot collide, and a merge that wrote none
still gets a section, so the renumbering, the backfill and the hand-kept footer go away.

The stamp commit goes straight to `main`, which the ruleset otherwise forbids, so `version.yml`
pushes it with a token from a release GitHub App listed as the ruleset's one bypass actor
(`GITHUB_TOKEN` cannot be one). Every first-parent commit on `main` is a release, so the repository
merges with merge commits only. `[skip ci]` keeps the stamp commit from starting `build` or
`Version`, and Cloudflare Workers Builds, which deploys `main` (ADR 0004), skips it as well.
(Corrected 2026-11-20: this record first said Workers Builds might build the stamp commit, since
its documentation names no commit-message skip. Its check run on the first stamp commit, for
v2.11.40, reported `skipped` with no build watch path configured.) The ruleset is strict about
up-to-date branches, so the stamp commit also puts every open PR behind `main` once more, and a PR
is updated after the `Version` run (`docs/agents/merging.md`). The changelog check keeps the name
the ruleset requires, now checks the fragments instead of a predicted version, and drops the
Dependabot exemption. The scheme and its operating rules are `stamp-on-tag` in
`jwh3times/skills`, which holds the canonical scripts.
