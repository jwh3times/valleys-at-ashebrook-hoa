# Workstation Bootstrap

This public guide contains prerequisites and value-free commands only. Exact private repository,
encrypted-storage, and 1Password item locators belong in the private recovery runbook and the
Ashebrook `Workstation Bootstrap` item.

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
