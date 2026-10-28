# ADR 0029: The Workflow Skills Install from a Shared Repository

**Status:** Accepted
**Date:** 2026-10-28

`ship`, `end-session`, `handoff` and `lets-go` were hand-maintained copies of skills the maintainer
also keeps in nine other repositories, each tailored in place, so a fix made here reached no other
repository and theirs never reached this one. `docs-updater` was a custom agent in
`.claude/agents/`, rendered to `.codex/agents/docs-updater.toml`.

All five now install from `jwh3times/skills`, the maintainer's shared skill repository:

```bash
npx skills add jwh3times/skills -s end-session -s handoff -s lets-go -s ship -s docs-updater -a codex --copy -y
npm run sync:agents
```

A skill body is identical in every repository that installs it. What is particular to this one is
read at run time from settings files under `docs/agents/` — `workspace.md`, `issue-tracker.md`,
`human-follow-up.md`, `docs.md`, `releases.md`, `ship.md` and `handoffs.md` — and how the Handoffs
folder reaches a machine is that machine's config (`~/.config/handoffs/config`), not this
repository's. Behavior changes by editing a setting; a body is fixed upstream and reinstalled.
`docs-updater` became a skill, so `.claude/agents/` holds only `code-reviewer`.
`npx skills update` is never used: it re-runs the install for every agent it detects, which links
`.claude/skills/<name>` back to its source instead of copying it.

Consequences:

- **The five installed skill directories are not formatted here.** `.prettierignore` lists them, so
  a reinstall reproduces them byte for byte. This narrows ADR 0021's "run `npm run format` before
  synchronization": Prettier still formats every other authored input.
- **`scripts/lint-agent-neutrality.mjs`** and its `node:test` suite join `sync-agents.mjs` as shared
  scripts copied byte for byte, Prettier-ignored, outside the TypeScript programs and Vitest. The
  `build` check runs it as `npm run lint:agents`: it rejects wording one tool cannot follow and links
  that break once a skill is mirrored.
- **`handoff` is recorded in `skills-lock.json` as `jwh3times/skills`,** not `mattpocock/skills`, so
  a Matt Pocock skills sync no longer overwrites the machine handoff. `ask-matt` still describes
  `/handoff` as Matt Pocock's portable-file handoff; `docs/agents/dev-flow.md` routes around it.
- **Human follow-ups are linked from the closing report, not the PR body.** The private issue and
  wiki page are filed as before (`docs/agents/human-follow-up.md`); the shared `ship` keeps private
  links out of public PRs.
