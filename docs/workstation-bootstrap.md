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

Clone the public and private repositories as siblings using the locators recovered from 1Password.
From the private repository, run its 1Password validation command and then its bootstrap command.
Those commands report filenames and variable names only and materialize `.env` and `.dev.vars`
directly into this public checkout. Do not copy resolved values into shell arguments, logs, issue
bodies, or Git.

## Private companion

Two npm scripts wrap those private-repository steps so a new checkout or worktree needs no
locator on hand:

```bash
npm run bootstrap:private   # clone the private companion beside the MAIN checkout, if absent
npm run bootstrap:env       # ...then materialize .env and .dev.vars for THIS worktree
```

`bootstrap:private` reads the companion's clone URL from the Ashebrook `Workstation Bootstrap`
item through the `op` CLI (`--op-reference` overrides the field; `--url` supplies a
credential-free GitHub URL directly; an optional `ASHEBROOK_OP_SERVICE_ACCOUNT_REFERENCE` or
`--service-account-reference` names a token field to retry with, held only in process memory).
The clone lands at `../<companion-name>` relative to the main repository root — linked worktrees
resolve to the main checkout, so every worktree shares one companion — or at `ASHEBROOK_OPS_ROOT`
/ `--target`. It refuses to overwrite a non-empty directory that is not a Git checkout, never
prints the locator, and is a no-op when the companion is already installed. The companion is not
placed under `private/`, which is the default `ASHEBROOK_PRIVATE_ROOT` and holds resident records
that must never enter any Git repository.

`bootstrap:env` runs the companion's PowerShell bootstrap (`pwsh` is required on every platform)
against the current worktree root; it validates every referenced 1Password field first and reports
variable names only. A divergent existing `.env` or `.dev.vars` is preserved unless you pass
`-- --force`.

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
