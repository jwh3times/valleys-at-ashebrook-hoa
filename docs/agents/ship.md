# Ship

Settings the shared `ship` skill reads (installed from `jwh3times/skills`, ADR 0029). Each `##`
heading is one setting.

## Fast checks

All from the repository root, in the order `.github/workflows/build.yml` runs them.

- `npm run format:check`, fixed by `npm run format`
- `npm run lint`
- `node scripts/check-docs.mjs`
- only when `scripts/` changed: `node --test "scripts/*.test.mjs"`
- `npm run sync:agents:check`, fixed by `npm run format` then `npm run sync:agents`, committing the
  regenerated trees
- `node scripts/check-skills.mjs`
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
