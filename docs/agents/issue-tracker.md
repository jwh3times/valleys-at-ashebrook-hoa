# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

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

Agent-completed work often ends with a step only a human can take: a dashboard, DNS, or zone
setting, a production migration or secret, a force-push, a named sign-off, a decision the
association owns. **The closing report is not where that step lives.** A chat reply is read once and
lost; the operator works from the tracker and the wiki. So every such step is filed, in two places,
before the agent reports the work done:

1. **A follow-up issue on the private tracker** (`jwh3times/valleys-at-ashebrook-hoa-ops`), one per
   distinct human action or one per coherent batch whose steps mean nothing apart, labelled
   `ready-for-human`, and added to the Ashebrook board with `Status` Todo, `Gate` set to the human
   gate that applies (`Operator action`, `Board decision`, or `Calendar/sign-off`), `Area`,
   `Next Action` naming the first step, and `Blocking Item` when one exists. The body says what the
   agent did, why the remaining step is human-only, what done looks like, and links the originating
   PR, issue, or advisory and the wiki page below. It goes on the private tracker because such steps
   almost always carry production identifiers or procedure detail. If a private issue already tracks
   the work — a remediation issue with an ordered checklist, say — add the step there as a checklist
   line plus a comment rather than opening a duplicate.
2. **A step-by-step page on the private wiki** (`jwh3times/valleys-at-ashebrook-hoa-ops` → Wiki):
   exact commands with their working directory, exact dashboard paths, the order when it matters,
   how to verify, and what rollback exists or that none does. Values-free — no resident value, no
   secret, no `op read` output. Name it for the task (`Operator-<topic>-<date>`, or a checklist
   name), link it from `Home`, and add one terse line to **`Human-TODO`**, the operator's tickable
   list, pointing at it. A long procedure may also live as a runbook in the companion's
   `operations/`; the wiki page may summarise and link it, but must be enough to start from.
3. **Say so in the closing report, with both links.** "You now need to…" in prose without the
   issue and the page is the failure this rule exists to prevent.

Mechanics. The wiki is a Git repository: clone
`https://github.com/jwh3times/valleys-at-ashebrook-hoa-ops.wiki.git` (branch `master`) into the
session scratchpad with `git -c credential.helper='!gh auth git-credential'`, edit, scan the changed
pages for contact values, commit, push. The scan reuses the CI gate's classifier:

```bash
node --experimental-strip-types --input-type=module -e "import { findContactValues } from './scripts/check-fixture-values.ts'; import fs from 'node:fs'; for (const f of process.argv.slice(1)) { const r = findContactValues(fs.readFileSync(f, 'utf8')); console.log(f, r.length ? JSON.stringify(r) : 'clean'); }" -- <page.md>...
```

Board writes need the `project` scope (see above). Field and option ids come from
`gh project field-list 6 --owner jwh3times --format json`; add an issue with
`gh project item-add 6 --owner jwh3times --url <issue-url>`, then set fields with
`gh project item-edit --project-id <project-id> --id <item-id> --field-id <field-id> --single-select-option-id <option-id>`
(or `--text` for `Next Action` and `Blocking Item`).

The rule binds every agent and skill that can finish work: `/ship` files the follow-up before it
reports, `end-session` audits that every human-only step from the session has both records,
`docs-updater` treats a missing pair as drift when a change it documents needs operator action, and
`code-reviewer` flags a diff that introduces an operator step without a linked follow-up.
