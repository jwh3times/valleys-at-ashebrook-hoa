# CI, versioning, and release

What the pipeline runs, how a version number is minted, and the hazard that has twice let a
grouped dependency PR hide a real failure.

## The pipeline

`.github/workflows/build.yml` runs on every PR and every push to `main`, in this order:

```
types:worker:check → format:check → lint → sync:agents -- --check
  → lint:coercions → lint:migrations → lint:fixtures → check → test → test:server
  → build → deploy:check
```

Run the relevant gates locally before pushing.

> **A failed early gate skips every later step, including the whole test suite.** A
> green-looking single blocker can therefore hide a real failure behind it — do not assume the
> first reported failure is the only one.

That hazard has fired twice, both times on grouped dependabot PRs:

- A stale `worker-configuration.d.ts` failed `types:worker:check` and masked the **better-auth 1.7
  incompatibility** (see the `auth/` entry in [`module-map.md`](./module-map.md) for why 1.7 cannot
  be taken). `.github/dependabot.yml` now **ignores better-auth minor and major updates** so 1.7.x
  is no longer re-proposed into the `npm-minor-and-patch` group, where it blocked four safe bumps
  in #255. 1.6.x _patches_ still come through.
- PR #267 bumped oxlint 1.78.0 → 1.79.0, which split `react/set-state-in-effect` out of
  `react/react-compiler` into the `correctness` category `.oxlintrc.jsonc` enables wholesale. Four
  pre-existing call sites failed `lint`, taking ten unrelated grouped packages down with them.
  `.github/dependabot.yml` now travels `oxlint`/`oxlint-tsgolint` in **their own minor+patch
  group**, so a linter release with a newly-recategorized rule arrives as its own reviewable PR.

A third grouped PR failed earlier still, at `npm ci`, and is held by a second ignore rule:

- PR #308 bumped `vitest` and `@vitest/coverage-v8` to 5.0.0, and `npm ci` refused the tree before
  any gate ran: `@cloudflare/vitest-pool-workers` 0.22 declares `peer vitest@"^4.1.0"`, and that
  pool is what runs `test/server/**` against a real workerd + D1, so it can be neither dropped nor
  forced. `.github/dependabot.yml` now **ignores `vitest` and `@vitest/*` major updates** until the
  pool's peer range includes vitest 5 (#313 tracks the upstream gate); 4.x minors and patches still
  come through. Remove both entries when it does, and take the bump as its own PR with the full
  `test:server` run.

## Actions are pinned to commit SHAs

Every `uses:` in `.github/workflows/` names a full 40-character commit SHA, with the version it
corresponds to in a trailing comment:

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
```

A release tag is mutable — whoever controls the action's repository can re-point `v7` at different
code, and every workflow that trusts the tag runs it on the next push. A SHA cannot be re-pointed.
CI here has repository write (`version.yml` pushes tags) and reads no secrets it should not, but it
runs on every PR, so the blast radius of a compromised action is the whole pipeline.

Dependabot's `github-actions` ecosystem understands pinned SHAs: it proposes updates by rewriting
both the SHA and the comment, so pinning costs nothing in freshness. **A new workflow step must be
pinned the same way** — resolve the tag with
`gh api repos/<owner>/<action>/git/ref/tags/<tag> --jq .object.sha` and keep the version comment
accurate, since the comment is the only human-readable record of what the SHA is.

## Versioning

The third semver segment is a **build number**: `<major>.<minor>.<build>`.

On every merge to `main`, the Version workflow (`.github/workflows/version.yml`) tags the merge
commit and creates a GitHub release from the `package.json` major/minor release line. The first
tag for a new line uses the package build value (`0.2.0` → `v0.2.0`); later merges on the same line
increment the build tag (`v0.2.1`, `v0.2.2`, …). When bumping major or minor, `x.y.0` remains
valid and is not incremented to `x.y.1` unless an `x.y.0` tag already exists.

## Changelog

The Changelog Version workflow (`.github/workflows/changelog.yml`) runs on every non-dependabot PR
and **fails it unless `CHANGELOG.md` documents the version that PR's merge will mint**.

`scripts/next-version.sh` predicts that version by mirroring the Version workflow's tag algorithm.
The `/ship` skill (`.claude/skills/ship/`) classifies the branch's project-level release impact as
major, minor, or build before writing the matching changelog section; for a major or minor
classification it idempotently updates `package.json` and `package-lock.json` from the merge-base
release line, while a build classification leaves the package version unchanged.

Dependabot PRs are exempt; their entries are backfilled by `/ship` on the next human PR.
