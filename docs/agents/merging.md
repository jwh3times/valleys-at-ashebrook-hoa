# Merging

Everything from an open pull request to a finished merge: checks, order, and the release the merge
gets. `/open-pr` stops when the PR opens, so these steps are done by hand. Each one below
has been missed at least once. The merge itself needs no second confirmation (`AGENTS.md`, Deploy).
How the pipeline, versioning and the changelog guard work is in
[`ci-and-release.md`](./ci-and-release.md).

## Before merging

- **Wait on the PR's current head.** Read `headRefOid` with `gh pr view <n> --json headRefOid`, and
  wait until `gh api repos/<owner>/<repo>/commits/<head>/check-runs` shows every run `completed`.
  Run straight after `gh pr update-branch`, `gh pr checks <n> --watch` watched the old head and
  reported success while the new head's `build` was still queued, and then failed (#572, #576).
- **`main` is protected by a ruleset**, not by classic branch protection, so
  `.../branches/main/protection` answers 404. Required: the changelog check, `build`, CodeQL and code
  quality, with branches up to date. Auto-merge is off. Its one bypass actor is the release GitHub
  App, which pushes `version.yml`'s stamp commit; nobody else bypasses it. To change the ruleset,
  fetch it, edit the `rules` array, and `PUT` the whole ruleset back: a `PUT` replaces it. Keep
  `bypass_actors`, `code_scanning` and `code_quality` exactly as they are.
- **PRs merge in any order.** No branch names a version or edits `CHANGELOG.md`: each writes its own
  `changelog.d/<branch-slug>.md` fragment (`Scheme: stamp-on-tag`, ADR 0030), so open PRs don't
  collide over the changelog, and a Dependabot PR passes the changelog check like any other.
- **Wait for the stamp before updating the next branch.** About a minute after each merge, the
  stamp commit moves `main` again, and the ruleset requires branches to be up to date. Run
  `gh pr update-branch` after that merge's `Version` run finishes, or the branch needs a second
  update and a second `build`.

## Merging

`gh pr merge <n> --merge --delete-branch`.

If it answers `502 Bad Gateway` and the retry says `Merge already in progress`, the merge may still
never land: #581 stayed open for over two minutes. Wait briefly, then retry the merge rather than
polling.

## After merging

- **Find the Version run by commit.** `gh run list --workflow version.yml --limit 1` right after a
  merge can return the previous merge's run, because the new one isn't queued yet. Select the run
  whose `headSha` is the merge commit and watch it. It stamps the merge's section into
  `CHANGELOG.md` with its footer link, deletes the merge's fragments, and pushes that as a
  `chore(release): v<x.y.z> [skip ci]` commit, then tags the merge commit and creates its GitHub
  Release. Confirm with `git tag --points-at <merge commit>`: the tag is on the merge, not on
  `main`'s new tip.
- **The stamp commit runs no workflow and deploys nothing.** Its `[skip ci]` skips `build` and
  `Version`, and Cloudflare Workers Builds skips it too: its check run on the stamp commit reads
  `skipped`. Only CodeQL analyzes it.

- **Close a private issue by hand**, then run `npm run sync:main`.

## When a check misbehaves

- **CodeQL failed while uploading**, after the scan finished, and GitHub refuses a re-run ("This
  workflow run cannot be retried"). Push an empty commit to the PR branch.
- **CodeQL failed before scanning**, with a `504` in `Initialize CodeQL` (`Unable to download and
extract CodeQL CLI`). One language's job is red, the rollup shows `skipping`, and the merge is
  blocked. Read the job log first: a 504 is GitHub, not the branch. Same cure: an empty commit, as
  many times as it takes (three on #553).
- **CodeQL never started.** No `CodeQL` or `Analyze` runs, every other check green,
  `mergeStateStatus` `BLOCKED`, and `gh pr merge` says only that the base branch policy prohibits the
  merge (#565). Docs-only PRs are normally scanned, so it isn't a path filter. One empty commit.
- **A Dependabot PR conflicts after an earlier merge.** If `gh pr update-branch` reports conflicts
  (usually the lockfile), comment `@dependabot rebase` and wait for a new head. Expect that head to
  go unscanned by CodeQL (`ci-and-release.md`).

## Worker types drift on a Dependabot PR

`ci-and-release.md` explains why a `wrangler` bump usually needs a regenerated
`worker-configuration.d.ts`. The drift can also come from a grouped PR that doesn't name `wrangler`
at all: #555 moved `workerd` through the lockfile alone. Check the `build` log of any grouped bump
touching Cloudflare or Astro packages.

The fix needs no install. CI's failing step prints the full `git diff -- worker-configuration.d.ts`:

1. Extract it from `gh run view <run> --log-failed`, stripping the two tab-separated prefix columns,
   the BOM and the timestamps.
2. `git apply` it on the PR branch.
3. Confirm `git hash-object worker-configuration.d.ts` equals the new blob hash in the diff's
   `index` line, then commit.

The other route, `npm ci` then `npm run types:worker`, works too. Before naming a version in the
commit, read the installed one (`node -p "require('./node_modules/wrangler/package.json').version"`):
a grouped PR's title doesn't give it.

## Linter bumps

- **A stale `node_modules` fails `npm run lint` with a message naming a rule**, such as
  `Rule '…' not found in plugin 'react'`, which reads like a bad `.oxlintrc.jsonc`. Compare
  `npx oxlint --version` with the `package.json` pin; `npm install` is the fix.
- **An oxlint minor can add a `correctness` rule that fails on real code** (#536). Fix the code on
  the Dependabot branch rather than disabling the rule.

## Closing references

GitHub treats a negated sentence as a closing reference: `does not close #22` closed #22 when the PR
merged. Never put a closing keyword right before an issue number unless the PR closes it; say the
issue "remains open". If it happens, reopen the issue and restore its board status.
