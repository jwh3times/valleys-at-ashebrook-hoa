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

- **Ignore:** `v0.1.1`–`v0.1.6`, released before the changelog kept a section per build.

## Ask before bumping

only when the release level is ambiguous

## Next-version command

`bash scripts/next-version.sh`

## Changelog check

`grep -qF "## [$(bash scripts/next-version.sh)]" CHANGELOG.md` — the test the `Changelog Version`
job (`.github/workflows/changelog.yml`) runs.
