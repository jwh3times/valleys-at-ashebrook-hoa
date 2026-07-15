# Contributing

Thanks for your interest! This site serves the Valleys at Ashebrook neighborhood, and bug reports,
accessibility fixes, and improvements are welcome.

By participating, you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Getting set up

Follow the [Getting started](./README.md#getting-started) section of the README (Node version from
`.nvmrc` — run `nvm use` — then `npm install`, `npm run dev`). Full Cloudflare provisioning (D1,
KV, R2, secrets) is only needed for deployment and is documented step-by-step in
[SETUP.md](./SETUP.md).

## Workflow

1. **Open an issue first** for non-trivial changes so we can agree on the approach.
2. Create a branch and make your change with tests.
3. Ensure everything is green locally — these mirror the CI checks in
   `.github/workflows/build.yml`:

   ```bash
   npm run format:check   # Prettier (fix with: npm run format)
   npm run check          # Astro + TypeScript type check
   npm test               # jsdom unit/component tests
   npm run test:server    # Worker/D1 integration tests
   npm run build          # SSR build
   ```

4. Open a Pull Request against `main`. CI's **Changelog Version** check
   (`.github/workflows/changelog.yml`) fails the PR unless it adds a `## [<version>]` section to
   `CHANGELOG.md` for the version the merge will mint — compute that version with
   `scripts/next-version.sh`, or run the `ship` skill to handle the doc, changelog, and PR flow for
   you. Dependabot PRs are exempt.

## Conventions to honour

- **Access control is server-side and fail-closed.** Never rely on the client to hide gated
  content; tier checks live in `src/server/` (`authz/`, `content/visibility.ts`).
- **Schema changes** go through Drizzle: edit `src/server/db/schema.ts`, run `npm run
db:generate`, and apply with `npm run db:migrate:local` / `db:migrate:remote`.
- **The roster is personal data** — never commit real owner names, emails, or phone numbers
  (fixtures/tests use fake data).
- **`design/Ashebrook HOA.dc.html` is reference-only** — the original design mockup. Don't edit it.
- The full architecture and conventions live in [CLAUDE.md](./CLAUDE.md).

## Security issues

Do not report vulnerabilities in public issues — see [SECURITY.md](./SECURITY.md) for the private
disclosure process.
