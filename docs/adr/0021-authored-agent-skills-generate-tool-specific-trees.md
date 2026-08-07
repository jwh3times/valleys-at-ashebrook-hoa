# ADR 0021: Authored Agent Skills Generate Tool-Specific Trees

**Status:** Accepted
**Date:** 2026-08-07

The repository needs one editable copy of shared skills while supporting Claude Code's skill tree
and Codex's custom-agent registry. The complete `.agents/skills/<name>/**` directories are the
authored skill source, and `.claude/agents/*.md` remains the authored source for custom agents.
`npm run sync:agents` generates the complete `.claude/skills/**` tree from the authored skills and
renders `.claude/agents/*.md` as TOML-safe `.codex/agents/*.toml` files. Generated trees are
committed but never edited directly; CI and the ship workflow enforce this boundary with
`npm run sync:agents -- --check`.

Run `npm run format` before synchronization. Prettier formats the authored inputs and ignores both
generated roots, so generation remains deterministic and does not feed formatting changes back
into the source. Real generated directories are required instead of symlinks or junctions. On the
supported Windows checkout with `core.symlinks=false`, Git cannot preserve repository symlinks as
links and stages the linked contents as duplicate paths; installer-created junctions create the
same ownership ambiguity. The synchronizer therefore rejects links in authored trees and replaces
links at generated-tree boundaries without traversing or modifying their targets.

This supersedes ADR 0011, whose Claude-authored direction and assumption that Codex lacked a
project custom-agent registry no longer match the installed toolchain or repository layout.
