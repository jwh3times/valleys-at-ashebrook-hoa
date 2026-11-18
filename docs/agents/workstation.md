# Workstation

Traps on the development machines, mostly Windows with Git Bash and PowerShell, that cost real
debugging time and will recur because they are properties of the tools, not of the work. Setting a
machine up is [`docs/workstation-bootstrap.md`](../workstation-bootstrap.md).

## Two repositories in one tree

The private companion is cloned into `private/`, so two Git repositories and two GitHub repositories
are reachable from one checkout, and `gh` picks its target from the working directory.

- Name the repository on every `gh` call (`--repo`) and use `git -C private` rather than
  `cd private`. A `cd private && <cmd>` whose command fails doesn't reliably leave the next command
  in `private/`. A retried `gh issue edit 13` once overwrote public PR #13's body with private text
  instead of editing the private issue with that number.
- A previous issue or PR body can be read back only through GraphQL's `userContentEdits`
  connection.
- The companion takes direct pushes to its `main`; it is not PR-only.

## Shells

- **MSYS rewrites values that only look like paths.** `gh api /repos/…` becomes
  `C:/Program Files/Git/repos/…`: drop the leading slash and set `MSYS_NO_PATHCONV=1`. A `--text`,
  `--body` or `--title` value that starts with `/` is rewritten silently, so a board Next Action of
  `/implement #575` was stored as a Windows path. Scope `MSYS_NO_PATHCONV=1` to that one call, since
  it also stops converting real paths you pass to `node`, and read the field back.
- **Backticks inside a double-quoted `--body` are command substitution**, and the comment still
  posts with pieces missing. Use `--body-file`; repair a posted comment with
  `gh issue comment <n> --edit-last --body-file <f>`.
- **Plain `bash` may be the WSL shim.** From PowerShell, run repository shell scripts with
  `C:\Program Files\Git\bin\bash.exe`.
- **`sha256sum` on Windows defaults to the binary `*` marker**, so a manifest never matches Linux's
  two-space format without `--text`.
- **`$TEMP` is shared by every session on the machine.** Never stage output in a fixed `$TEMP`
  path: a parallel session overwrote `$TEMP/board.json` between two reads, and the second returned
  another project's item ids. Use a per-session directory.

## Wrangler

- **Calling it from a Node script:** `shell: true` word-splits a SQL argument (Wrangler then reports
  `Unknown arguments: FROM, …`, which reads like a schema failure). Spawning `npx.cmd` without a
  shell fails with `EINVAL`. `wrangler/bin/wrangler.js` isn't in the package's `exports`, so resolve
  `wrangler/package.json`, join `bin/wrangler.js`, and run it with `process.execPath`.
- **`--command` and `--file` carry no parameter binding**, so SQL using `?1` needs literals
  substituted, quoted.
- **Remote `d1 execute --file` is the D1 import API, not the query API.** It prints progress lines
  and returns one summary object, never per-statement results. Use `--command` when a script needs
  results.
- **An exit crash after success.** Wrangler on Node 26 for Windows can die at exit with
  `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` after the query completed, so a caller
  sees a false failure. Scripts that spawn it need a bounded per-query retry.
- **A `7403` from the D1 query endpoint** ("the given account is not valid or is not authorized")
  is an expired OAuth consent, even when `wrangler whoami` lists `d1 (write)`, `d1 list` shows the
  database and the token refreshes. `whoami`'s scopes are what the token claims, not what was
  granted. Ask the user to run `wrangler login`, which needs a real terminal. Run Wrangler from the
  shell family that logged in: PowerShell and Git Bash have resolved different config directories.
  Read-only checks can use the API-token fallback recorded in the private companion.
- **`npm run secrets:put` fails while an open PR's Workers Builds preview is the newest Worker
  version** ("latest version of your Worker isn't currently deployed"). Pushing any PR branch
  uploads one, and Dependabot rebases after every merge. Neither workaround Wrangler suggests is
  safe: `versions secret put` builds on the PR's version, and deploying latest ships unmerged code.
  Compare `npx wrangler deployments list` with `versions list`, get a newer `main` deploy first,
  then put all the secrets back to back.
- **Applying a migration is always the operator's step**, through `npm run db:migrate:remote`, with
  either credential ([migrations](./migrations.md)).

## Processes

- **`pkill` doesn't kill `wrangler` or `workerd` on Windows.** The survivors lock
  `dist/server/.wrangler/**/*.sqlite`, and the next `astro build` fails in `emptyDir` with
  `The property 'options.recursive' is no longer supported`, which says nothing about locks.
- **Stopping a background `npm run dev` or `wrangler dev` leaves its children** holding ports 4321
  and 8788.
- **A hung `vitest` from an earlier session can hold a native `.node` file**, so `npm ci` fails
  `EPERM … unlink` after deleting most of `node_modules`. Before an `npm ci`, check for stray
  repository-local `node` processes.
- **Never run two `npm run test:server` at once.** Two runs in parallel worktrees were both killed
  for low memory after ten minutes (CI takes about 3.5) and left orphans holding about 600 MB each.
  For a dependency PR, run the fast gates locally and let CI run `test:server` and `build`.

In every case, find processes with `Get-CimInstance Win32_Process` filtered on `CommandLine`, check
each one is yours (other worktrees and the user run `workerd` too), then `Stop-Process -Id`. Confirm
ports 4321 and 8788 are free before calling a stack down.

## TypeScript run directly

`node --experimental-strip-types` only strips types, while Vitest compiles TypeScript fully, so a
script can pass every test and fail to run:

- constructor parameter properties, enums and namespaces throw `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`;
- imports resolve literally, so a script that imports a `src/` module can follow only type-only
  imports onward. Shared logic a script needs lives in its own module for that reason.

## The production-confirmation hook

`.claude/settings.json` runs `scripts/require-production-confirmation.ts` before every tool call in
Claude Code (`AGENTS.md`, Deploy).

- **No prompt is not consent.** The hook can't read script files, aliases or functions, `xargs`,
  `find -exec`, `make`, or names built at run time. Judge a command against the rule in `AGENTS.md`,
  not by whether a prompt appeared, and never route a production command through those forms.
- **Never edit the hook in place.** It loads from the working tree on every call, so a syntax error
  strip-only mode rejects blocks every tool, and a throw blocks the calls that trigger it. Recovery
  needs the user to run `git stash push -- scripts/require-production-confirmation.ts` outside the
  agent. Edit a copy in a scratch directory instead and check it:
  `echo '{"tool_name":"Read","tool_input":{}}' | node --experimental-strip-types --no-warnings <copy>`
  plus the new inputs, reading the exit code with no pipe after `node`. Fuzz a new parser for
  throws. Format the copy with `npx prettier --config .prettierrc.json --write <copy>` run from the
  repository (outside it Prettier finds no config and rewrites every string). Then copy it in.

## Formatting

- **prettier-plugin-astro's `astroCompressHTML` must match Astro's `compressHTML`.** Both default to
  `'jsx'` and neither is set. If anyone sets `compressHTML`, set `astroCompressHTML` to match in
  `.prettierrc.json`, or `npm run format` reflows text in ways that change rendered whitespace.
- **Prettier reflows Markdown**, including wrapping a long inline code span across lines. Format
  before the final `npm run sync:agents`, and read what it did.

## Scratch directories and long paths

Agent scratch directories are deep, so long relative paths fail on Windows.

- `git worktree remove` of a worktree there fails with `Filename too long` once `node_modules` is
  installed. The worktree is unregistered but the folder stays: remove it with
  `Remove-Item -LiteralPath ("\\?\" + $path) -Recurse -Force`.
- Restoring the records store needs a short temporary folder beside the store.

## Secrets in output

- Redact Stripe keys by every prefix: a sandbox's restricted key starts `rkcs_test_`, which an
  `sk_|rk_` pattern missed. Use `(sk|rk|rkcs)_(test|live)_\w+` and `whsec_\w+`.
- 1Password `op://` references reject parentheses in item names, so name items without them.

## Wizards

The `wizard` skill's template has three traps:

- **It sets `ENV_FILE` itself**, so a `${ENV_FILE:-…}` override in the stages never fires and state
  lands in the current directory's `.env`. Set it unconditionally and absolutely:
  `ENV_FILE="$(cd "$(dirname "$0")" && pwd)/<name>.env"`.
- **`write_env KEY VALUE` doesn't set the shell variable.** Assign both: `KEY="$v"; write_env KEY "$v"`.
- **Never gate an irreversible step on a human judging output that scrolled past.** Capture the
  check, decide in code, and `exit 1` on failure. Under `set -euo pipefail`, `git grep -l` exits 1
  when it finds nothing, which is the passing case, so add `|| true`.

## History rewrites

- `git filter-repo` checks for untracked files with `git ls-files -o`, ignored ones included, so a
  stray `.env` blocks it while `git status` looks clean.
- After a rewrite and force-push, old objects survive a prune while any ref still holds them: a
  linked worktree on the old branch, stale local branches, local tags (`git fetch --tags --force
--prune --prune-tags`), and tool-made refs such as `refs/orca/pull/*`. Clear all of them, then
  prune. `git push --force --all` pushes only local branches.
- A checkout inside a synced folder (OneDrive) keeps rewritten objects in the cloud's version
  history: clear that too, or re-clone outside it.
- `pip install --user` on Windows puts executables in a `Scripts\` folder that isn't on `PATH`;
  find it with `python -c "import sysconfig;print(sysconfig.get_path('scripts','nt_user'))"`.
