# CI, versioning, and release

What the pipeline runs, how a version number is minted, and the hazard that has twice let a
grouped dependency PR hide a real failure.

## The pipeline

`.github/workflows/build.yml` runs on every PR and every push to `main` except the Version
workflow's `[skip ci]` stamp commit ([Changelog](#changelog)), in this order:

```
types:worker (regenerate) → format:check → lint → shared scripts' node:test → sync:agents:check
  → lint:agents → lint:coercions → lint:migrations → lint:fixtures → check → test → test:server
  → build → deploy:check → worker-types drift verdict
```

Run the relevant gates locally before pushing.

### The Worker types gate regenerates first and judges last (#358)

`worker-configuration.d.ts` is generated output committed to the tree, so it drifts whenever
`wrangler.toml`, the environment template, or `wrangler` itself moves. `types:worker` runs
`wrangler types`, which generates from the runtime types bundled inside `wrangler`, not from the
`@cloudflare/workers-types` package. Dependabot edits only `package.json` and the lockfile, so:

- **A `wrangler` bump usually drifts it, but not always.** Patch releases #360 and #452 didn't;
  patch releases #347 and #356 did. Read the build's verdict rather than guessing from the version.
- **A `@cloudflare/workers-types` bump on its own has not drifted it** (#503, #515 and #521, among
  others), since `wrangler types` doesn't read that package.

#519 records the full count behind both.

CI used to check it first and stop there, which meant such a bump died in about thirty seconds
having validated nothing. Now CI **regenerates** the file up front, runs the whole suite against
the correct types, and fails at the very end if the committed copy disagrees — `always()`, so a
bump that is both stale and broken reports both rather than hiding one behind the other.

The gate is still strict; drift is still a red build, on human PRs too. What changed is what a red
build tells you: "this bump is sound, commit the regenerated file" rather than "something drifted,
nothing was tested".

**The fix, either way, is two commands:**

```bash
npm run types:worker   # rewrites worker-configuration.d.ts
git add worker-configuration.d.ts
```

CI deliberately does **not** commit the regenerated file back. Doing so would need a
`contents: write` token on a job that has just run code from the very package being bumped
(`types:worker` runs Wrangler, and the build and tests load the rest): dependency code running
beside a credential, the risk `AGENTS.md` gates behind human confirmation when install scripts are
approved.

> **A failed early gate skips every later step, including the whole test suite.** A
> green-looking single blocker can therefore hide a real failure behind it — do not assume the
> first reported failure is the only one. The Worker types gate no longer does this (above), but
> every other gate still does.

That hazard has fired twice, both times on grouped dependabot PRs:

- A stale `worker-configuration.d.ts` failed `types:worker:check` and masked the
  Better Auth 1.7 incompatibility in #255. #316 resolves the rate-limit storage
  mismatch using D1 and removes the temporary Better Auth Dependabot ignore.
- PR #267 bumped oxlint 1.78.0 → 1.79.0, which split `react/set-state-in-effect` out of
  `react/react-compiler` into the `correctness` category `.oxlintrc.jsonc` enables wholesale. Four
  pre-existing call sites failed `lint`, taking ten unrelated grouped packages down with them.
  `.github/dependabot.yml` now travels `oxlint`/`oxlint-tsgolint` in **their own minor+patch
  group**, so a linter release with a newly-recategorized rule arrives as its own reviewable PR.

A third grouped PR failed earlier still, at `npm ci`:

- PR #308 bumped `vitest` and `@vitest/coverage-v8` to 5.0.0, and `npm ci` refused the tree before
  any gate ran, because `@cloudflare/vitest-pool-workers` declared `peer vitest@"^4.1.0"`. #313 moved
  to its successor, `@cloudflare/vitest-plugin`, whose peer range includes Vitest 5, and removed the
  `vitest` and `@vitest/*` major ignores from `.github/dependabot.yml`. Take a future `vitest` major
  as its own PR with the full `test:server` run, and check the plugin's peer range first.

A matching peer range is not enough. Vitest 5.1's module mocker calls `AsyncLocalStorage#disable()`,
which workerd does not implement, so every Workers-pool suite with a `vi.mock()` factory failed to
load. #533 held `vitest` and `@vitest/*` at 5.0.x with a Dependabot ignore; #535 lifted it once
`@cloudflare/vitest-plugin` 1.6.1 made `disable()` a no-op in the test runtime. Run the full
`test:server` for a `vitest` minor too.

## CodeQL runs outside `build.yml`, and skips Dependabot's own commits

CodeQL code scanning is GitHub's **default setup**, configured in the repository's Settings. There
is deliberately no CodeQL workflow file. It analyses JavaScript/TypeScript, Actions workflows and
Python on pushes to `main` and on pull requests, with one exception:

- **A PR whose head commit is Dependabot's is not scanned.** Its `CodeQL` check comes back
  **neutral**, with "configurations not found", and no `Analyze` jobs run (#433, #475 and #521,
  among others). A Dependabot PR whose head is a commit of the owner's runs all three analyses.
- **A neutral check does not block the merge.** The `main` ruleset's `code_scanning` rule blocks a
  failing analysis, not a neutral one, and its only bypass actor is the release App's stamp push,
  so such PRs merge and their code is scanned on `main` afterwards.
- **To scan before merging, update the branch:** `gh pr update-branch <n>` makes a merge commit
  under the owner's account, and that commit is scanned. A dependency bump only changes
  `package.json` and the lockfile, so a post-merge scan is usually acceptable for it.
- **`@dependabot rebase` makes a new Dependabot commit,** so expect it to go unscanned too. No PR
  here has tested it; prefer `gh pr update-branch`.

## The miniflare `undici`/`sharp` overrides are caret floors

Every Cloudflare tool pins `miniflare` to exact `undici` and `sharp` versions, so a patched
transitive release only reaches the tree through `overrides.miniflare` in `package.json`. Write
those entries as **caret ranges from the patched floor** (`"undici": "^7.30.1"`,
`"sharp": "^0.35.5"`), never exact pins: exact pins held vulnerable versions in place once newer
advisories landed. When an advisory needs a newer release, **raise the floor** and refresh
`package-lock.json`, then confirm with `npm audit`.

A test tool's exact pin can reach production code. `@cloudflare/vitest-plugin` pins `zod` exactly, and
its predecessor's pin was hoisted to the root of the tree, where the auth packages resolved it too,
so a vulnerable zod shipped in the Worker. A lockfile refresh cannot move an exact pin, and Dependabot
reports `security_update_not_possible` for it. If the plugin's copy is ever hoisted while vulnerable,
add a root `overrides.zod` caret floor, as #499 did until #313 removed the need.

## A Dependabot alert with no pull request

Why Dependabot opened no PR for an open alert is visible only through GraphQL, not the REST alerts
API or `gh`:

```bash
gh api graphql -f query='{ repository(owner:"jwh3times",name:"valleys-at-ashebrook-hoa"){
  vulnerabilityAlerts(first:10,states:OPEN){ nodes{ number createdAt
    dependabotUpdate{ pullRequest{number state} error{title body errorType} } } } } }'
```

- **`security_update_not_possible` can be wrong.** For a transitive dependency whose parent is
  pinned in the lockfile, Dependabot reports the current version as the highest installable even
  when the parent's caret range already admits the patch. Check with
  `npm view <parent>@<pinned> dependencies`. When the range admits it,
  `npm audit fix --package-lock-only` re-resolves the lockfile with no override.
- **A failed security update is not retried on a schedule**, and green version-update PRs say
  nothing about it: they are a separate job type.
- **Alerts can stay open for hours after the fix merges** (seven on #499, seconds on #440). Compare
  the version GraphQL's `vulnerableRequirements` names with the merged lockfile before acting, and
  wait rather than dismiss: a dismissed alert may not reopen if the version returns.

## Actions are pinned to commit SHAs

Every `uses:` in `.github/workflows/` names a full 40-character commit SHA, with the version it
corresponds to in a trailing comment:

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
```

A release tag is mutable — whoever controls the action's repository can re-point `v7` at different
code, and every workflow that trusts the tag runs it on the next push. A SHA cannot be re-pointed.
CI here has repository write (`version.yml` pushes the stamp commit to `main` and the tags, with
the release App's token, which bypasses the ruleset) and reads no secrets it should not, but it
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
`scripts/stamp-changelog.mjs` makes that computation the way `scripts/next-version.mjs` does, once
per merge, in the order the merges landed.

## Changelog

No branch names a version (`Scheme: stamp-on-tag`, ADR 0030). The `/ship` skill classifies the
branch's project-level release impact as major, minor, or build; for a major or minor
classification it idempotently updates `package.json` and `package-lock.json` from the merge-base
release line, while a build classification leaves the package version unchanged. It writes the
branch's entries to its own `changelog.d/<branch-slug>.md` fragment and never edits
`CHANGELOG.md` (`changelog.d/README.md`).

After each merge, the Version workflow runs `scripts/stamp-changelog.mjs`. It turns each untagged
merge's fragments (or, with none, its PR title) into a dated section with its footer link, and
pushes them in one `chore(release): v<x.y.z> [skip ci]` commit that deletes the used fragments. It
tags each merge commit and creates its GitHub Release from the section. The push uses a token from
the release GitHub App, the `main` ruleset's one bypass actor, since `GITHUB_TOKEN` cannot bypass a
ruleset; the App's client ID is the `RELEASE_APP_CLIENT_ID` variable and its key the
`RELEASE_APP_PRIVATE_KEY` secret. `[skip ci]` keeps the stamp commit from starting `build` or
`Version` again, and Cloudflare Workers Builds skips it too, though its documentation mentions only
build watch paths: the `Workers Builds` check run on the v2.11.40 stamp commit reported `skipped`,
with no watch path configured. So a stamp commit deploys nothing. CodeQL's default setup ignores
`[skip ci]` and still analyzes it, which gates nothing.

The Changelog Version workflow (`.github/workflows/changelog.yml`) runs on every PR, Dependabot's
included, and **fails it when the branch adds, removes or renumbers a version section, adds entries
to `## [Unreleased]`, edits or deletes a fragment already on `main`, or adds a fragment that does
not parse**. Its job keeps the name the ruleset requires, `Verify changelog names the target
version`.
