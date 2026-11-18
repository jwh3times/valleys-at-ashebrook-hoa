# Merging

Everything from an open pull request to a finished merge: checks, order, the version tag, and the
changelog footer. `/ship` stops when the PR opens, so these steps are done by hand. Each one below
has been missed at least once. The merge itself needs no second confirmation (`AGENTS.md`, Deploy).
How the pipeline, versioning and the changelog guard work is in
[`ci-and-release.md`](./ci-and-release.md).

## Before merging

- **Wait on the PR's current head.** Read `headRefOid` with `gh pr view <n> --json headRefOid`, and
  wait until `gh api repos/<owner>/<repo>/commits/<head>/check-runs` shows every run `completed`.
  Run straight after `gh pr update-branch`, `gh pr checks <n> --watch` watched the old head and
  reported success while the new head's `build` was still queued, and then failed (#572, #576).
- **`main` is protected by a ruleset with no bypass**, not by classic branch protection, so
  `.../branches/main/protection` answers 404. Required: the changelog check, `build`, CodeQL and code
  quality, with branches up to date. Auto-merge is off. To change the ruleset, fetch it, edit the
  `rules` array, and `PUT` the whole array back: a `PUT` replaces it. Keep `code_scanning` and
  `code_quality` exactly as they are.
- **Merge one changelog-carrying PR at a time.** Every PR edits `CHANGELOG.md`, so parallel branches
  collide. When two are open, merge the larger one first, then on the other merge `main`, keep both
  sections newest first, and renumber that branch's own section to what
  `node scripts/next-version.mjs` prints after `git fetch --tags`. The winner's tag is minted
  asynchronously, so check the tags first.
- **A changelog PR goes before a Dependabot PR.** A Dependabot PR claims no version, so merging it
  first takes the number the other PR's section names and forces a re-ship. In the other order, the
  Dependabot PR only needs `gh pr update-branch` and a green re-run, and the next `/ship` backfills
  its section.
- **Renumber only the branch's own section.** Before renaming a section heading, check
  `git tag -l "v<that version>"` is empty. The v1.1.0 ship renamed the already-released `[1.0.22]`
  into `[1.1.0]`, deleting a release from the record, and CI passed because the guard checks only the
  target version.

## Merging

`gh pr merge <n> --merge --delete-branch`.

If it answers `502 Bad Gateway` and the retry says `Merge already in progress`, the merge may still
never land: #581 stayed open for over two minutes. Wait briefly, then retry the merge rather than
polling.

## After merging

- **Find the Version run by commit.** `gh run list --workflow version.yml --limit 1` right after a
  merge can return the previous merge's run, because the new one isn't queued yet. Select the run
  whose `headSha` is the merge commit, watch it, then confirm `git tag --points-at origin/main`.
- **Check the changelog footer.** Every new or backfilled section needs its `[x.y.z]: …/compare/…`
  link, and `[Unreleased]` must compare from the newest tag. The changelog guard doesn't check the
  footer, and v2.11.34 shipped without its link.
- **Reconcile tags with sections.** Every tag from `v0.2.0` on needs a `## [x.y.z]` section:

  ```bash
  for t in $(git tag --sort=version:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$'); do
    v="${t#v}"; grep -q "^## \[$v\]" CHANGELOG.md || echo "MISSING: $t"
  done
  ```

  The ignored `v0.1.x` tags (`releases.md`) will show; nothing else should.

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
