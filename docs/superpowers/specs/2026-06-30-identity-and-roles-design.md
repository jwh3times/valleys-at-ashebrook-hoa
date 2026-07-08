# Identity & Roles — Design Spec

**Date:** 2026-06-30
**Status:** Draft for review
**Sub-project:** A (Identity & Roles) — the first piece of a larger program

---

## 1. Program context

The Valleys at Ashebrook HOA site is expanding from a public brochure site into a
homeowner service. The full program decomposes into loosely-coupled sub-projects:

| #      | Sub-project                                          | Depends on                   |
| ------ | ---------------------------------------------------- | ---------------------------- |
| P0     | Finish & ship the current public site                | —                            |
| **A**  | **Identity & roles (this spec)**                     | —                            |
| Ingest | Drive → OCR → text → tier-tag → index                | —                            |
| B      | Tiered document library (public / homeowner / board) | A, Ingest                    |
| C      | AI assistant (role-scoped RAG over the docs)         | Ingest (+ A for gated tiers) |

A is the shared spine: the same role model governs both who can open a document (B)
and what the assistant may retrieve when talking to a given user (C).

### Platform decision

The program targets the **Cloudflare** stack, migrating off the current Firebase
setup. Rationale: R2 has no egress fees (the document archive is ~289 MB of PDFs),
Workers AI + Vectorize provide embeddings and the vector index for the assistant,
D1 (SQLite) suits relational RBAC and per-owner records better than Firestore's
document model, and Pages hosts the Astro site. Trade-off accepted: this is a
migration, not an addition — the existing Firebase Auth board login and Firestore
data move to the Cloudflare stack as part of the program.

- **Hosting / rendering:** Astro on Cloudflare Pages (Cloudflare adapter).
- **Compute / API:** Cloudflare Workers.
- **Database:** Cloudflare D1 (SQLite).
- **Auth library:** Better Auth (runs natively on Workers; D1 via Kysely dialect).
- **Bot protection:** Cloudflare Turnstile.
- **SMS:** a third-party provider (e.g. Twilio) for one-time codes.

---

## 2. Goals and non-goals

### Goals

1. Let homeowners self-register and securely prove they are the owner of a specific
   property in the community.
2. Establish three roles — `visitor`, `homeowner`, `board` — with server-enforced
   authorization.
3. Support per-owner private data (a homeowner sees their **own** dues / violation
   status) without letting one owner see another's.
4. Give the board an admin surface to manage the owner roster, review/revoke
   homeowner accounts, and grant/revoke board access.
5. Replace the existing Firebase Auth board login with the new system.

### Non-goals (this sub-project)

- The document library (B) and the assistant (C) — A only provides the identity and
  authorization primitives they will consume.
- The actual dues/violations data tables and UI — built in later sub-projects. A
  defines only the `user ↔ property` link those features authorize against.
- Tenants/renters — **owners only** in v1 (see §10).
- Online payments.

---

## 3. Roles & access model

| Role                                                      | Can access                                                                | How obtained                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `visitor` (unauthenticated, or registered-but-unverified) | Public content only                                                       | Default                                                      |
| `homeowner`                                               | Public + shared homeowner content + **their own** property's private data | Self-signup, then possession-verified against the roster     |
| `board`                                                   | Everything + the admin surface                                            | **Granted by an existing board member. Never self-claimed.** |

- A registered user who has not completed property verification has `visitor`-level
  access until they do.
- The first board account is seeded manually during setup (bootstrap). Thereafter,
  board members grant the role to others via the admin surface.
- The board role is intentionally unreachable by any self-service path — it is the
  only way to view the most sensitive material (violations, correspondence, bank
  statements), mirroring how the current site already treats admin as
  console-granted.

---

## 4. Verification flow (possession-based)

Because the homeowner tier exposes **per-owner private data**, verification must
prove the registrant controls the contact details already on file for that
property — a static weak secret (e.g. last four of phone) would allow impersonation
of a specific owner and is therefore rejected.

```
1. Register: email + password (Better Auth).
   → Better Auth sends an email-verification link to the *signup* email (anti-spam).
2. Link property: the user selects/enters their address from the community list.
3. The system looks up the owner record for that address and sends a one-time code
   to the phone and/or email *on file in the roster* (NOT the signup email).
   → Channel is the user's choice: email (free) or SMS (Twilio).
4. The user enters the code → the account is linked to that owner record and granted
   the `homeowner` role, scoped to that property.
```

Only someone who controls the on-file phone/email can complete step 4 — this is what
makes exposing per-owner data safe.

### Guardrails

- One-time code expires in ~10 minutes; limited attempts then lockout.
- Cloudflare Turnstile on the signup and verification forms.
- Better Auth's built-in rate limiting on auth endpoints, plus Cloudflare
  rate-limiting rules on the verification endpoint.
- A **"new homeowners" audit list** in the admin surface so the board can review
  recent self-verifications and revoke any that look wrong.

### Fallbacks

- Owner's on-file phone/email is stale (changed number, etc.) → the request drops
  into a **board manual-approval queue**.
- Address not found / roster mismatch / typo → same manual-approval queue.

---

## 5. The owner roster (source of truth)

The board already maintains the roster (`Ashebrook HOA Contact List.xlsx`) and
already handles ownership transfers (`Ownership_Transfer_Report.pdf`). That roster
is the anchor for both verification and per-owner data.

- **Import:** a one-time import of the contact list into the `owners` table
  (name, address/unit, phone, email, status).
- **Maintenance:** the board edits the roster in the admin surface. An ownership
  transfer marks the old owner `inactive` (revoking that property's access for any
  linked account) and adds the new owner (who can then self-verify).

---

## 6. Data model (D1 / SQLite)

Better Auth-managed tables (created via its schema generator):

- `users` — id, email, hashed password, email_verified, `role`
  (`visitor` | `homeowner` | `board`), created_at
- `sessions`, `accounts`, `verifications` — standard Better Auth tables

Application tables:

- `owners` — roster: id, full_name, address, unit (nullable), phone, email,
  status (`active` | `inactive`), notes, created_at, updated_at
- `user_property_links` — user_id, owner_id, verified_at, method
  (`otp_email` | `otp_sms` | `board_manual`)
  - Many-to-many by design: **co-owners** = multiple users linked to one owner/
    property; **investors** = one user linked to multiple properties.
- `verification_attempts` — for rate-limiting/lockout: identifier, attempts,
  window_start (or equivalent), to bound brute-forcing of the one-time code.
- `manual_approval_queue` — pending verifications that fell back to board review:
  user_id, claimed_address, reason, status, created_at.

Later sub-projects add `dues`, `violations`, etc. keyed to `owner_id` — the
`user_property_links` table is what authorization checks them against.

---

## 7. Authorization model

All authorization is enforced **server-side in Workers** (API endpoints and any SSR
data fetch). The client is never trusted; the `role` and property links are
re-checked on every protected request against the validated session.

| Content class                    | Rule                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| Public                           | No auth required                                                                             |
| Shared homeowner content         | `role ∈ {homeowner, board}`                                                                  |
| Per-owner private data (owner X) | `role == board`, **or** (`role == homeowner` **and** owner X ∈ the user's linked properties) |
| Board content + admin surface    | `role == board`                                                                              |

Implementation note: a small authorization helper runs at the top of each protected
Worker route — resolve session → load role + linked owner_ids → apply the rule for
the requested resource. Per-owner endpoints take the target `owner_id`/property and
verify membership before returning data.

---

## 8. Admin surface (board)

A board-only section providing:

- **Roster management:** import, add, edit, and mark owners active/inactive
  (ownership transfers).
- **Homeowner account review:** the "new homeowners" audit list; revoke a homeowner
  account or unlink it from a property.
- **Manual approval queue:** approve/deny verifications that fell back to review.
- **Role management:** grant/revoke the `board` role (via Better Auth's admin
  capabilities).

Bootstrapping: the first board account is created during deployment setup.

---

## 9. Edge cases

| Case                                 | Handling                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Co-owners (two people, one property) | Both register and link to the same owner record                                                          |
| One owner, multiple properties       | Multiple `user_property_links` rows                                                                      |
| Ownership transfer                   | Board marks old owner `inactive` → linked accounts lose that property's access → new owner self-verifies |
| Lost access to on-file phone/email   | Falls back to the board manual-approval queue                                                            |
| Roster mismatch / address typo       | Falls back to the board manual-approval queue                                                            |
| Brute-forcing the one-time code      | Expiry + attempt limit + lockout + Turnstile + rate limiting                                             |
| Attempt to self-claim board          | Impossible — no self-service path grants `board`                                                         |

---

## 10. Migration from Firebase (auth scope only)

- Existing board members get `board` accounts on the new Better Auth + D1 system
  (seed the first, then grant the rest via the admin surface).
- The current Firebase Auth login and the `/admins` collection are retired in favor
  of Better Auth roles.
- Migration of non-identity Firestore data (announcements, settings, document
  metadata) to D1 and Storage to R2 is part of the broader program, tracked outside
  this spec; A stands up Better Auth, D1, and the roster.

---

## 11. Security considerations

- Possession-based verification is the core control protecting per-owner data.
- The `board` role is unreachable by self-service — the high-sensitivity tier
  depends on it.
- Passwords, sessions, email verification, and reset flows are handled by Better
  Auth (vetted), not hand-rolled.
- Rate limiting, lockout, and Turnstile bound code-guessing.
- One-time codes are single-use, short-lived, and sent only to on-file contacts.
- Authorization is server-side and re-evaluated per request.

---

## 12. Testing strategy

- **Authorization scoping:** a homeowner cannot read another owner's private data;
  a visitor cannot read homeowner content; only board reaches board content.
- **Verification flow:** register → email-verify → link property via OTP (email and
  SMS) → access scoped data.
- **Anti-abuse:** code expiry, attempt lockout, Turnstile gating.
- **Role integrity:** no self-service path yields `board`; granting/revoking board
  works.
- **Roster lifecycle:** transfer marks owner inactive and revokes linked access;
  new owner can verify.
- **Fallback:** stale contact / roster mismatch routes to the manual-approval queue.

---

## 13. Open questions / deferred

- **SMS provider:** Twilio assumed; confirm at implementation (cost ~1¢/message US).
- **Tenants/renters:** out of scope for v1; revisit as an owner-delegated invite if
  the board wants it later.
- **Per-owner data tables (dues, violations):** defined and built in later
  sub-projects; A provides only the link/authorization substrate.

---

## 14. Out of scope

Document library (B), ingestion pipeline, the AI assistant (C), online payments,
and tenant accounts. These consume A's identity primitives but are specified
separately.
