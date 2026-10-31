# Human follow-ups from agent work

Agent-completed work often ends with a step only a human can take: a dashboard, DNS, or zone
setting, a production migration or secret, a force-push, a named sign-off, a decision the
association owns. **The closing report is not where that step lives.** A chat reply is read once and
lost; the operator works from the tracker and the wiki. So every such step is filed — an issue and
a wiki page — before the agent reports the work done, and the report names both links. They stay
out of the PR body, which is public.

The procedure is the `## Procedure` the shared skills carry
(`.agents/skills/end-session/settings/human-follow-up.md`, installed from `jwh3times/skills`, ADR
0029); the settings below bind it to this repository. Each `##` heading is one setting.

## Follow-up destination

The default (the private tracker): such steps almost always carry production identifiers or
procedure detail. One issue per distinct human action, or per coherent batch whose steps mean
nothing apart. If a private issue already tracks the work — a remediation issue with an ordered
checklist, say — add the step there as a checklist line plus a comment rather than opening a
duplicate.

## Follow-up board

same as Board — `Status` `Todo`; `Gate` the human gate that applies (`Operator action`,
`Board decision`, or `Calendar/sign-off`); `Area`; `Next Action` naming the first step; and
`Blocking Item` when one exists.

## Follow-up wiki

The private tracker's wiki, `https://github.com/jwh3times/valleys-at-ashebrook-hoa-ops.wiki.git`
(branch `master`), cloned into the session scratchpad with
`git -c credential.helper='!gh auth git-credential'`. Link each new page from `Home`, and add one
terse line to `Human-TODO`, the operator's tickable list. A long procedure may live as a runbook in
the companion's `operations/`; the wiki page may summarise and link it, but must be enough to start
from. Pages are values-free: no resident value, no secret, no `op read` output.

Before pushing, scan the changed pages for contact values with the CI gate's classifier, and fix
any hit:

```bash
node --experimental-strip-types --input-type=module -e "import { findContactValues } from './scripts/check-fixture-values.ts'; import fs from 'node:fs'; for (const f of process.argv.slice(1)) { const r = findContactValues(fs.readFileSync(f, 'utf8')); console.log(f, r.length ? JSON.stringify(r) : 'clean'); }" -- <page.md>...
```

Then push without asking: publishing the follow-up is part of the work.
