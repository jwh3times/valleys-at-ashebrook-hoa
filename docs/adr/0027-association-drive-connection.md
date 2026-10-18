# ADR 0027: The Association's Google Drive Connection Is One Sealed Server-Held Credential

**Status:** Proposed
**Date:** 2026-10-18

## Context

Board admins want to import Google Docs, Sheets and Slides into the document library (#290)
without exporting and uploading each one by hand. The association's files sit in a Google account
that belongs to the association, not to any board admin. Board admins change over time, so the
access can't depend on whoever happens to be signed in.

Until now the site has stored **no third-party credential at all**. Google sign-in (#415) requests
identity only and deliberately discards every provider token, and the privacy page promises that.
Storing a credential that works without anyone signing in is the new capability this decision
governs.

Google offers broad Drive scopes, which reach every file in the account, and the narrow
`drive.file` scope, which reaches only files the user hands to the app through Google Picker. Every
broad Drive scope is restricted. That means Google's restricted-scope verification plus an annual
third-party security assessment for any app that stores or transmits the data server-side, which a
snapshot import does. `drive.file` is non-sensitive and needs neither.

## Decision

### One connection, to an association account, held by the server

- **The account.** The site holds exactly one **Drive Connection**, to a dedicated **Association
  Google Account**. No person uses that account as a personal login, and it never signs in to the
  site.
- **Who manages it.** Only a System Administrator can connect, reconnect or disconnect it.
- **The same account on reconnect.** Reconnecting must use the same Google account, compared by
  Google's stable account ID, unless the connection was disconnected first.
- **Attribution.** Every import is attributed to the individual board admin's own Account. The
  shared Google identity never becomes anyone's site login, and never stands in for an Account in
  any record.

### `drive.file` only, so every file is picked

The connection requests `openid email drive.file` and nothing broader.

- **Every file is picked.** Under `drive.file` a pasted link grants nothing. Each imported file
  passes through Google Picker in the board admin's browser, and the server then exports it with
  its own token.
- **Prototyped.** A prototype confirmed that combination on 2026-10-17. It also confirmed that the
  Picker only ever shows the connected account's files, never the board admin's own.
- **The grant is checked.** Google's consent screen lets the user untick Drive, so connect verifies
  the granted scope and refuses a grant without `drive.file`.

### The credential is sealed and stored in D1

- **What is stored.** The refresh token is the only stored credential. It sits in a single-row D1
  table, sealed with AES-256-GCM under a key held as a Worker secret, with the Google account ID
  bound in as additional data.
- **What is never stored.** Access tokens are minted per use and never stored. A Picker session
  hands one to the board admin's browser for up to an hour.
- **Why D1 and not KV.** Every write to the connection is a D1 compare-and-swap on a revision, so a
  request that read the row before a disconnect or reconnect can't overwrite the newer state. KV
  can't make that guarantee.
- **Why seal it in D1 at all.** A D1 export, or a Time Travel copy, holds only ciphertext.
- **History.** Connect, reconnect, disconnect and broken events are appended to `setting_changes`,
  never with the credential.

### Disconnect, keepalive and the broken state

- **Disconnect** revokes at Google and deletes the credential, even if the revoke call fails. It is
  exempt from the write freeze, so stopping access never waits for a freeze to lift. Documents
  already imported stay.
- **Keepalive.** The daily scheduled job refreshes the token as its own independent step, which
  keeps both the token and the OAuth client clear of Google's six-month inactivity limits.
- **Broken.** A dead token (`invalid_grant`) marks the connection **broken** and deletes the
  credential, until a System Administrator reconnects.

### It shares the sign-in Cloud project, with its own client

The connection is an OAuth client in the same Google Cloud project as resident Google sign-in. The
sign-in client is never edited. The operator chose this on 2026-10-17 over a separate project.

- **Shared settings.** Google applies one consent screen, one app name, one publishing status, any
  verification, and project-level suspension to every client in the project.
- **Never Testing.** The project stays In production. Testing would block resident sign-in for
  anyone not listed, and would expire the Drive token after 7 days.
- **Never shut down.** The project must never be shut down as a rollback. Rolling back the Drive
  connection means deleting its client and key and removing `drive.file` from the consent screen.
- **Revocation is project-wide for the revoking account.** That is why the Association Google
  Account must never be used to sign in to the site: a Disconnect would revoke that sign-in too.

### Imports are snapshots

- An import is never refreshed from Drive; a newer version is a new import.
- Everything after the export is the ordinary upload pipeline: tiers, duplicate checks and the
  search twin.
- Outside the board's admin panel, an imported document is indistinguishable from an uploaded one.

## Considered options

- **Each board admin connects their own Google account.** Rejected. Access would vanish when that
  admin leaves, and the association's files would depend on personal accounts.
- **A broad Drive scope with a folder or link-paste flow.** Rejected. Every broad scope is
  restricted, which means restricted-scope verification plus an annual security assessment for one
  small association.
- **A Google Workspace organization with an Internal app**, which needs no verification at all.
  Rejected. It requires a paid Workspace or Cloud Identity organization, while the association
  account is a plain Gmail account.
- **A separate Cloud project for Drive.** Decided on 2026-10-03, then reversed on 2026-10-17 by the
  operator, accepting the shared-project trade-offs above.
- **The connection as one KV entry.** Rejected in the design spec. KV has no conditional write, and
  can read stale across locations for about a minute.
- **Live sync.** Rejected. A mirror has no stable content hash, which breaks ADR 0007's duplicate
  policy, and it would make the library's contents depend on Drive.

## Consequences

- The site now holds one third-party credential. Losing `DRIVE_TOKEN_KEY` is recoverable with a
  reconnect. Leaking it together with the D1 data and the OAuth client secret exposes the files
  the association has picked, and no others. `SECURITY.md` and `/privacy` describe the credential when the connection ships.
- A future second third-party integration should follow the same pattern: a sealed credential in
  D1, compare-and-swap writes, a freeze-exempt disconnect, and an independent keepalive. It should
  not invent another.
- Per-file Drive grants survive a disconnect at Google. Reconnecting the same account restores
  access to every file picked before. The Disconnect copy says so.
- The design spec, [2026-10-18-google-drive-import-design.md](../specs/2026-10-18-google-drive-import-design.md),
  carries the routes, tables, tests and delivery slices.
