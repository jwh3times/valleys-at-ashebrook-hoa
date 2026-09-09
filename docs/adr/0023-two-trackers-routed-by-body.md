# ADR 0023: Two Issue Trackers, Routed by Body, With the Board as a View

**Status:** Accepted
**Date:** 2026-09-09

Backlog items are GitHub issues. `ROADMAP.md` explains the trackers and the Gate vocabulary but
holds no status lines, because a status line in a tracked file is a second copy of the truth that
goes stale the moment work moves.

Issues live in **two** repositories, and which one is decided by **the content of the body, never by
the topic**. The public repository `jwh3times/valleys-at-ashebrook-hoa` is the default: product,
engineering, dependencies, architecture, and anything whose body is safe to publish. The private
companion `jwh3times/valleys-at-ashebrook-hoa-ops` takes an issue only when the body itself cannot
be public — production identifiers, resident or roster data, operator procedure detail, or the
specifics of an unfixed security problem.

Routing on the body rather than the subject is the whole point. "Security" is not a private topic
and "documentation" is not a public one; an issue about a private thing belongs in the public
tracker whenever it can be written without reproducing that thing, pointing at the private record
for the part that cannot. Public issue #278 is the worked example. Routing by topic instead would
quietly drag ordinary engineering work into a tracker nobody outside the maintainer can read, and
the backlog would stop being a public artifact of a resident-run site.

The [Ashebrook project board](https://github.com/users/jwh3times/projects/6) is one ordered view
across both trackers, carrying Status, **Gate**, Area, Next Action, and Blocking Item. **The issue
is the record; the board is a view.** Durable facts go in the issue body and comments and never only
in a Project field, so the board can go stale without losing anything — which it will, because its
fields are deliberately cheap to update and nothing enforces them. Board visibility and issue
visibility are independent: a private board holding public issues keeps the _ordering_ unpublished
while the issues stay public, which is the arrangement in use.

The **Gate** field names why an item is not moving, and the vocabulary is fixed so that "blocked"
never has to be interpreted: _None — ready to work_, _Spec needed_, _Board decision_, _Operator
action_, _Upstream_, _Needs evidence_, _Calendar/sign-off_. Three of those — board decision,
operator action, calendar/sign-off — describe work that no agent can finish, which is what makes the
field worth having on a repository worked mostly by agents.

Two operational consequences follow, and both have already cost time:

- `gh` infers the repository from `git remote -v`, so private-tracker commands must run from
  `private/` or pass `--repo jwh3times/valleys-at-ashebrook-hoa-ops` explicitly.
- `gh project` writes need the `project` token scope, and **a token without it fails silently** in
  the way that matters: the `gh project` call errors, nothing else does, and the session still looks
  clean. Check with `gh auth status` for `project` (not `read:project`).

Moving tracking is never only a tracker change. Skills, agents, ADRs, and the private companion may
name the old location, and the ones that delegate inherit the change while the ones that hardcode it
break — silently, since nothing type-checks a tracker name. Grep for the old name across all four
before calling a relocation done.

[`docs/agents/issue-tracker.md`](../agents/issue-tracker.md) stays the operational how-to: the `gh`
invocations, the label conventions, the wayfinder operations, and the human-follow-up procedure.
This ADR records only the decisions those instructions rest on.
