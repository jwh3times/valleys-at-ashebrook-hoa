# ADR 0001: Possession-Based Homeowner Verification

**Status:** Accepted
**Date:** 2026-07-08

## Context

Homeowner-only content needs an authorization boundary, but the app is operated by
a resident and should avoid collecting extra identity documents. The owner roster
already contains the phone and email contacts the association has on file for each
property.

## Decision

Use Better Auth for accounts and verify homeowner access by possession of a
roster contact. A signed-in user requests verification for a property, the server
sends a one-time code to the active owner contacts on that property, and a
successful code confirmation links the user to the property.

Verification codes are HMAC-keyed, compared in constant time, rate-limited, and
gated by Turnstile. Homeowner authorization is derived server-side from the
verified property links.

## Consequences

- The app does not need driver's licenses, deeds, or other sensitive proof.
- A stale roster can block legitimate users until the board updates the roster or
  manually approves access.
- Future tenant/renter access needs a separate policy because possession of owner
  contact details proves ownership contact access, not tenancy.
