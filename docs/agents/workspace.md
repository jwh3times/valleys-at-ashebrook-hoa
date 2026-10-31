# Workspace

Settings the shared `end-session`, `handoff`, `lets-go`, `ship` and `docs-updater` skills read
(installed from `jwh3times/skills`, ADR 0029; each skill's `settings/` folder defines them). Each
`##` heading is one setting.

## Private companion

`private/` — an independent Git repository (not a submodule), git-ignored here and cloned by
`npm run bootstrap:private`, whose locator comes from 1Password. Repository:
`jwh3times/valleys-at-ashebrook-hoa-ops` (ADR 0023). Resident-derived records, generated import SQL
and manifests also live under `private/` (the default `ASHEBROOK_PRIVATE_ROOT`) but are ignored by
the companion's own `.gitignore` and are never committed to it.

## Companion commit checks

- The staged diff holds no personal data, sensitive filename, production identifier or undisclosed
  vulnerability: the companion's `.gitignore` rejects the obvious file types, not their contents.
- `git -C private status` shows no resident-derived record, dump or backup staged; those go to
  encrypted records storage per the portability plan, never to either Git repository.

## Safe-to-remove paths

- `dist/`, `.output/`, `.astro/`, `coverage/` — build, Astro and coverage output.
- `.superpowers/`, `docs/superpowers/`, `.scratch/` — scratch areas this repository declares, once
  no live branch depends on them.

## Never-remove paths

- `private/` — the companion checkout and the resident-derived records beside it.
- `.dev.vars`, `.env`, `.env.local`, `.env.production` — local secrets and bindings.
- `.wrangler/` — local D1 and Wrangler state.
- `node_modules/` — reinstallable, but not cleanup.

Never `git clean -x`: the ignored set holds all of the above.

## Dev stack

none — `npm run dev` runs in the foreground and leaves nothing behind.

- **Never run:**
  - `npm run db:migrate:remote`, any `wrangler … --remote` write, a deploy, a Worker secret
    change, or a remote roster or audit write: post-flip they reach live resident data, and
    `AGENTS.md` requires the user's confirmation for each. (`npm run verify:invariants --remote` is
    read-only and fine when the user asks.)

## Generated-config check

`npm run sync:agents:check`; regenerate with `npm run format`, then `npm run sync:agents` — in that
order (ADR 0021). Run it always: the required `build` check runs it.
