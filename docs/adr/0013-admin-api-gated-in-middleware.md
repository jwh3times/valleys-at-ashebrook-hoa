# ADR 0013: The Admin API Is Gated in Middleware, Not Only Per Route

**Status:** Accepted
**Date:** 2026-08-01

## Context

Access control in this app is server-side and fail-closed. For the board-only write surface that was
implemented as a convention: every handler under `src/pages/api/admin/` opens with

```ts
const denied = await requireBoard(locals, request, env);
if (denied) return denied;
```

Thirteen route files, thirty-two exported verbs, thirty-two hand-placed guards. `src/middleware.ts`
protected the `/admin` **pages** but not the `/api/admin` **routes** behind them, so the convention
was the only thing standing between an anonymous request and a board-only endpoint.

Two properties made that fragile:

1. **A missing guard broke nothing.** Per-resource gate tests each cover one resource. A new admin
   route added without `requireBoard` — and without someone remembering to write its gate test —
   leaves the whole suite green while shipping an open endpoint.
2. **The obvious safety net was not one.** `test/server/admin-surface-closed.test.ts` reads like a
   guard on the admin surface; it is a Better Auth admin-plugin regression test and never enumerates
   route modules.

The number of hand-placed guards is about to grow substantially: the meetings and voting work adds
several more admin route files.

## Decision

Two layers, deliberately redundant.

1. **A middleware prefix gate.** `src/middleware.ts` rejects `/api/admin/*` before the route runs:
   `401` when there is no auth context, `403` when the caller's role is not `board`. The codes
   mirror `requireBoard` exactly, so client behavior is unchanged. The match is on the path segment
   (`=== '/api/admin'` or `startsWith('/api/admin/')`), not a bare prefix, so a future sibling such
   as `/api/administrators` is not silently swept in.

2. **A route-enumeration test.** `test/server/admin-routes-all-gated.test.ts` globs
   `src/pages/api/admin/*.ts`, and for every exported `GET`/`POST`/`PUT`/`PATCH`/`DELETE` asserts an
   anonymous invocation returns `401`. It also asserts the glob matched a plausible number of
   modules and verbs, so a glob that silently matches nothing cannot make the suite vacuously green.

**Every handler keeps its own `requireBoard` call, and that remains the enforced layer.** The
Workers-pool tests invoke handlers directly and never run middleware, so the in-handler guard is what
the suite actually exercises. The middleware gate is a production backstop for the window between a
route being written and someone noticing its guard is missing.

## Consequences

The assertion in the enumeration test is `toBe(401)`, not `toBeGreaterThanOrEqual(400)`, and that
matters. Verified by mutation: removing the guard from `POST /api/admin/announcements` makes the
handler fall through to `readJson`, which returns **400** for the bodyless probe request. A
"non-2xx" assertion would have passed and let the ungated route through. Only the exact `401`
distinguishes "rejected the caller" from "rejected the request for some other reason".

`/api/bootstrap/board` is deliberately outside the gated prefix. It is the permanent, fail-closed
first-board bootstrap endpoint and self-disables once a board account exists; gating it behind a
board session would make bootstrapping impossible. Public reads under `/api/content/*`, the Better
Auth handler at `/api/auth/*`, and homeowner verification at `/api/verify/*` are likewise untouched
and covered by tests asserting they still pass through.

The redundancy is the point and should not be "cleaned up" later by deleting the per-route guards in
favor of the middleware. Doing so would leave the behavior untested, because the test pool bypasses
middleware entirely.
