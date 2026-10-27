# Contributing

Thanks for your interest! This site serves the Valleys at Ashebrook neighborhood, and bug reports,
accessibility fixes, and improvements are welcome.

By participating, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Getting set up

Follow the [Getting started](./README.md#getting-started) section of the README (Node version from
`.nvmrc` — run `nvm use` — then `npm install`, `npm run dev`). Full Cloudflare provisioning (D1,
KV, R2, secrets) is only needed for deployment and is documented step-by-step in
[SETUP.md](./SETUP.md).

Cloudflare runtime and binding declarations are committed in `worker-configuration.d.ts`. Run
`npm run types:worker` after changing `wrangler.toml` or `.env.example`, and commit the regenerated
file with the configuration change.

## Workflow

1. **Open an issue first** for non-trivial changes so we can agree on the approach.
2. Create a branch named for the issue — `<type>/<issue#>-<slug>`, e.g.
   `fix/442-delete-order` — and make your change with tests.
3. Ensure everything is green locally — these mirror the CI checks in
   `.github/workflows/build.yml`:

   ```bash
   npm run types:worker:check # generated Worker types match Cloudflare configuration
   npm run format:check   # Prettier (fix with: npm run format)
   npm run lint           # type-aware Oxlint correctness and React Hooks checks
   npm run sync:agents:check # generated agent trees match authored inputs
   node --test scripts/sync-agents.test.mjs # the shared agent synchronizer's own tests
   npm run lint:coercions # reject blank/zero numeric coercion bugs
   npm run lint:migrations # validate the hand-authored migration sequence
   npm run check          # TypeScript 7 + Astro type checks
   npm test               # jsdom unit/component tests
   npm run test:server    # Worker/D1 integration tests
   npm run build          # SSR build
   npm run deploy:check   # dry-run the generated Wrangler deployment config
   ```

4. Open a Pull Request against `main` whose description opens with `Closes #N` (or `Part of #N`
   when it delivers one slice of a larger issue); an issue number in the title alone links
   nothing. CI's **Changelog Version** check
   (`.github/workflows/changelog.yml`) fails the PR unless it adds a `## [<version>]` section to
   `CHANGELOG.md` for the version the merge will mint — compute that version with
   `scripts/next-version.sh`, or run the `ship` skill to handle the doc, changelog, and PR flow for
   you. Dependabot PRs are exempt.

## Conventions to honour

- **Access control is server-side and fail-closed.** Never rely on the client to hide gated
  content; tier checks live in `src/server/` (`authz/`, `content/visibility.ts`).
- **Schema changes** go through hand-authored migrations: edit `src/server/db/schema.ts`, write
  the next numbered `.sql` file under `src/server/db/migrations/` by hand, and apply it locally
  with `npm run db:migrate:local`. `npm run db:generate` is not part of the workflow — its output
  replays old table rebuilds (#257). See
  [`docs/agents/migrations.md`](./docs/agents/migrations.md) for the rules; production migrations
  are applied by a maintainer.
- **The roster is personal data** — never commit real owner names, emails, or phone numbers
  (fixtures/tests use fake data).
- **`design/Ashebrook HOA.dc.html` is reference-only** — the original design mockup. Don't edit it.
- The full architecture and conventions live in [CLAUDE.md](./CLAUDE.md).

## Security issues

Do not report vulnerabilities in public issues — see [SECURITY.md](./SECURITY.md) for the private
disclosure process.
