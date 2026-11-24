# Test proof

Settings the shared `test-prover` skill reads (installed from `jwh3times/skills`, ADR 0029): how it
runs one test on its own here, and how it tells a run that tested nothing from a pass. Each `##`
heading is one setting. The account of how a test here passes without proving anything is
[`verification.md`](./verification.md), the default `Guide`.

## Test commands

- repo root: the jsdom suite (`npm test`), `src/**/*.{test,spec}.{ts,tsx}` and
  `test/**/*.test.{ts,tsx}` except `test/server/**` (the `include` in `vitest.config.ts`).
  - One file: `npx vitest run <file>`; one test by name: `npx vitest run <file> -t "<name>"`.
  - The count is Vitest's `Tests  N passed (N)` line, which `mutate.mjs` reads already.
  - The scratch worktree links `node_modules`.
- repo root: the Workers suite (`npm run test:server`), `test/server/**/*.test.ts`, run by
  `@cloudflare/vitest-plugin` in Miniflare with local D1, KV and R2.
  - One file: `npx vitest run --config vitest.workers.config.ts <file>`; one test by name: the same
    with `-t "<name>"`.
  - The count is the same Vitest line.
  - The scratch worktree links `node_modules`. It has no `.dev.vars`, so the pool sees only the
    `bindings` in `vitest.workers.config.ts`, as in CI. Never run two Workers-suite runs at once
    ([workstation](./workstation.md)).
- repo root: `scripts/*.test.mjs`, node's built-in test runner.
  - One file: `node --test <file>`; one test by name:
    `node --test --test-name-pattern="<name>" <file>`, with `<name>` regex-escaped.
  - The count is node's `ℹ tests N` line, which `mutate.mjs` reads already.
  - The scratch worktree links `node_modules`.
