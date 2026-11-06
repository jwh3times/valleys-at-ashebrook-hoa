# Triage labels

The labels and what they mean are in `.agents/skills/ship/settings/triage-labels.md`. A skill's role name is the GitHub label to apply.

## Extra labels

Both trackers carry these, so one board view reads the same across them. Each one sits **beside**
the readiness label and never replaces it.

- **`blocked`** means the issue is waiting on a named dependency and can't progress yet. The
  dependency is another issue, an upstream release, or a third party. It sits beside whichever
  readiness label says who acts once the dependency clears. Name the dependency in the issue. A
  blocker on the same tracker is a native `blocked_by` edge, and one on the other tracker goes in
  the board's Blocking Item. Remove the label when the dependency clears. An issue that is dormant
  until someone shows a need for it is `needs-info`, not `blocked`.
- **`P1-critical` / `P2-high` / `P3-medium` / `P4-low`**: priority. Every open issue carries exactly
  one. Priority is set by value and by how much other work an issue unblocks, whether or not it is
  blocked, so a blocked issue can still be high priority. `P1` is the critical path, the item that
  unblocks the most other work. `P4` is someday, taken only when nothing higher is available. A new
  issue gets one at triage.
