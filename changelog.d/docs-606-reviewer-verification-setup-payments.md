### Fixed

- **Three docs now match the repository (#606).**
  - The code reviewer agent reads `docs/agents/verification.md` whenever a diff adds or changes a
    test, so it checks that a new test can fail on the old code.
  - The setup guide's online payments section no longer says payments are still being built. The
    Stripe rail shipped in v2.11.7–v2.11.9, and none of it is live in production yet.
  - The agent-skills guide no longer says a worktree has no `node_modules` at all: a new worktree
    has none until `npm ci` installs it, as the workstation bootstrap guide runs.
