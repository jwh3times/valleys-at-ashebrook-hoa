### Changed

- `docs/agents/merging.md` and `docs/agents/dependabot.md` now say an oxlint minor can stop honoring
  the suppression comments code relied on, as 1.95.0 did for two admin effects (#649). The fix is the
  same as for a new `correctness` rule: rewrite the code on the Dependabot branch, never re-suppress
  it or disable the rule. `AGENTS.md` now names the shared admin hook `useAdminResource` among the
  users of the documented mount-fetch shape. No site behavior changes.
