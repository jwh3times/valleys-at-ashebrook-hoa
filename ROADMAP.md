# Roadmap

**Updated:** 2026-09-04

Backlog items are **GitHub issues**, not entries in this file. This page explains where to look and
what the tracker's vocabulary means; it deliberately holds no status lines, because a status line
here is a second copy of state that drifts out of step with the issue that owns it.

## Where the work is

| Surface                                                                                | Holds                                                                                                                          |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [Public issues](https://github.com/jwh3times/valleys-at-ashebrook-hoa/issues)          | Product, engineering, dependencies, architecture — anything whose body is safe to publish                                      |
| [Private ops issues](https://github.com/jwh3times/valleys-at-ashebrook-hoa-ops/issues) | Work whose body cannot be public: production identifiers, resident data, operator procedure detail, unfixed security specifics |
| [The Ashebrook project board](https://github.com/users/jwh3times/projects/6) (private) | One ordered view across both repositories, carrying Status, Gate, Area, Next Action, and Blocking Item                         |

The routing rule between the two repositories is in
[`docs/agents/issue-tracker.md`](./docs/agents/issue-tracker.md).

## The current priority

**[ADR 0022 phase 4 (#212)](https://github.com/jwh3times/valleys-at-ashebrook-hoa/issues/212)** —
the irreversible removal of the legacy roster schema and compatibility layer. Its production entry
gate cannot open before **2026-09-17** and additionally requires no clock-resetting Sev-1 plus named
human sign-off. Phases 1–3 are shipped and production has used derived access since 2026-08-18.

#212 is the authoritative source for its own live entry criteria, removal sequence, and sign-off.
That checklist changes; this file does not duplicate it.

## Reading a gate

Every backlog issue states a **Gate** — what has to happen before work can start. This is the field
that made a Markdown roadmap unmaintainable, because gates change without anyone editing a file.

- **None — ready to work** — nothing blocks it.
- **Spec needed** — design decisions have to be settled first.
- **Board decision** — needs an association decision, not an engineering one.
- **Operator action** — a human at a dashboard or a keyboard.
- **Upstream** — waiting on a dependency or platform capability.
- **Needs evidence** — deliberately dormant until a real need is observed.
- **Calendar/sign-off** — time-gated with a named approval.

A gated item is not a commitment to build it. Several exist so the design reasoning is on record and
is not rediscovered from scratch.

## How to use the backlog

- Treat each product item as requiring its own spec before build.
- Keep security, authorization, and visibility checks server-side.
- Add or update tests with every behavior change.
- Update `CHANGELOG.md` when an item ships.
- Add an ADR when an item changes a durable architecture or operating decision.

## What stays in files, not issues

Issues hold **work** — things with a "done". These stay as files because they record what is true or
how to do something, and have no completion state:

- `docs/adr/` — durable architecture and operating decisions, reviewed alongside the code.
- `AGENTS.md` and `docs/agents/` — context loaded by agents at session start.
- `private/operations/` — runbooks you execute.
- `CHANGELOG.md` — the release record.
- `CONTEXT.md`, `SETUP.md`, `SECURITY.md` — domain vocabulary, deployment, and the security model.

## Product Opportunities

This section records the longer-range product vision so it is not lost. **Nothing here is backlog**,
and none of it has a "done", which is why it is prose here rather than issues. This repo is the v1
pilot of a possible self-managed HOA governance product; Ashebrook remains a single-community
deployment, and any multi-tenant productization requires its own decision, recorded as an ADR,
before this repo's architecture bends toward it.

- **COI tracking.** Certificate-of-insurance tracking for vendors. Weak as a standalone feature but
  a good shared module across this product and LeaseBook. The build-once-ship-twice decision belongs
  at the product level, not in this repo's backlog.
- **Board certification courses.** Document library plus quiz plus certificate PDF. Not software
  revenue — treat as top-of-funnel marketing for a future product. No backlog entry.
- **Monetization notes.** Pricing observations kept here so the backlog entries stay
  product-neutral: election management supports per-election pricing ($200–500/election) on top of a
  subscription and is the best-margin item; the reserve planning tracker is a price-ladder module
  sold to the same buyer under the same login.

## Completed work

Not duplicated here. See `CHANGELOG.md` for shipped changes and `docs/adr/` for durable decisions.
