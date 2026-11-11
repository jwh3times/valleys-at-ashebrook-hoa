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
change, and CI plus `/ship` run `npm run sync:agents:check` to reject generated-tree drift. See
[ADR 0021](../adr/0021-authored-agent-skills-generate-tool-specific-trees.md).

## Shared `.mjs` scripts

`scripts/sync-agents.mjs`, `scripts/lint-agent-neutrality.mjs`, `scripts/sync-main.mjs`,
`scripts/next-version.mjs`, `scripts/check-changelog.mjs` and `scripts/check-docs.mjs`, each with
its `node:test` suite, are the one exception to TypeScript-only `scripts/`: they are shared
**byte-for-byte** with other repositories, so they are plain `.mjs`, Prettier-ignored, outside the
TypeScript programs and Vitest, and must never be edited here — change the canonical copy in
`jwh3times/skills` and copy it to every repository. `npm run lint:agents` runs the second in CI: it
rejects agent or skill wording one tool cannot follow and links that break once a skill is
mirrored.
