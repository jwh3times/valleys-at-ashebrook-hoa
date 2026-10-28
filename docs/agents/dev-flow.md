# Development flow

Every change travels one of the Matt Pocock skill flows. The map of those flows — the main flow,
its on-ramps, phase boundaries, and context hygiene — is
[`.agents/skills/ask-matt/SKILL.md`](../../.agents/skills/ask-matt/SKILL.md); read it when choosing a
path. This file holds only what this repo adds on top: the gate, the exemptions, and how the work
traces back to its issue.

`/handoff` here is the machine handoff (ADR 0029), not the portable-file handoff `ask-matt` routes
through: for a prototype or a side task in another directory, write the brief by hand.

## Who starts a phase

The flow skills — `/wayfinder`, `/grill-with-docs`, `/to-spec`, `/to-tickets`, `/implement`,
`/triage` — carry `disable-model-invocation: true`, so only the human can start them. That is
deliberate: the human decides every phase change, and the frontmatter stays as it is. At a phase
boundary the agent names the next command, says in one line why, and waits.

Inside a phase the agent reaches for the model-invoked skills itself: `/tdd`, `/code-review`,
`/diagnosing-bugs`, `/domain-modeling`, `/codebase-design`, `/prototype`, `/research`.

## The gate: a ready issue

Before the first edit of a non-exempt change, find the issue the work traces to. It is **ready**
when either:

- it carries `ready-for-agent` and its body is a `/to-spec` spec, a `/to-tickets` ticket, or a
  `/triage` agent brief; or
- it is a bug issue being worked through `/diagnosing-bugs` — the issue number is required, a spec is
  not.

When no ready issue exists, stop and route the user:

| Situation                                                       | Next command                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| An idea one session can hold                                    | `/grill-with-docs`, then `/to-spec` (and `/to-tickets` when it spans sessions) |
| A huge, foggy effort — too big to even plan in one session      | `/wayfinder`, then `/to-spec` once the map clears                              |
| A raw issue someone else filed (`needs-triage`, no agent brief) | `/triage`                                                                      |
| A ready issue nobody has started                                | `/implement` against it, in a fresh context                                    |
| Something broken                                                | file the bug issue, then work it through `/diagnosing-bugs`                    |

The gate is on edits. Reading code, running tests, and answering questions need no issue.

## Exempt changes

These skip the gate:

- **Dependency bumps** — Dependabot branches and `chore(deps)` changes.
- **Docs and agent config only** — the diff touches nothing outside `docs/`, root `*.md` files,
  `.agents/`, and `.claude/`. Any line of `src/`, `test/`, `scripts/`, `public/`, or config
  makes it a code change.
- **Release prep** — the `docs: prepare release vX.Y.Z` commit `/ship` adds to a branch, and a
  release-only branch that carries nothing else.
- **An explicit waiver** — the user says to skip the flow for this change. Proceed, and record it in
  the PR body as `Flow waived by the user: <reason>`.

## Tracing the work

- **Branch** — `<type>/<issue#>-<slug>`, e.g. `feat/294-tenant-invitation-claim`; a slice of a
  larger spec is `feat/<spec#>-slice-<n>-<slug>`.
- **PR body** — opens with `Closes #N` for the ticket it finishes, or `Part of #N` for one slice of
  a spec that stays open. An issue number in the title alone links nothing.
- **Close-out** — `/implement` ends on `/code-review` before it commits, and `/ship` opens the PR.
