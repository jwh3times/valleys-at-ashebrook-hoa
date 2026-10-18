# Google Drive Import — Design

- **Date:** 2026-10-18
- **Status:** Draft, for maintainer review
- **Issue:** [#290](https://github.com/jwh3times/valleys-at-ashebrook-hoa/issues/290)
- **ADR:** [0027](../adr/0027-association-drive-connection.md)
- **Research:** [2026-09-30-google-drive-import-research.md](./2026-09-30-google-drive-import-research.md)

## Purpose

Board admins keep association records in Google Docs, Sheets and Slides. Getting one into the
document library today means exporting it by hand and uploading it again. This feature lets a board
admin pick files in the association's Google Drive and import them as ordinary documents. Each
import is a one-time snapshot: after the export, the existing upload pipeline takes over, including
duplicate checks, the search twin and tier enforcement.

The design was settled with the maintainer on 2026-10-01 and recorded in the [#290 decisions
comment](https://github.com/jwh3times/valleys-at-ashebrook-hoa/issues/290#issuecomment-5925066225).
It was then amended on 2026-10-17 to share the sign-in Cloud project. A throwaway prototype checked
the three assumptions Google's docs leave open; its [verdict is also on
#290](https://github.com/jwh3times/valleys-at-ashebrook-hoa/issues/290#issuecomment-6244099893).
This spec turns those decisions into routes, tables and tests.
[Changes from the 2026-10-01 decisions](#changes-from-the-2026-10-01-decisions) lists every place
this spec departs from them, for review.

## Goals

- One **Drive Connection**: a server-held authorization to the association's own Google account.
  System Administrators manage it, and it survives without anyone signing in.
- Board admins import up to 10 picked files at a time, each as an ordinary `documents` row:
  - Docs and Slides as PDF;
  - Sheets as XLSX;
  - files Drive stores as-is (pdf, txt, md, csv, doc, docx, xls, xlsx), unchanged.
- An imported document is indistinguishable from an uploaded one everywhere outside the board's
  admin panel.
- Every import is attributable to the individual board admin's own Account, never to the shared
  Google account.
- Resident Google sign-in keeps requesting identity only, and keeps storing no Google token.

## Non-goals

- **Live synchronization.** An import is never refreshed from Drive. A newer version needs a new
  import.
- Importing folders, Google Forms, Drawings, Sites, Apps Script or any type not listed above.
- Exports over Google's 10 MB `files.export` limit, through `files.download` or `exportLinks`.
  Google documents no size limit for either, and neither is a supported way around the cap.
- Slides exported as PPTX, or Docs exported as Markdown or DOCX.
- Any Drive scope broader than `drive.file`, which would mean restricted-scope verification and an
  annual security assessment.
- Writing to Drive.
- An audit-ledger family for document uploads and deletes. Today neither writes a history row
  (code fact 6). That gap predates this feature and is not closed here.

## Code facts this design rests on

Each fact was checked against `main` at `e531b8c` on 2026-10-18.

1. **The upload pipeline is private to one route.** `POST /api/admin/documents`
   (`src/pages/api/admin/documents.ts`) holds:
   - the 25 MiB cap (`MAX_BYTES`, `413`);
   - the extension allowlist that maps each extension to a server-chosen content type
     (`EXT_TO_TYPE`, `415`);
   - the exact-duplicate refusal (`409 exact-duplicate`, never overridable);
   - the near-duplicate warning (`409 near-duplicate`, overridden by `confirmDuplicate=true`, which
     also clears `keep_verified_*` on the documents it matched);
   - the R2 writes, the twin and the D1 insert.

   None of it is exported. The allowlist is also copied by hand in
   `src/components/admin/DocumentsManager.tsx` and in `src/server/ai/twin.ts`.

2. **Near-duplicate means `nearScore ≥ NEAR_THRESHOLD` (0.6)** in `src/server/content/dedupe.ts`.
   It is 0 unless the content types match. Otherwise it is word overlap of the normalized title and
   filename, plus 0.2 when the sizes are within 5%. ADR 0007 calls it "metadata-based" without a
   formula.
3. **Upload order is R2 original → twin → R2 twin → D1 insert, with no rollback.** A failed insert
   leaves both R2 objects behind. The delete route has the reverse problem, filed as
   [#442](https://github.com/jwh3times/valleys-at-ashebrook-hoa/issues/442).
4. **The twin is built inline** during the request, by `generateTwin` (`twin.ts`), which never
   throws. A failure gives `rag_status='unsupported'`, and the upload still succeeds.
5. **`documents` has no uploader or provenance column.** No foreign key to `users.id` anywhere uses
   `ON DELETE SET NULL`. Actor columns are plain text with no FK by documented convention:
   `setting_changes.acting_account_id`, `reports.created_by` (`docs/agents/data-model.md`).
6. **`setting_changes`** has `id`, `key`, `old_value`, `new_value`, `acting_account_id` (NOT NULL),
   `recorded_at`. It is append-only, enforced by `test/unit/setting-changes-append-only.test.ts`.
   It is written by raw SQL in the same `batch` as a compare-and-swap (`setSiteGate`,
   `src/pages/api/admin/site.ts`). Document uploads and deletes write no history row.
7. **No third-party credential is stored anywhere.** Google sign-in nulls its provider tokens
   (`NO_PROVIDER_TOKENS`, `src/server/auth/index.ts`). There is no symmetric-encryption helper in
   `src/`. App code uses KV only for verification rate limits.
8. **The write freeze is deny-by-default.** Exemptions are `{ base, why }` entries in
   `ALWAYS_LIVE` (`src/server/authz/write-freeze.ts`). `test/unit/freeze-coverage.test.ts`
   asserts that list exactly.
9. **`runScheduledJobs`** (`src/server/scheduled.ts`) runs three independent `try`/`catch` jobs and
   throws at the end if any failed. It never checks the freeze.
10. **`system_admin` capabilities** are checked with `requireApiCapability` or
    `requireCapability(ctx, 'systemAdmin')`. `test/server/permission-matrix.test.ts` discovers
    admin routes itself, and routes finer than board are listed in its `SYSTEM_ADMIN_ONLY`.
11. **"Appears when its secrets are set"** is the sign-in pattern: `isGoogleSignInConfigured(env)`
    feeds a page prop, and the provider answers 404 otherwise.
12. **The enforced CSP blocks the Picker.** It is built in `src/middleware.ts`:
    - `script-src` lacks `https://apis.google.com`;
    - `frame-src` lacks `https://docs.google.com`.
13. **`/privacy`** says, under "Signing in with Google": "We never request access to your Google
    Drive, contacts, or any other Google data." Under "Google user data" it says: "We use Google
    account information only to sign you in to this site."

## Prototype findings this design rests on

From the 2026-10-17 run (`RESULTS.md` on the never-merge branch `prototype/290-drive-import`):

- **P1.** A server-minted token exports files a different client's Picker session shared. A
  never-picked file returns `404 notFound`.
- **P2.** The Picker always shows the token's account, never the browser's other accounts. Without
  that account signed into the browser, it asks to sign in.
- **P3.** Docs and Slides PDF exports are byte-identical across repeats. Sheets XLSX exports differ
  every time.
- **P4.** Google's consent screen lets the user untick Drive. The token then carries only `openid`
  and `email`, and every Drive call answers `403`.
- **P5.** Per-file grants survive a revoke followed by fresh consent from the same account.
- **P6.** A website-restricted Picker key must also allow `https://docs.google.com/*`, as Google's
  web-Picker guide says.

## Decisions

### 1. The Drive Connection

#### Ownership and project

- **Account.** The connection is to the **Association Google Account**: a dedicated Gmail account
  that no person uses as a personal login. It must never sign in to this site.
- **Project and client.** It lives in the same Cloud project as resident Google sign-in, with its
  own OAuth client. The sign-in client is never edited.
- **Why the account must never sign in.** Revocation is project-wide for the revoking account: it
  removes every scope that account granted to any client in the project. If the Association Google
  Account were ever someone's sign-in identity, Disconnect would also revoke that sign-in.
- **Who acts.** Exactly one connection exists at a time. Only a System Administrator can connect,
  reconnect or disconnect it.

#### Storage: a single-row D1 table

The connection is stored in a single-row D1 table, not KV. See
[change 1](#changes-from-the-2026-10-01-decisions).

```sql
CREATE TABLE drive_connection (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  status                 TEXT NOT NULL CHECK (status IN ('connected', 'broken')),
  google_sub             TEXT NOT NULL,
  google_email           TEXT NOT NULL,
  refresh_token_sealed   TEXT,
  key_version            INTEGER NOT NULL DEFAULT 1,
  granted_scope          TEXT NOT NULL,
  connected_by           TEXT NOT NULL,
  connected_at           INTEGER NOT NULL,
  last_used_at           INTEGER,
  last_refreshed_at      INTEGER,
  broken_at              INTEGER,
  broken_reason          TEXT,
  revision               INTEGER NOT NULL DEFAULT 1,
  CHECK ((status = 'connected') = (refresh_token_sealed IS NOT NULL)),
  CHECK ((status = 'broken') = (broken_at IS NOT NULL))
);
```

- **No row means disconnected.** A broken connection keeps its row, with the credential cleared, so
  a reconnect can enforce the same-account rule.
- **`connected_by`** is plain text with no FK, following the actor-column convention.
- **Every write is a compare-and-swap.** Each one carries `WHERE id = 1 AND revision = ?`, and the
  matching `setting_changes` insert in the same `batch` is guarded by `changes() = 1`, as
  `setSiteGate` does. A lost race answers `409` and writes neither row.

#### Sealing the refresh token

- **Cipher.** AES-256-GCM through WebCrypto.
- **Key.** `DRIVE_TOKEN_KEY`, a Worker secret holding 32 random bytes in base64.
- **Format.** Each seal uses a random 96-bit IV. The stored value is `v1.<iv>.<ciphertext>` in
  base64url.
- **Additional data.** The AAD is `drive_connection:<google_sub>:<key_version>`, so a sealed token
  cannot be replayed onto a different account's row.
- **Where it lives.** The helper lives in `src/server/drive/seal.ts`. Plaintext exists only in the
  memory of the request or job that is minting an access token.
- **What is never stored.** Access tokens are minted per use and never stored. No token is logged
  or returned by any route, except the Picker session token below.
- **Key rotation.** Rotating `DRIVE_TOKEN_KEY` is a reconnect: the old row cannot be unsealed, so
  it is marked broken. `key_version` exists so a later rotation scheme doesn't need a migration.

#### Connect and reconnect

`GET /api/admin/drive/connect` requires the `systemAdmin` capability and is frozen.

1. It refuses unless the feature is configured (decision 7).
2. A connect is refused with `409` if a `connected` row exists.
3. A reconnect is allowed when the row is `broken`, or `connected` with an explicit `reconnect=1`.
4. It sets a short-lived `__Host-drive_oauth` cookie (HttpOnly, Secure, SameSite=Lax, 10 minutes).
   The cookie holds an HMAC-signed `{ state, codeVerifier, accountId, intent, exp }`, signed with a
   subkey derived from `DRIVE_TOKEN_KEY` by HKDF. This avoids KV's cross-location staleness for a
   value that must be read back seconds later.
5. It redirects to Google with:
   - `scope=openid email https://www.googleapis.com/auth/drive.file`;
   - `access_type=offline`;
   - `prompt=consent select_account`;
   - PKCE `S256`;
   - the `state`.

`GET /api/admin/drive/callback` requires the `systemAdmin` capability and is frozen.

1. It verifies the cookie signature and expiry, that `state` matches, and that the caller is still
   the Account that started the flow.
2. It exchanges the code with the PKCE verifier and reads `sub`, `email` and `email_verified` from
   the `id_token`. The token comes straight from Google's token endpoint over TLS, so its claims
   are trusted without a signature check, as OpenID Connect allows.
3. **It requires `drive.file` in the granted scope (P4).** Otherwise it revokes the new token and
   returns to the card with: "Google didn't grant Drive access. Connect again and tick 'See, edit,
   create and delete only the specific Google Drive files that you use with this app'."
4. It requires a `refresh_token`. Without one, it revokes and asks the System Administrator to
   retry.
5. **Same account.** If a row exists, `sub` must equal `google_sub`. Otherwise it revokes the new
   token and refuses: "This connection belongs to `<google_email>`. Disconnect first to connect a
   different Google account."
6. It writes the row and a `setting_changes` row in one compare-and-swap batch, then clears the
   cookie and redirects to the card.

#### Disconnect

`POST /api/admin/drive/disconnect` requires the `systemAdmin` capability. It is **exempt from the
write freeze**, the third `ALWAYS_LIVE` entry, because stopping access must never wait for a
freeze to lift.

1. It reads the row and, when it holds a credential, unseals it and POSTs it to
   `https://oauth2.googleapis.com/revoke`.
2. It deletes the row and writes `setting_changes`, in one batch, **whether or not the revoke
   succeeded**.
3. If the revoke failed, the response says so. The site holds no credential any more, and the
   System Administrator can remove the app under the Association Google Account's
   **Security → Your connections to third-party apps & services**.
4. Imported documents are untouched.

**Disconnect does not clear Google's per-file grants (P5).** Reconnecting the same account restores
access to every file picked before. The card says this. Picking files again is never needed after a
reconnect, and a different account can't use the old grants.

#### Keepalive and the broken state

A fourth independent job in `runScheduledJobs`, `driveKeepalive`, runs when the feature is
configured and a `connected` row exists.

- **Success.** It mints an access token, which counts as client use for Google's six-month limits
  on both the token and the client, and sets `last_refreshed_at`.
- **`invalid_grant` or `deleted_client`.** It marks the row `broken`: credential cleared,
  `broken_at`, and a `broken_reason` that names the error only. It writes `setting_changes` in the
  same compare-and-swap batch.
- **Any other failure** (network, 5xx) logs and fails the job, so the run shows red, without
  touching the row. A transient error must not break a working connection.
- **The freeze.** The job runs regardless of the write freeze, like the other scheduled jobs. It
  records a fact Google has already decided and creates no content.

Any request that gets `invalid_grant` while minting does the same compare-and-swap. A Picker
session or an import are examples. The `revision` guard means a request that read the row before a
disconnect or reconnect can't overwrite the newer state. Broken connections send no email.

#### History

The `setting_changes` rows use `key = 'drive_connection'` and statuses only. They never hold a
token or the scope string.

| Event      | `old_value` → `new_value`             | `acting_account_id`                   |
| ---------- | ------------------------------------- | ------------------------------------- |
| connect    | `none` → `connected`                  | the System Administrator              |
| reconnect  | `connected` or `broken` → `connected` | the System Administrator              |
| disconnect | `connected` or `broken` → `none`      | the System Administrator              |
| broken     | `connected` → `broken`                | `scheduled-job` or the acting Account |

`scheduled-job` is a literal sentinel, because the column is NOT NULL.

### 2. Picking files

`POST /api/admin/drive/picker-session` requires `requireBoard` and is frozen. Its body is empty.

- It requires a `connected` row.
- It mints an access token and returns:
  - `accessToken`;
  - `expiresAt`;
  - `developerKey` (`DRIVE_PICKER_API_KEY`);
  - `appId` (`DRIVE_PROJECT_NUMBER`).
- It updates `last_used_at` on a best-effort basis.

The board admin's browser holds an association token with `drive.file` for up to an hour.

- **What the token can do.** It reads any file the association has ever picked, and it could create
  files in that Drive.
- **Accepted.** Board admins are trusted with the whole board tier already, the scope reaches no
  unpicked file, and the token is never stored.
- **Not done:** downscoping the token, because Google documents no `drive.file` subset narrower than
  itself.

The browser loads `https://apis.google.com/js/api.js` and builds a `PickerBuilder` with:

- a `DocsView` in `LIST` mode, as Google recommends without thumbnail access, with folders off;
- `MULTISELECT_ENABLED` and `setMaxItems(10)`;
- `setOAuthToken`, `setDeveloperKey` and `setAppId`;
- `SUPPORT_DRIVES`, which Google now enables by default.

**Guidance line (P2).** Next to the button, the panel says: "Google shows files from the
association's Google account. If it asks you to sign in, sign in to that account in this browser.
You can stay signed in to your own account too."

### 3. Preview

`POST /api/admin/drive/preview` requires `requireBoard`. It is read-only, but frozen like every
admin `POST`. Its body is `{ fileIds: string[] }`, with 1 to 10 IDs. For each file, the server calls
`files.get` with `supportsAllDrives=true` and these fields:

```
id,name,mimeType,modifiedTime,size,trashed,capabilities/canDownload,shortcutDetails
```

Each file then gets one plan:

| Drive item                                             | Plan                                              |
| ------------------------------------------------------ | ------------------------------------------------- |
| `application/vnd.google-apps.document`                 | export → `application/pdf`, filename `<name>.pdf` |
| `application/vnd.google-apps.presentation`             | export → `application/pdf`, filename `<name>.pdf` |
| `application/vnd.google-apps.spreadsheet`              | export → XLSX, filename `<name>.xlsx`             |
| blob whose name's extension is in the upload allowlist | download unchanged (`files.get?alt=media`)        |
| shortcut                                               | refuse: "Pick the original file, not a shortcut." |
| trashed, or `canDownload` false                        | refuse with that reason                           |
| anything else, including a blob over 25 MiB by `size`  | refuse with the type or size reason               |

- **`404` or `appNotAuthorizedToFile`** refuses only that file: "Pick it again in Google Drive".
- **Content type.** A blob's stored content type comes from the shared allowlist, never from Drive,
  as for uploads.
- **Duplicates at preview.** Each importable row also reports:
  - a **Drive duplicate**: an earlier import of the same Drive file with the same `modifiedTime`,
    which is refused;
  - a **newer Drive version**: the same Drive file with a different `modifiedTime`, a
    near-duplicate;
  - a **name near-duplicate** from `nearScore`, using the planned content type with no size,
    because an export's size isn't known until export.
- **What stays for commit.** The byte-identical check needs the bytes, so it waits for commit.

The response carries one row per file: Drive name, Drive type, stored-as type, `modifiedTime`,
`size` when Drive reports one, plan or refusal, and any warnings. It never carries file contents.

### 4. Commit

The browser imports the batch **one file at a time**. Each file is a
`POST /api/admin/drive/import` with `requireBoard`, frozen. The body is
`{ fileId, expectedModifiedTime, title, category, visibility, confirmDuplicate }`.

1. Re-check what preview checked: configuration, a `connected` row, `title` within
   `INPUT_LIMITS.title`, `category` in `DOCUMENT_CATEGORIES`, and `visibility` one of
   `public`/`homeowner`/`board`.
2. Mint a token and call `files.get` again.
   - A changed `modifiedTime` answers `409 changed-since-preview`: the file was edited after
     preview, so preview again.
   - A changed type or a refusal answers that refusal.
3. Export or download while counting bytes, and abort as soon as the count passes the cap. The cap
   is 10 MB for exports and 25 MiB for downloads.
   - Over the cap answers `413` with: "Too large to import from Drive. Export it from Google and
     upload it here instead."
   - A Google export error answers the same `413`, with Google's reason logged. Google documents no
     specific reason for the export limit.
4. Compute SHA-256.
   - A byte-identical document answers `409 exact-duplicate`, never overridable.
   - A Drive duplicate answers `409 drive-duplicate`, never overridable.
   - A newer Drive version or a near-duplicate answers `409 near-duplicate` unless
     `confirmDuplicate` is set. Confirming clears `keep_verified_*` on the matches, as for uploads.
5. Hand the bytes to the shared store (decision 5). It writes the `documents` row, with
   `uploaded_by` set to the caller, and the `drive_imports` row in **one D1 batch**.
6. Update `last_used_at` on a best-effort basis, and answer `201` with the new document's `id`.

Each file succeeds or fails on its own, and the preview table shows each result in its row. A
`409 near-duplicate` row offers **Import anyway**, which resends that one file with
`confirmDuplicate=true`.

**Why the Drive-duplicate rule is needed (P3).** A Sheet exports to different bytes every time, so
the SHA-256 check alone would let the same unchanged Sheet in again and again. The Drive file ID
plus `modifiedTime` is the stable identity of a Drive version. Deleting an imported document
cascades its `drive_imports` row away, so the same version can then be imported again.

### 5. A shared document store

`src/server/documents/store.ts` becomes the one place that stores a document. Both
`POST /api/admin/documents` and the import route call it. It owns:

- the upload allowlist and its content types, exported and imported by `DocumentsManager.tsx` and
  `twin.ts` instead of their hand copies;
- the 25 MiB cap;
- the exact-duplicate and near-duplicate checks;
- the R2 writes, the twin and the insert.

**R2 cleanup on failure.** Writes stay in the order R2 original → twin → D1 batch. A failed batch
now deletes the R2 objects it wrote before rethrowing, which closes the upload half of #442.

**One result type.** Its result is a discriminated union: `stored`, `exact-duplicate`,
`near-duplicate` or `too-large`. The upload route's existing status codes and JSON bodies stay
byte-for-byte the same.

### 6. Records

#### Uploader

The migration adds this column:

```sql
ALTER TABLE documents ADD COLUMN uploaded_by TEXT;
```

- **What fills it.** Uploads and imports both set it to the acting Account's ID. Existing rows stay
  `NULL`, meaning not recorded.
- **No foreign key.** It is plain text with no FK, following the actor-column convention, so an
  Account's removal never erases attribution. See
  [change 2](#changes-from-the-2026-10-01-decisions).
- **Display.** The admin panel resolves it to the Account's name when one exists.

#### Import details

```sql
CREATE TABLE drive_imports (
  document_id          TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  drive_file_id        TEXT NOT NULL,
  drive_mime_type      TEXT NOT NULL,
  drive_modified_time  TEXT NOT NULL,
  export_format        TEXT CHECK (export_format IN ('pdf', 'xlsx')),
  google_sub           TEXT NOT NULL,
  imported_at          INTEGER NOT NULL
);
CREATE INDEX drive_imports_file_version ON drive_imports (drive_file_id, drive_modified_time);
```

- `export_format` is `NULL` for a blob that was downloaded unchanged.
- `google_sub` records which Association Google Account the file came from, so a later account
  change stays legible.
- This is a new table, so the FK action lives in the hand-authored `CREATE TABLE` and isn't exposed
  to the drizzle-kit `ALTER TABLE` trap.

#### Visibility of the records

`uploaded_by` and `drive_imports` are read only by admin routes. Every public and homeowner
serializer is unchanged, so an imported document looks exactly like an uploaded one. A test
enforces that (see [Tests](#tests)).

### 7. Configuration and feature gate

`isDriveImportConfigured(env)` (`src/server/drive/config.ts`) is true only when all five Worker
secrets are present, and `DRIVE_TOKEN_KEY` decodes to exactly 32 bytes:

- `DRIVE_CLIENT_ID`
- `DRIVE_CLIENT_SECRET`
- `DRIVE_PICKER_API_KEY`
- `DRIVE_PROJECT_NUMBER`
- `DRIVE_TOKEN_KEY`

When it is false:

- every `/api/admin/drive/*` route answers `404`;
- the import button and the connection card are not rendered;
- `driveKeepalive` skips without failing.

The feature does not depend on `officialMode`. Each secret is added to `.dev.vars.example`, to the
companion's `.dev.vars.tpl` and to `src/ambient.d.ts`.

### 8. Interface

- **Status read.** `GET /api/admin/drive/status` (`requireBoard`) returns `{ configured, status }`
  plus, when connected or broken, the Google email, who connected it and when, the last use and the
  last refresh.
- **Documents panel.** **Import from Google Drive** sits beside **Upload document** in
  `DocumentsManager.tsx`'s button row. With no `connected` row it is disabled and shows why:
  - no connection: "Google Drive isn't connected. Ask a System Administrator to connect it.";
  - broken: "The Google Drive connection stopped working. Ask a System Administrator to reconnect
    it."

  The guidance line from decision 2 sits beneath it.

- **Import dialog.** It opens the Picker, then shows the preview table:
  - one row per file;
  - a batch **Category**, required, with no default;
  - a batch **Visibility**, defaulting to `board`;
  - a per-row title, category and visibility;
  - each row's warnings;
  - **Import** and per-row results.

  Every row action names its file, for example `Import anyway: Budget 2027`, per AGENTS.md.

- **Drive connection card.** System Administrators get it in the admin panel's site-settings area.
  It shows the status, the Association Google Account's address, and who connected it and when. It
  also shows the last use and last refresh, plus **Connect**, **Reconnect** and **Disconnect**.
  Disconnect asks for confirmation and states what it does and doesn't do (P5).

### 9. Content Security Policy

The admin HTML response needs these two directives widened. Public pages keep today's policy.

- `script-src`: add `https://apis.google.com`.
- `frame-src`: add `https://docs.google.com`. When the connected account isn't signed in, the
  Picker frame navigates to Google sign-in (P2), so `https://accounts.google.com` is also expected.

The exact set is **measured, not assumed**. Slice 3 first ships the additions in a report-only
header beside the enforced one, records which origins the Picker actually loads, then enforces the
smallest set. `src/middleware.ts` gains a per-path policy, so only `/admin` responses carry the
Google origins.

### 10. Privacy page

`src/pages/privacy.astro` changes in the slice that first stores the credential.

- **"Signing in with Google"** keeps its promise, which is still true for every resident, and adds
  a pointer to the new section.
- **New "Google Drive imports" section.** It says:
  - the association connects its own Google account, not any resident's;
  - the site stores one encrypted credential for that account;
  - it reads only the files a board admin picks;
  - each import becomes an ordinary document under the existing retention and visibility rules;
  - Disconnect deletes the credential;
  - Google's Limited Use policy applies.
- **"Google user data"** is reworded so that "only to sign you in" covers resident sign-in, and the
  Drive data use is stated beside it.

## Changes from the 2026-10-01 decisions

These need the maintainer's sign-off. Everything else follows the decisions comment as amended on
2026-10-17.

1. **The connection record is a single-row D1 table, not one KV entry.**
   - **The problem.** KV reads can be stale across locations for up to about a minute, and KV has
     no conditional write.
   - **Failure 1.** A request that read the record just before a Disconnect would hit
     `invalid_grant` and write a `broken` record back, resurrecting a deleted connection.
   - **Failure 2.** Two concurrent reconnects could both pass the same-account check.
   - **Why D1.** AGENTS.md requires these checks inside the mutation, and D1 compare-and-swap is
     how site gates and ballots already meet it.
   - **What doesn't change.** The token stays sealed under a Worker-secret key, so a D1 export or
     Time Travel copy holds only ciphertext.
2. **`uploaded_by` is plain text with no FK, not an FK with `ON DELETE SET NULL`.** No `users.id`
   FK in the schema uses `SET NULL`. Actor columns are plain text by documented convention, and
   `SET NULL` would erase attribution when an Account is removed, which is the opposite of what an
   uploader column is for.
3. **Two duplicate refusals are named separately.** "Same Drive file and same `modifiedTime`" is
   `409 drive-duplicate`, and "byte-identical" stays `409 exact-duplicate`. The board then sees
   which rule fired. The behavior is as decided.

## Requirements the prototype added

- Connect checks the granted scope, and refuses a grant without `drive.file` (P4).
- The import panel carries the "sign in to the association's account in this browser" line (P2).
- The production Picker key allows the site's origin and `https://docs.google.com/*`, and only the
  Picker API (P6).
- The Disconnect copy says per-file grants survive at Google (P5).
- The CSP widening in decision 9.

## Failure and edge behavior

| Situation                                         | Result                                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Feature not configured                            | Drive routes `404`; no button, no card                                                                                |
| No connection, or broken                          | Import disabled with the reason; Drive routes `409 no-connection`                                                     |
| Token refresh gets `invalid_grant` during any use | Row marked broken (compare-and-swap); that request `409 no-connection`                                                |
| Token refresh fails transiently                   | That request `503`; row untouched                                                                                     |
| A file was edited between preview and commit      | `409 changed-since-preview` for that file                                                                             |
| Picked file no longer authorized or deleted       | That file refused: pick it again                                                                                      |
| Export over 10 MB, or download over 25 MiB        | `413` with the "export and upload it manually" message                                                                |
| D1 batch fails after R2 writes                    | R2 objects deleted, `500`                                                                                             |
| Write freeze on                                   | Connect, callback, picker session, preview and import frozen; disconnect works                                        |
| Board admin loses Board Access mid-batch          | Remaining files `403`; finished files stay imported                                                                   |
| Two admins import the same Drive version at once  | Possible double import. The Drive-duplicate check is not in the batch, as the hash check isn't for uploads. Accepted. |

## Tests

### Worker/D1 tests

New `test/server/drive-connection.test.ts`:

- The seal round-trips, a seal under one `google_sub` fails to unseal under another, and a tampered
  ciphertext fails.
- Callback scope handling:
  - a grant without `drive.file` is refused and revoked;
  - a grant without a refresh token is refused;
  - a different `sub` on reconnect is refused and revoked;
  - a stale `state`, cookie or Account is refused.
- Compare-and-swap:
  - a broken-marking with a stale `revision` changes nothing, after a disconnect or a reconnect;
  - two reconnects race to one success and one `409`;
  - each successful write has exactly one `setting_changes` row.
- Disconnect:
  - it deletes the row when the revoke fails;
  - it works under the write freeze;
  - connect does not.
- Configuration: every Drive route answers `404` when any one secret is missing, or the key isn't
  32 bytes.

Google is a stubbed `fetch` in all of these; no test calls Google.

New `test/server/drive-import.test.ts`:

- Each plan row in decision 3.
- The commit order and refusals:
  - `changed-since-preview`;
  - `413` at both caps, aborting mid-stream;
  - `exact-duplicate`, `drive-duplicate` and `near-duplicate`, the last overridden by
    `confirmDuplicate`, which clears `keep_verified_*`.
- `documents` and `drive_imports` are written in one batch, and `uploaded_by` is the caller.
- Deleting a document cascades its `drive_imports` row away, and the version can then be imported
  again.

### Indistinguishable downstream

Every public and homeowner read helper and API serializer returns identical keys for an imported
document and an uploaded one, and never `uploaded_by` or `drive_*`.

### Store refactor

The four `test/server/admin-documents*.test.ts` suites and `documents-twin.test.ts` pass unchanged, which pins the upload route's status codes
and bodies. A new case covers a failed D1 batch deleting its R2 objects. `DocumentsManager.tsx` and
`twin.ts` import the allowlist rather than copying it, and a unit test asserts there's one source.

### Static and structural suites

- The permission matrix lists `drive/connect`, `drive/callback` and `drive/disconnect` in
  `SYSTEM_ADMIN_ONLY`.
- `admin-routes-all-gated` covers every new route automatically.
- `freeze-coverage` gains the disconnect exemption.
- `test/unit/scheduled.test.ts` covers `driveKeepalive`'s three outcomes, and confirm that its failure
  doesn't stop the other jobs.
- `test/server/middleware-headers.test.ts` shows the Google origins only on `/admin` responses.

Each new guard is mutation-checked: remove it and its test fails.

## Delivery slices

Each slice is one PR, reviewed and merged on its own.

1. **Shared store and uploader.**
   - `src/server/documents/store.ts`, with the upload route moved onto it;
   - R2 cleanup on failure;
   - one allowlist source;
   - the `uploaded_by` migration, with the panel showing the uploader.

   No Drive code. It also closes the upload half of #442.

2. **The connection.**
   - the `drive_connection` migration, the seal helper and the config gate;
   - the connect, callback, disconnect and status routes;
   - the card and `driveKeepalive`;
   - the freeze exemption and the privacy-page change.
3. **Import.**
   - the `drive_imports` migration;
   - the picker-session, preview and import routes;
   - the CSP report-only measurement, then enforcement;
   - the import dialog.

Slices 2 and 3 each leave human steps, filed as `ready-for-human` follow-ups by `/ship`:

- create the Association Google Account and add it as a second Owner of the Cloud project;
- create the production OAuth client `Ashebrook Drive import`, with origin
  `https://ashebrookresidents.com` and redirect
  `https://ashebrookresidents.com/api/admin/drive/callback`;
- create the production Picker key, restricted to `https://ashebrookresidents.com/*` and
  `https://docs.google.com/*` and to the Picker API;
- generate `DRIVE_TOKEN_KEY` and set the five secrets;
- apply the migrations;
- connect;
- delete the prototype client, the prototype key, the prototype 1Password item and the test
  account.

## Out of scope

- Live sync, folder import, or any scope broader than `drive.file`.
- `files.download` long-running exports or `exportLinks` for files over 10 MB.
- The OAuth-redirect Picker (`trigger_onepick`), which Google documents for desktop and mobile apps
  only.
- Google's Cross-Account Protection (RISC) notifications. The daily keepalive finds a dead token
  within a day, which is enough here.
- An audit-ledger family for document writes (Non-goals).
- The delete half of #442.

## Open questions for review

1. **Sign-off on the three changes** in
   [Changes from the 2026-10-01 decisions](#changes-from-the-2026-10-01-decisions).
2. **Card placement.** This spec puts the connection card in the site-settings area. Should it
   instead sit in the Documents panel, shown only to System Administrators?
3. **Concurrent double import.** Two board admins importing the same Drive version within the same
   seconds could both succeed (Failure and edge behavior). Moving the Drive-duplicate check into the
   D1 batch with a partial unique index would close it, at the cost of a less specific error. Is
   the accepted risk right at this scale?
