# Releases

Settings the shared `ship` skill reads (installed from `jwh3times/skills`, ADR 0029). Each `##`
heading is one setting. How the pipeline, versioning and the changelog guard work is in
[`ci-and-release.md`](./ci-and-release.md).

## Scheme

per-merge — `.github/workflows/version.yml` tags every merge to `main` `v<major>.<minor>.<build>`,
and each merge's dated changelog section names the version it mints.

## Skipped tags

backfill — a merged Dependabot PR (exempt from the `Changelog Version` guard) gets its section on the
next ship.

- **Ignore:** the 4-part `v0.1.0.x` tags, which predate the scheme, and `v0.1.1`–`v0.1.6`, released
  before the changelog kept a section per build.

## Version file

`package.json` (with `package-lock.json` beside it)

## Bump command

`npm version <version> --no-git-tag-version --allow-same-version`

## Ask before bumping

only when the release level is ambiguous

## Next-version command

`bash scripts/next-version.sh`

## Unreleased placeholder

none — `## [Unreleased]` stays empty.

## Changelog check

`grep -qF "## [$(bash scripts/next-version.sh)]" CHANGELOG.md` — the test the `Changelog Version`
job (`.github/workflows/changelog.yml`) runs.

## Release commit message

`docs: prepare release v<version>` — the release prep `docs/agents/dev-flow.md` exempts.
