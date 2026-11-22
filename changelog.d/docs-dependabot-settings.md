### Added

- `docs/agents/dependabot.md` holds what the shared `dependabot` skill reads to review this
  repository's Dependabot PRs, in the session and in the scheduled review: the label its verdicts
  carry, the minor bumps reviewed in full (`oxlint` and `vitest`), the install CI runs, where the
  dependencies are used, the hard peers a major has to satisfy (`@astrojs/cloudflare`,
  `better-auth-cloudflare`, `@cloudflare/vitest-plugin`), and the gates and known fixes for each
  kind of bump, among them `npm run types:worker` for Worker types drift. The Doc map lists it. No
  site behavior changes.
