# ADR 0003: Board Role Management and Bootstrap

**Status:** Accepted
**Date:** 2026-07-08

## Context

The site needs a way to create the first board account and later hand off board
access without exposing the broad Better Auth admin plugin surface to board users.

## Decision

The first board account is created through a permanent `POST /api/bootstrap/board`
endpoint guarded by `BOOTSTRAP_SECRET` and self-disabled once any board user
exists. Ongoing board membership changes are board-only app endpoints that write
the role directly in D1.

Board sessions are not granted Better Auth admin-plugin impersonation, ban, or
generic set-role capabilities. The app prevents demoting the last board member.

## Consequences

- Board handoff is supported without keeping a temporary privileged route around.
- Board users can manage the role the product actually needs, but not broader
  identity-provider administration.
- Any future role expansion should happen through explicit app endpoints and
  tests, not by widening Better Auth admin permissions.
