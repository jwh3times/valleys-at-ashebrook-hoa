# Agent skills and shared scripts

How the skill and agent trees are generated, and which scripts are shared with other repositories.
`AGENTS.md`'s "Agents & Docs Automation" section carries the install commands and the never-edit
rules; this file carries the mechanics.

## One source of truth, two CLIs

`.agents/skills` is the authored source for complete skill directories. Run `npm run format` before
`npm run sync:agents`; the latter regenerates `.claude/skills` for Claude Code and `.codex/agents`
from authored `.claude/agents`. Never edit generated trees or reintroduce skill symlinks: with
`core.symlinks=false`, Git stages linked contents as duplicate files. Each authored Claude custom
agent is rendered as a Codex custom-agent TOML file, preserving its name, description, and developer
instructions. The `PostToolUse` hook in `.claude/settings.json` re-syncs after authored inputs
change, and CI plus `/open-pr` run `npm run sync:agents:check` to reject generated-tree drift. See
[ADR 0021](../adr/0021-authored-agent-skills-generate-tool-specific-trees.md).

In a linked worktree under `.worktrees/`, the `PostToolUse` hook resolves the primary clone and
correctly does nothing, so run `node scripts/sync-agents.mjs` in the worktree by hand. A worktree
has no `node_modules` either: run the primary copy's tools directly, for example
`node ../../node_modules/prettier/bin/prettier.cjs --check <file>`. To check what Codex discovers,
`codex debug prompt-input "hi"` in the repository prints its skill roots and every skill it found.

## Shared `.mjs` scripts

`scripts/sync-agents.mjs`, `scripts/lint-agent-neutrality.mjs`, `scripts/sync-main.mjs`,
`scripts/next-version.mjs`, `scripts/check-changelog.mjs`, `scripts/stamp-changelog.mjs`,
`scripts/check-docs.mjs` and `scripts/check-skills.mjs`, each with
its `node:test` suite, are the one exception to TypeScript-only `scripts/`: they are shared
**byte-for-byte** with other repositories, so they are plain `.mjs`, Prettier-ignored, outside the
TypeScript programs and Vitest, and must never be edited here — change the canonical copy in
`jwh3times/skills` and copy it to every repository. `npm run lint:agents` runs the second in CI: it
rejects agent or skill wording one tool cannot follow and links that break once a skill is
mirrored.
