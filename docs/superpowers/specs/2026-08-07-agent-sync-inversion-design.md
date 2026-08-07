# Agent Sync Inversion Design

## Context

The repository currently treats `.claude/skills` and `.claude/agents` as authored sources and
generates Codex-readable skills beneath `.agents/skills`. The skills installer uses the opposite
layout for third-party skills: it writes real directories beneath `.agents/skills` and creates
Windows junctions beneath `.claude/skills`.

That mixed model is unsafe in this checkout. `git config core.symlinks` is `false`, and
`git add -n .claude/skills/ask-matt` enumerates the linked directory's individual files. Git would
therefore commit duplicate contents rather than a link. Node directory walking also reports these
junctions as links rather than directories, so the current generator silently skips them.

## Decision

Use one authored-skill model:

| Authored source | Generated artifact | Consumer |
| --- | --- | --- |
| `.agents/skills/<name>/**` | `.claude/skills/<name>/**` | Claude Code |
| `.claude/agents/<name>.md` | `.codex/agents/<name>.toml` | Codex |

The existing TypeScript generator will be inverted and retained instead of introducing a parallel
script. Its public command becomes `npm run sync:agents`; callers pass `-- --check` for read-only
verification. The old `agents:sync` and `agents:check` commands are removed so documentation,
hooks, local use, and CI share one vocabulary.

## Skill mirroring

Every real directory immediately beneath `.agents/skills` is an authored skill. Regeneration copies
the complete directory tree, including references, scripts, templates, and nested agent metadata.
It does not follow source-side symbolic links.

Each generated `SKILL.md` keeps `---` on line 1 and receives a YAML comment on line 2 stating that
the file is generated and naming its source. The remaining frontmatter and body are preserved with
deterministic LF newlines. Every other file is copied as an exact buffer; the repository's
`.gitattributes` policy keeps committed text files on LF across checkouts.

The generator owns the entire `.claude/skills` output tree. Regeneration removes stale generated
files and directories. Before replacing the installer-created junctions, it identifies them with
`lstat` and unlinks the junction itself; it never recursively deletes through a link. This safety
property is covered by a regression test.

The existing authored `ship` skill moves from `.claude/skills/ship` to `.agents/skills/ship`. Any
old generated banner is stripped from the new authored source. The installed third-party skills
already under `.agents/skills` remain the authored copies.

## Codex subagent generation

Claude subagents remain authored as `.claude/agents/*.md`. For each source, the generator reads the
frontmatter `name` and `description`, discards Claude-specific `tools` and `model` settings, and
writes `.codex/agents/<name>.toml` with the current official Codex fields:

- `name`
- `description`
- `developer_instructions`, populated from the Markdown body

Output is deterministic and LF-normalized. The generator owns and prunes the `.codex/agents`
directory.

## Formatting, hooks, and CI

Prettier formats authored files first and ignores both generated trees:
`.claude/skills` and `.codex/agents`. The required local order is:

1. `npm run format`
2. `npm run sync:agents`
3. `npm run sync:agents -- --check`

The Claude post-write hook calls the inverted generator when an authored skill or Claude subagent
changes. Generated output paths may also trigger a harmless consistency check, but never become
sources.

CI runs the read-only sync check and uses comments and step names matching the new direction. The
check reports missing, stale, and extraneous generated files without writing. Documentation warns
that symlinks and junctions must not be reintroduced because `core.symlinks=false` causes Git to
stage their contents as duplicates.

## Test seams

Tests exercise behavior at two agreed public seams:

1. Exported planner, diff, and sync functions operating on temporary repository fixtures.
2. The `sync:agents` CLI contract, including `--check` exit behavior.

Required cases cover complete skill-directory copying, the line-2 YAML banner, byte-preserved
supporting files, Claude-agent-to-Codex-TOML rendering, missing/stale/extraneous drift, safe junction
replacement, deterministic output, and parseable generated frontmatter.

## Verification

Before shipping:

1. Run format, regeneration, and the read-only sync check in the required order.
2. Run every command in the repository CI workflow: format check, sync check, coercion lint,
   Astro/TypeScript check, unit tests, Worker/D1 tests, and build.
3. Create a detached temporary worktree from the completed branch and run the generator's check
   there to verify committed LF bytes and generated artifacts.
4. Parse every generated `.claude/skills/*/SKILL.md` frontmatter and confirm the generated banner is
   present without displacing the opening delimiter.

## Alternatives rejected

- **Keep the mixed-direction mirror.** This leaves installer-managed skills invisible to the
  current walker and preserves two competing sources of truth.
- **Commit the links.** This checkout cannot represent them faithfully because
  `core.symlinks=false`; Git stages linked contents as ordinary duplicate files.
- **Commit two authored copies and compare them.** This detects some drift but retains the manual
  duplication the generator is intended to eliminate.
