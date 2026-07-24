# ADR 0011: Claude-Sourced Agent Assets, Generated Mirror for Codex

**Status:** Accepted (implemented — `scripts/sync-agent-skills.ts`, `npm run agents:sync`)
**Date:** 2026-07-24

## Context

This repo is worked on with both Claude Code and Codex, and the two are meant to
behave the same way here: the same `ship` workflow, the same `code-reviewer`
rules, the same `docs-updater` scope. `AGENTS.md` already gives both CLIs the
same house rules — `CLAUDE.md` is a one-line import of it — but agent assets
(subagents, skills) are read from tool-specific directories:

| CLI         | Subagents             | Project skills                   |
| ----------- | --------------------- | -------------------------------- |
| Claude Code | `.claude/agents/*.md` | `.claude/skills/<name>/SKILL.md` |
| Codex       | no project registry   | `.agents/skills/<name>/SKILL.md` |

Verified against the installed toolchain rather than assumed: `codex debug
prompt-input` lists this repo's `.agents/skills` as a skill root and renders each
`SKILL.md` name/description into the model's context, while `.codex/agents/*.toml`
and a repo-level `.codex/skills/` are read by nothing (Codex's `skills` roots are
`$CODEX_HOME/skills`, `~/.agents/skills`, plugin caches, and `<repo>/.agents/skills`).
Claude Code, symmetrically, has no reference to `.agents/` at all.

An earlier attempt hand-wrote `.codex/agents/{code-reviewer,docs-updater}.toml`.
Those files were invisible to Codex — parity that looked real and was not — and
they were a second copy of instructions that would drift the first time only one
copy was edited.

## Decision

**`.claude/` is the source of truth. `.agents/skills/` is generated, committed,
and never hand-edited.**

`scripts/sync-agent-skills.ts` renders the mirror:

- **Skills** (`.claude/skills/<name>/`) copy verbatim — the `SKILL.md` format and
  its frontmatter are identical in both CLIs — with a provenance banner inserted
  under the frontmatter. Support files in the skill directory copy byte-for-byte.
- **Subagents** (`.claude/agents/<name>.md`) become skills, since Codex can spawn
  a subagent but has no file-based registry to define one. `tools:` and `model:`
  are dropped (Claude Code settings with no Codex equivalent) and a short
  "delegated role" preamble is added that names the source file and warns that
  tool names in the body are Claude Code's.

`.claude/` wins as the source because its format is the richer of the two: agent
frontmatter carries `tools:` and `model:`, which a mirror can drop losslessly but
could not invent in the other direction.

Drift is prevented at three points, weakest to strongest:

1. A `PostToolUse` hook in `.claude/settings.json` runs the sync whenever a
   `.claude/` agent or skill file is written, so Claude repairs the mirror in the
   same turn that changes a source.
2. `/ship` runs `npm run agents:check` with its other fast gates, so drift is
   caught before a push.
3. CI runs `npm run agents:check` on every PR and push to `main`. This is the
   authoritative gate — it is the only one that also covers Codex sessions, which
   do not execute Claude Code hooks.

The generator owns exactly the directories whose `SKILL.md` carries its banner,
so hand-written Codex-only skills could coexist under `.agents/skills/` without
being pruned.

## Consequences

1. Editing a `.claude/` agent or skill requires committing the regenerated
   mirror alongside it. CI fails the PR otherwise, with the exact stale paths and
   the command to fix them.
2. Codex sessions get the project's skills at the same names Claude uses
   (`ship`, `code-reviewer`, `docs-updater`), so instructions in `AGENTS.md` that
   reference them read the same for both.
3. Instruction bodies are written once, in Claude Code's idiom. Codex sees tool
   names it does not have (`Grep`, `Glob`); the preamble tells it to substitute
   equivalents rather than the generator trying to translate prose.
4. If Codex ever gains a native subagent format, the change is confined to the
   generator — the instructions themselves do not move.
