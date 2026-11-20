### Changed

- Release docs: Cloudflare Workers Builds skips the Version workflow's `[skip ci]` stamp commit,
  as the first stamped release (v2.11.40) showed, so a stamp commit deploys nothing. ADR 0030,
  `docs/agents/ci-and-release.md`, `docs/agents/merging.md` and the `version.yml` header had said
  Workers Builds might rebuild it. The release docs and `SECURITY.md` now say that CodeQL's
  default setup still analyzes the stamp commit, and no longer say `build` runs on every push to
  `main`. No site behavior changes.
