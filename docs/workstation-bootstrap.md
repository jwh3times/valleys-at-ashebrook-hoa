# Workstation Bootstrap

This public guide contains prerequisites and value-free commands only. Exact private repository,
encrypted-storage, and credential-record locators belong in the private recovery runbook.

## Prerequisites

- Git and GitHub CLI
- the Node version pinned in `.nvmrc`, plus npm
- Python 3 for the manifest builder
- the stable 1Password CLI (`op`)
- the official `age` CLI for encrypted recovery archives
- an authorized 1Password session and access to the Ashebrook vault

Clone the public repository, then install the private companion into its gitignored `private/`
directory using the locator recovered from 1Password (`npm run bootstrap:private` does this).
The companion's validation and bootstrap commands (`npm run bootstrap:env`) report filenames and variable names only and materialize `.env` and `.dev.vars`
directly into this public checkout. Do not copy resolved values into shell arguments, logs, issue
bodies, or Git.

## Private companion

Two npm scripts wrap those private-repository steps so a new checkout or worktree needs no
locator on hand:

```bash
npm run bootstrap:private   # clone the private companion into private/, if absent
npm run bootstrap:env       # ...then materialize .env and .dev.vars for THIS worktree
```

`bootstrap:private` reads the companion's clone URL from the Ashebrook `Workstation Bootstrap`
item through the `op` CLI (`--op-reference` overrides the field; `--url` supplies a
credential-free GitHub URL directly; an optional `ASHEBROOK_OP_SERVICE_ACCOUNT_REFERENCE` or
`--service-account-reference` names a token field to retry with, held only in process memory).
The clone lands in `private/` under the current checkout or worktree — gitignored here, so each
worktree gets its own companion — or at `ASHEBROOK_OPS_ROOT` / `--target`. It refuses to overwrite
a non-empty directory that is not a Git checkout, never prints the locator, and is a no-op when the
companion is already installed. Because `private/` is also the default `ASHEBROOK_PRIVATE_ROOT`,
resident records written by the import tooling land inside the companion clone; the companion's
`.gitignore` excludes those families by name and they must never be committed to it.

After the clone, `bootstrap:private` also **seeds the records** a worktree needs: the resident
record families (`HOA_files/`, `rag_corpus/`, `backups/`, `portability/`, generated `*.sql`,
`documents-*.json`, `dedupe-*`) are not in the companion — they are kept out of every Git
repository — so they are hardlinked from the main checkout's `private/` (linked worktrees resolve
to it automatically; `--records-from <dir>` / `ASHEBROOK_RECORDS_SOURCE` overrides, `--copy` makes
real copies, `--no-records` skips). Existing files are never overwritten, and a rerun is a no-op.
The main checkout's `private/` is populated once per machine from the encrypted snapshot using the
companion's restore script (see its `operations/recovery.md`); `git -C private status` must stay
clean afterward.

The per-worktree sequence is therefore:

```bash
git worktree add .worktrees/<name> -b <name> && cd .worktrees/<name>
npm ci
npm run bootstrap:private   # companion clone + records
npm run bootstrap:env       # .env and .dev.vars from 1Password
```

`bootstrap:env` runs the companion's PowerShell bootstrap (`pwsh` is required on every platform)
against the current worktree root; it validates every referenced 1Password field first and reports
variable names only. A divergent existing `.env` or `.dev.vars` is preserved unless you pass
`-- --force`.

## Staying current

`npm run sync:main` fast-forwards both this checkout and the private companion under `private/` to
the latest default branch in one command — the companion is the one that gets forgotten, since
nothing in a build or test run reads it, so its staleness is silent. Per repository it fetches,
checks out the default branch, and merges `--ff-only`; it refuses a repository with uncommitted
changes rather than stashing them, and a diverged local branch stops with an error instead of
minting a merge commit. A missing companion is reported and skipped with a pointer to
`npm run bootstrap:private`, not treated as a failure. `-- --branch <name>` targets a branch other
than `origin/HEAD`, `-- --skip-private` limits the run to the public tree, and
`-- --target <dir>` (or `ASHEBROOK_OPS_ROOT`) points at a companion kept elsewhere.

## Deploying Worker secrets

`npm run secrets:put -- <NAME>` deploys one Worker secret straight from 1Password: the name is
looked up in the companion's `.dev.vars.tpl` (the same template `bootstrap:env` uses, so a name
it does not declare is refused), the value is piped to `wrangler secret put` on stdin, and the
Cloudflare operator token and account id are read from the Ashebrook `Cloudflare Production`
item into the child process's environment only. Nothing is printed, written, or passed as an
argument. This replaces both interactive `wrangler login` and any `wrangler secret put` typed by
hand.

## Private records root

The document, corpus, deduplication, roster, and manifest tools use
`ASHEBROOK_PRIVATE_ROOT`. If it is unset, empty, or whitespace, they use the existing `private/`
directory under this repository.

For a private root outside the checkout on PowerShell:

```powershell
$env:ASHEBROOK_PRIVATE_ROOT = 'D:\path\to\approved-records-working-copy'
npm run docs:import
```

For a POSIX shell:

```bash
export ASHEBROOK_PRIVATE_ROOT=/path/to/approved-records-working-copy
npm run docs:import
```

Relative values resolve from the public repository root. Absolute values are recommended for a
mounted or synchronized external records working directory. The encrypted-records provider,
approved subset, sync procedure, and retention rules are deployment-specific and must remain in the
private recovery runbook. Do not point the variable at the provider's encrypted container format;
point it at the access-controlled working copy made available to the operator.

On Windows, use the selected provider's supported desktop client to synchronize or mount the
approved subset at the absolute path assigned to `ASHEBROOK_PRIVATE_ROOT`. On macOS or Linux, use
the provider's supported client or a documented copy operation to make the same approved subset
available at that path. Verify synchronization has completed before running any tool. Provider
names, account locators, exact commands, and retention details are private deployment data and
belong only in the private recovery runbook.

The selected root keeps the existing layout:

```text
<private-root>/
├── HOA_files/
├── rag_corpus/
├── documents-manifest.json
├── documents-import.sql
├── documents-uploaded.json
├── corpus-import.sql
├── roster-import.sql
└── dedupe-*.{json,sql}
```

## Public checkout setup

```bash
nvm use
npm install
npm run types:worker:check
npm run format:check
npm run lint
npm run check
npm test
npm run test:server
npm run build
npm run deploy:check
```

Run document, corpus, deduplication, and roster tooling in dry-run/read-only mode before any commit
or remote mutation. Production D1 migrations remain an explicit operator action and are never run
by deployment.

The local planning commands are:

```bash
python scripts/build-import-manifest.py
npm run docs:import
npm run docs:dedupe
npm run corpus:import
npm run roster:import
```

These commands may write generated manifests, reports, or SQL beneath the selected private root,
but they do not mutate production unless an explicitly documented commit or remote-execution flag
is supplied. Review all generated output before taking that separate action.
