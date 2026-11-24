# Releases

Settings the shared `open-pr` skill reads (installed from `jwh3times/skills`, ADR 0029). Each `##`
heading is one setting. How the pipeline, versioning and the changelog guard work is in
[`ci-and-release.md`](./ci-and-release.md).

## Scheme

stamp-on-tag — `.github/workflows/version.yml` tags every merge to `main`
`v<major>.<minor>.<build>` with a GitHub Release. Each branch's entries live in its own
`changelog.d/<branch-slug>.md` fragment; the workflow stamps them into the merge's dated section
and tags the merge commit (ADR 0030).

## Ask before bumping

only when the release level is ambiguous
