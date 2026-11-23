# Guard

The commands and paths `scripts/guard.mjs` stops here, on top of the rules it applies everywhere.
Each `##` heading is one setting, defined in `.agents/skills/ship/settings/guard.md`. Production
commands (deploys, remote D1 writes, Worker secrets, corpus and roster writes, Wrangler) are
confirmation-gated by `scripts/require-production-confirmation.ts`, so they are not repeated here.

## Deny commands

- `^(npm (run|run-script) db:generate|(npx )?drizzle-kit generate)\b` — the Drizzle snapshot chain
  is abandoned, so the generator diffs `schema.ts` against stale snapshots and proposes replaying
  old table rebuilds. Hand-author the migration (`docs/agents/migrations.md`).
- `^npx (-y |--yes )?skills update\b` — it leaves `.claude/skills/` linked to its source instead of
  copied. Re-run the `npx skills add ... --copy` install in `AGENTS.md` instead.

## Ask commands

none

## Protected paths

- `^private/` — the private companion checkout and the resident-derived records beside it.
- `^(\.dev\.vars|\.env(\.local|\.production)?)$` — local secrets and bindings, which
  `npm run bootstrap:env` materializes; copying an example over one loses them.
- `^\.wrangler/` — local D1 and Wrangler state.
- `^node_modules/` — reinstallable, but removing it is not cleanup.
