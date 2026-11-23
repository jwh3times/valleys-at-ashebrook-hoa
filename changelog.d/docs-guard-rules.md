### Changed

- `docs/agents/guard.md` holds this repository's own rules for the shared PreToolUse guard,
  `scripts/guard.mjs`, on top of the ones it applies everywhere: it denies the abandoned Drizzle
  snapshot generator (`npm run db:generate`, `drizzle-kit generate`) and `npx skills update`, and
  protects `private/`, the local secret and binding files, `.wrangler/` and `node_modules/`.
  Production commands stay with the confirmation hook. The Doc map in `docs/agents/docs.md` names
  the file and when it changes. No site behavior changes.
- `.oxlintrc.jsonc` no longer turns `promise/always-return` off for the shared scripts: the
  canonical copies from `jwh3times/skills` pass it now.
