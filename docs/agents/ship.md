# Ship

Settings the shared `ship` skill reads (installed from `jwh3times/skills`, ADR 0029). Each `##`
heading is one setting.

## Fast checks

All from the repository root, in the order `.github/workflows/build.yml` runs them.

- `npm run format:check`, fixed by `npm run format`
- `npm run lint`
- only when `scripts/` changed:
  `node --test scripts/sync-agents.test.mjs scripts/lint-agent-neutrality.test.mjs`
- `npm run sync:agents:check`, fixed by `npm run format` then `npm run sync:agents`, committing the
  regenerated trees
- `npm run lint:agents`
- `npm run lint:coercions`
- `npm run lint:migrations`
- `npm run lint:fixtures`
- `npm run check`
- only when `src/`, `test/`, `vitest.config.ts`, `vitest.shared.ts` or `package.json` changed:
  `npm test` (Vitest; about 13 seconds locally)
- `npm run types:worker:check`, fixed by `npm run types:worker` and committing
  `worker-configuration.d.ts`

CI-only: `test:server` (the workerd/Miniflare suite), `build` and `deploy:check`.

## Issue link

- **Branch pattern:** `<type>/<issue#>-<slug>`, e.g. `feat/294-tenant-invitation-claim`; a slice of a
  larger spec is `feat/<spec#>-slice-<n>-<slug>`. Exempt work drops the number.
- **Link line:** `Closes #<n>` for the ticket the PR finishes; `Part of #<n>` for one slice of a spec
  that stays open.
- **Waiver line:** `Flow waived by the user: <reason>`.
- **Exempt:**
  - dependency bumps (Dependabot, `chore(deps)`)
  - changes touching only `docs/`, root `*.md`, `.agents/` and `.claude/`
  - release prep (the `docs: update docs and changelog for vX.Y.Z` commit, a release-only branch)
- **Defined in:** `docs/agents/dev-flow.md`.
