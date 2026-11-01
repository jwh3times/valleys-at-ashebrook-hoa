# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

The decisions behind the arrangement below — two trackers routed by body, the board as a view, and
the Gate vocabulary — are recorded in
[ADR 0023](../adr/0023-two-trackers-routed-by-body.md). This file is the how-to. Which issue a code
change must trace to before its first edit, and how branches and PRs link back, is in
[the development flow](../../.agents/skills/ship/settings/dev-flow.md).

## Which repository an issue goes in

Two trackers, and the choice is decided by **the content of the body**, never by the topic.

- **Public** — `jwh3times/valleys-at-ashebrook-hoa`. The default. Product, engineering,
  dependencies, architecture, and anything whose body is safe to publish.
- **Private** — `jwh3times/valleys-at-ashebrook-hoa-ops`. Only when the body itself cannot be
  public: production identifiers, resident or roster data, operator procedure detail, or the
  specifics of an unfixed security problem.

When an issue is _about_ something private but can be written without reproducing it, it belongs in
the public tracker pointing at the private record. #278 is the worked example.

`gh` infers the repo from `git remote -v`, so run private-tracker commands from `private/` or pass
`--repo jwh3times/valleys-at-ashebrook-hoa-ops` explicitly.

## The project board

[Ashebrook](https://github.com/users/jwh3times/projects/6) (private, user-owned) is one ordered view
across both trackers. Fields: Status, **Gate**, Area, Next Action, Blocking Item.

**The issue is the record; the board is a view.** Durable facts go in the issue body and comments,
never only in a Project field. The fields are deliberately cheap to update so the board can go stale
without losing anything.

Board visibility and issue visibility are independent — a private board holding public issues keeps
the _ordering_ unpublished while the issues stay public.

`gh project` writes need the `project` token scope, and **a token without it fails silently**: the
`gh project` call errors, nothing else does, and the session still looks clean. Check with
`gh auth status` (look for `project`, not `read:project`) and fix with
`gh auth refresh -h github.com -s project`. The device flow needs a real terminal, so an agent shell
cannot do it.

### Gate values

- **None — ready to work** — nothing blocks it.
- **Spec needed** — design decisions have to be settled first.
- **Board decision** — needs an association decision, not an engineering one.
- **Operator action** — a human at a dashboard or a keyboard.
- **Upstream** — waiting on a dependency or platform capability.
- **Needs evidence** — deliberately dormant until a real need is observed.
- **Calendar/sign-off** — time-gated with a named approval.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line
  bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also
  fetching labels.
- **List issues**:
  `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`
  with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature
requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr`
equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**:
  `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then
  keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop
  `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`,
  `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with
`gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body.
  `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues
  endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put
  `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>`
  (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving
  dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation.
  Add an edge with
  `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`,
  where `<blocker-db-id>` is the blocker's numeric **database id**
  (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub
  reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where
  dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child
  body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's
  sub-issues / task list), drop any with an open blocker
  (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an
  assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a
  context pointer (gist + link) to the map's Decisions-so-far.

## Security findings and long-form reviews

Two routing rules decided 2026-09-05, alongside the public/private rule above:

- **An unfixed security finding is a draft repository security advisory on the public repo**
  (`gh api -X POST repos/jwh3times/valleys-at-ashebrook-hoa/security-advisories`), never an issue on
  either tracker. The private companion cannot host advisories (GitHub answers 404 there, even on
  Pro). A draft is visible to repository admins only; close it (do not publish) when publication
  would add exposure.
- **A long-form review or audit goes to the private companion's wiki**, never into either tracked
  tree. `Home` is the index there. A tracking issue on either tracker links both the wiki page and
  the advisories; ops issue #22 with the wiki page `Security-Review-2026-09-04` is the worked example.

## Human follow-ups from agent work

Moved to [`human-follow-up.md`](./human-follow-up.md): the private issue, the board fields, the wiki
page and its contact-value scan. This heading stays so links to it still land.

## Public repository

jwh3times/valleys-at-ashebrook-hoa

## Board

jwh3times 6 — the private Ashebrook board, one ordered view across both trackers. A new issue does
not join it on its own: add it with `gh project item-add 6 --owner jwh3times --url <issue-url>`.

## Board fields

- `Status`: `Todo` / `In Progress` / `Done`.
- `Gate`: `None — ready to work` / `Spec needed` / `Board decision` / `Operator action` /
  `Upstream` / `Needs evidence` / `Calendar/sign-off` (see Gate values above). Change it only when a
  blocker genuinely opened or closed; do not re-gate an item because it feels stuck.
- `Area`: `Roster & access` / `Meetings & voting` / `Documents & AI` / `Platform & deps` /
  `Operations` / `New product domain`.
- `Next Action` (text): the first concrete step. Refresh it on anything a session touched; a stale
  one is worse than an empty one, because it will be believed.
- `Blocking Item` (text): what blocks it, when something does.

The issue is the record; durable facts go in its body and comments, never only in a field.

## Security findings

The default (see "Security findings and long-form reviews" above). A long-form review goes to the
companion's wiki, linked from a tracking issue.
