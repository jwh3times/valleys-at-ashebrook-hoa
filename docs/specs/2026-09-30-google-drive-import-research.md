# Google Drive import: scopes, Picker, export, and token lifetime

Date: 2026-09-30  
Issue: [#290 — Google Docs, Sheets, and Drive import (ROADMAP item 1)](https://github.com/jwh3times/valleys-at-ashebrook-hoa/issues/290)

Research only, not a design proposal. Every source below was read on 2026-09-30; the page's own
"Last updated" stamp is recorded in [Sources](#sources) where Google shows one. Statements marked
**Inference** are this document's reasoning, not something a Google page says.

## Bottom line for #290

- **Scope: `drive.file` is the only Drive scope that avoids restricted-scope review.** Google
  classifies `drive.file` as non-sensitive and "recommended"; `drive`, `drive.readonly`,
  `drive.metadata`, and `drive.metadata.readonly` are all **restricted**, which means restricted
  scope verification plus an annual third-party security assessment (CASA) for a public app that
  stores or transmits the data server-side — and snapshot import does exactly that.
- **Under `drive.file`, a pasted URL or file ID grants nothing.** Access exists only for files the
  app created, files opened with the app from the Drive UI ("Open with"), or files the user shares
  with the app through the Google Picker. Calling the API on any other file fails with
  `appNotAuthorizedToFile` ("The user has not granted the app {appId} … access to the file"). So a
  **Picker step (or a Drive UI integration) is required** for every file imported. A pasted ID can
  pre-filter the Picker (`DocsView.setFileIds`, or `file_ids=` in the OAuth-redirect Picker), but
  the user still has to confirm it there.
- **Picker needs the Cloud project number (`setAppId`, required for `drive.file`), an API key, and
  an OAuth access token for the account whose Drive is being browsed.** Google documents that a
  later token with `drive.file` can read files "the user previously granted access" to, and that a
  refresh token represents the combined authorization for the whole Cloud project. It does not
  spell out, in one sentence, that a Picker grant made in a browser is usable by a server's stored
  refresh token; that is a well-supported inference, not a quoted guarantee. Google also now
  documents an **OAuth-redirect Picker** (`trigger_onepick=true` on the authorization URL, returning
  `picked_file_ids` plus an authorization code with `access_type=offline`), documented for desktop
  and mobile apps; whether a web-server client may use it is not stated.
- **Verification burden with `drive.file` alone is light.** Non-sensitive scopes do not trigger the
  unverified-app screen or the 100-user cap; brand verification is only needed to show the app's
  name and logo on the consent screen. **Internal** (no verification at all) requires a Google
  Workspace or Cloud Identity organization that owns the Cloud project — **not available to a
  consumer Gmail account**. The 100-user cap would be irrelevant anyway with one consenting
  account.
- **Export cap: `files.export` is limited to 10 MB of exported content.** Docs → PDF
  (`application/pdf`) and Sheets → XLSX
  (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`) are both supported. Google
  documents `files.download` (a long-running operation) as another way to export Docs and Sheets
  and states no size limit for it — silence, not a promise. `exportLinks` are documented as
  browser download links; no size limit is stated for them either. Uploaded PDFs/DOCX download
  with `files.get?alt=media`, not export.
- **Token-lifetime risks for a server-held connection.** An External app left in **Testing** gets
  refresh tokens that **expire after 7 days** (the identity-only exemption does not cover
  `drive.file`), so the connection's project must be **In production**. A refresh token also dies
  after **6 months unused**, on user or admin revocation, when the account exceeds **100 live
  refresh tokens for that client** (oldest silently invalidated), or on time-based-access expiry.
  The password-change rule applies to Gmail scopes only. Separately, an **OAuth client unused for
  six months is automatically deleted**, which breaks its refresh tokens. Revocation through
  `https://oauth2.googleapis.com/revoke` removes **every scope the user granted to the whole Cloud
  project**, for all its clients — relevant if the Drive connection's client shares a project with
  the sign-in client. A dead token surfaces as `invalid_grant` on refresh.

## 1. Scope classification and verification burden

### Classification

- Google's Drive scope page lists three **non-sensitive** scopes, "recommended for most use cases":
  `drive.appdata`/`drive.appfolder`, `drive.install`, and `drive.file`. `drive.file` is described
  as "Create new Drive files, or modify existing files, that you open with an app or that the user
  shares with an app while using the Google Picker API or the app's file picker."
  <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>
- **Sensitive:** only `drive.apps.readonly` ("View apps authorized to access your Drive").
  <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>
- **Restricted:** `drive`, `drive.readonly`, `drive.activity`, `drive.activity.readonly`,
  `drive.meet.readonly`, `drive.metadata`, `drive.metadata.readonly`, `drive.scripts`.
  <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>; the same Drive list
  appears on Google's restricted-scopes help page:
  <https://support.google.com/cloud/answer/13464325>
- The general OAuth scope reference describes `drive.file` as "See, edit, create, and delete only
  the specific Google Drive files you use with this app". It also lists
  `drive.photos.readonly` ("View the photos, videos and albums in your Google Photos"), which the
  Drive scope page does not classify.
  <https://developers.google.com/identity/protocols/oauth2/scopes>
- There is no separate "picker" scope. The Picker guide says: "To obtain the token for any of these
  views, use the `https://www.googleapis.com/auth/drive.file` scope."
  <https://developers.google.com/workspace/drive/picker/guides/web-picker>
- For Workspace customers, the Admin console's "Drive & Docs high-risk OAuth scopes" list includes
  `drive`, `drive.readonly`, `drive.metadata(.readonly)` and others, but **not** `drive.file`.
  <https://support.google.com/a/answer/7281227>

### What each class requires (External app, In production)

- Scope-category table: non-sensitive → basic app verification only; sensitive → basic plus
  additional verification; restricted → basic, additional, **and security assessment**.
  <https://developers.google.com/workspace/guides/configure-oauth-consent>
- "If you store restricted scope data on servers (or transmit), then you must go through a security
  assessment." <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>
- The assessment is annual, uses the App Defense Alliance's Cloud App Security Assessment (CASA)
  framework, assigns assurance level AL1 or AL2, and results in a "Letter of Validation".
  Restricted-scope apps also re-verify annually.
  <https://support.google.com/cloud/answer/13465431>;
  <https://support.google.com/cloud/answer/13463073>
- Only some app types may use restricted Drive scopes at all: backup and sync; productivity and
  education; reporting and security.
  <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>
- Sensitive/restricted verification also requires a demonstration video of the OAuth flow, limited
  use of data, a justification of why narrower scopes would not work, and (restricted only) the
  security assessment. <https://support.google.com/cloud/answer/13464321>
- For non-sensitive scopes: "If your app utilizes only non-sensitive scopes, it is not mandatory
  for your app to complete the app verification process. However, if you want your app to display
  an app name and logo on the OAuth consent screen, you will need to complete a lighter-weight
  verification process known as 'brand-verification'."
  <https://support.google.com/cloud/answer/13463073>
- Brand verification applies when the app is External + Published **and** you want a logo or
  display name on the consent screen; it requires a homepage and privacy policy on a verified
  domain, among other things. Automated verification typically takes minutes; manual review
  usually 2–3 business days.
  <https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification>;
  <https://support.google.com/cloud/answer/13464321>
- **Tension between sources:** the Drive scope page says non-sensitive scopes "only require basic
  OAuth App Verification", while the Help Center says verification is "not mandatory" for
  non-sensitive-only apps (brand verification only if you want name and logo shown). The Help
  Center and the app-state overview are the more specific statements.
  <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>;
  <https://support.google.com/cloud/answer/13463073>

### Unverified-app screen and the 100-user cap

- An unverified app shows the "Unverified apps" warning only "if your project's OAuth clients
  request authorization of scopes considered sensitive or restricted". The user cap "limits the
  number of users that can grant permission to your app when requesting unapproved sensitive or
  restricted scopes"; it is 100 new users over the project's lifetime and cannot be reset.
  <https://support.google.com/cloud/answer/15549945>
- The app-state overview's table: Published + External + Unverified → name and logo not displayed;
  "for apps requesting sensitive or restricted scopes, unverified app warnings (Danger UI) will be
  displayed to users, and a hard cap of 100 total users applies."
  <https://developers.google.com/identity/protocols/oauth2/production-readiness/overview>
- "Personal Use apps: If the app is for your personal use (fewer than 100 users), you and your
  limited number of users can continue using the app without going through verification (users
  will be allowed to click through 'unverified app' warning screens during sign-in)."
  <https://support.google.com/cloud/answer/13464323>
- **Inference:** with `drive.file` only, neither the warning nor the cap applies. With a restricted
  scope and a single consenting association account, the cap would never be reached, but Google's
  policy still requires verification (and CASA) for a public production app; the "personal use"
  exemption is worded for the developer's own use, and whether a resident association's site fits
  it is not something the page decides.

### Internal user type

- Internal apps: "The app is only used by people in your Google Workspace or Cloud Identity
  organization. The project must be owned by the organization, and its OAuth Consent Screen must
  be configured for internal use." Internal apps are not subject to the unverified-app screen or
  the 100-user cap. <https://support.google.com/cloud/answer/13464323>
- "Projects associated with a Google Cloud Organization can configure Internal users"; sign-in by
  anyone outside the organization gets `org_internal`. Restricted Drive scopes for Internal apps
  "might require additional configuration by your organization's administrators."
  <https://support.google.com/cloud/answer/15549945>
- "An organization resource is available for Google Workspace and Cloud Identity customers."
  <https://cloud.google.com/resource-manager/docs/creating-managing-organization>
- **Inference:** a consumer `@gmail.com` account has no organization, so Internal is not available
  if the association account is plain Gmail. No page says "Gmail cannot use Internal" in those
  words.

### Testing publishing status

- Testing: up to 100 listed test users; "Authorizations by a test user will expire seven days from
  the time of consent. If your OAuth client requests an offline access type and receives a refresh
  token, that token will also expire." The only exception is apps requesting a subset of name,
  email, and profile (`openid`, `userinfo.email`, `userinfo.profile`).
  <https://support.google.com/cloud/answer/15549945>
- Publishing status is a **project** setting ("Projects configured with a publishing status of…").
  <https://support.google.com/cloud/answer/15549945>

## 2. What `drive.file` authorizes

- Scope table text: "Create new Drive files, or modify existing files, that you open with an app or
  that the user shares with an app while using the Google Picker API or the app's file picker."
  <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>
- "The `drive.file` OAuth scope lets users choose which files they want to share with your app."
  It "works with all Drive API REST Resources which means you can use it the same way you use
  broader OAuth scopes." <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>
- The three documented ways a file becomes accessible:
  1. **Created by the app** (scope text "Create new Drive files"; `isAppAuthorized` = "Whether the
     file was created or opened by the requesting app").
     <https://developers.google.com/workspace/drive/api/reference/rest/v3/files>
  2. **Opened with the app from the Drive UI** ("Open with"), which needs a configured Drive UI
     integration and the `drive.install` scope.
     <https://developers.google.com/workspace/drive/api/guides/enable-sdk>;
     <https://developers.google.com/workspace/drive/api/guides/integrate-open>
  3. **Shared with the app through the Google Picker** (or "the app's file picker").
     <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>
- **A pasted URL or file ID alone does not grant access.** The error for an unauthorized file is
  `appNotAuthorizedToFile` (403): "This error occurs when your app isn't on the ACL for the file",
  with message "The user has not granted the app {appId} {verb} access to the file {fileId}." The
  documented fixes are to open the Picker, to have the user use "Open with", or to check
  `isAppAuthorized`. <https://developers.google.com/workspace/drive/api/guides/handle-errors>
- Google does not document any API call that turns a known file ID into a `drive.file` grant
  without user interaction. A known ID can, however, **narrow** the Picker: `DocsView.setFileIds`
  "Sets the file IDs included in the view"
  (<https://developers.google.com/workspace/drive/picker/reference/picker.docsview.setfileids>), and
  the OAuth-redirect Picker accepts `file_ids=` "to filter the search results"
  (<https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker>).
- `drive.file` supports `files.get`, `files.export`, and `files.download`.
  <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get>;
  <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export>;
  <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/download>

## 3. Google Picker with `drive.file`

### Web Picker (JavaScript)

- Setup: enable the **Google Picker API** in the Cloud project; create an **API key**; create an
  OAuth client ID. If the API key is restricted to websites, both the app's domain (e.g.
  `https://example.com/*`) and `https://docs.google.com/*` must be allowed, because the Picker
  renders in an iframe on `docs.google.com`. If restricted by API, allow the Picker API "(and the
  Drive API if your app makes direct Drive API calls)".
  <https://developers.google.com/workspace/drive/picker/guides/web-picker>
- "Your app must send an OAuth 2.0 access token with views that access private user data when
  creating a Picker object." The sample obtains it in the browser with the Google Identity
  Services token client (`google.accounts.oauth2.initTokenClient`) and passes it via
  `setOAuthToken`. <https://developers.google.com/workspace/drive/picker/guides/web-picker>
- `PickerBuilder` "takes a View, an OAuth 2.0 token, a developer key, and a callback". "Use the
  `PickerBuilder.setAppId` method to set the Drive App ID using the Cloud project number to allow
  the app to access the user's files."
  <https://developers.google.com/workspace/drive/picker/guides/web-picker>
- `setAppId`: "Sets the Id of the application needing to access the user's files via the Drive
  API. This is required for the `https://www.googleapis.com/auth/drive.file` scope." Parameter:
  "The Cloud project number."
  <https://developers.google.com/workspace/drive/picker/reference/picker.pickerbuilder.setappid>
- `setDeveloperKey`: "Sets the Browser API key obtained from Google Developers Console."
  <https://developers.google.com/workspace/drive/picker/reference/picker.pickerbuilder.setdeveloperkey>
- The callback returns the picked documents' metadata (ID, URL, MIME type, name, `sizeBytes`,
  `resourceKey`). <https://developers.google.com/workspace/drive/picker/guides/web-picker>;
  <https://developers.google.com/workspace/drive/picker/guides/web-component>;
  <https://developers.google.com/workspace/drive/picker/reference/picker.documentobject.resourcekey>
- With scopes other than `drive`/`drive.readonly`, Google recommends
  `DocsView.setMode(DocsViewMode.LIST)` "as the user hasn't granted access to thumbnails."
  <https://developers.google.com/workspace/drive/picker/guides/web-picker>
- Shared drives: `Feature.SUPPORT_DRIVES` — "WARNING: Shared drive items are now included by
  default."
  <https://developers.google.com/workspace/drive/picker/reference/picker.feature.support_drives>
- "Note that the user must be signed in while accessing the Google Picker."
  <https://developers.google.com/workspace/drive/picker/guides/overview>

### Persistence of per-file grants for later server use

- The grant is tied to the **app identified by the Cloud project number**: `setAppId` takes the
  project number, and the denial message names "the app {appId}".
  <https://developers.google.com/workspace/drive/picker/reference/picker.pickerbuilder.setappid>;
  <https://developers.google.com/workspace/drive/api/guides/handle-errors>
- "For apps to get authorization to files previously granted to them … obtain an OAuth 2.0 token
  with the `drive.file`, `drive`, or `drive.readonly` scope … Pass the OAuth 2.0 token to the Drive
  API to read and modify files in which the user previously granted access."
  <https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker>
- Authorizations combine per project: "The combined authorization includes all scopes that the user
  granted to the API project even if the grants were requested from different clients." A refresh
  token for the combined authorization yields an access token usable for all of them.
  <https://developers.google.com/identity/protocols/oauth2/web-server>
- **Inference:** a server holding a refresh token (with `drive.file`) from a client in the same
  Cloud project as the Picker's `appId`, for the same Google account, can later export a file that
  account picked. No single page states "a browser Picker grant is usable by a server refresh
  token"; this combines the three statements above. Whether per-file grants survive a revocation
  and fresh consent is not documented (see Open list).

### Newer Picker variants

- **Picker web component** `@googleworkspace/drive-picker-element` (plus a React wrapper):
  a `<drive-picker>` element that wraps the API loading and OAuth; attributes include `app-id`,
  `client-id`, `origin`, and `prompt`; events `picker-picked`, `picker-canceled`, `picker-error`.
  <https://developers.google.com/workspace/drive/picker/guides/web-component>
- **OAuth-redirect Picker ("desktop and mobile")**: append `prompt=consent` and
  `trigger_onepick=true` to the authorization URL; optional `allow_multiple`, `mimetypes`,
  `file_ids`, `allow_folder_selection`. The sample uses `response_type=code` and
  `access_type=offline`. The redirect carries `picked_file_ids`, `code`, and `scope`. "Only the
  `drive.file` scope is permitted for these apps and it can't be combined with any other scope."
  <https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker>
- The overview compares "Web apps" (client-side JS, token via `setOAuthToken`) against "Desktop &
  mobile apps" (OAuth URL parameters and redirects; system browser; cannot be embedded in a
  webview). <https://developers.google.com/workspace/drive/picker/guides/overview>
- **Ambiguity:** the OAuth-redirect page includes an "Authorize credentials for your web app"
  step and says "Select a `redirect_uri` that works with your application type and OAuth setup.
  The Google Picker imposes no additional restrictions", yet its title and the overview frame it as
  the desktop/mobile variant. Google does not state whether a **web application** (server-side)
  client is supported with `trigger_onepick`.
  <https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker>;
  <https://developers.google.com/workspace/drive/picker/guides/overview>
- Android uses `AuthorizationRequest` with the `PICKER_OAUTH_TRIGGER` resource parameter (listed
  for completeness; not relevant to a web app).
  <https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker>

## 4. Export and download

### `files.export`

- "Exports a Google Workspace document to the requested MIME type and returns exported byte
  content… Note that the exported content is limited to 10 MB." Scopes accepted: `drive`,
  `drive.file`, `drive.meet.readonly`, `drive.readonly`. It takes `fileId` and `mimeType` only; it
  has no `supportsAllDrives` parameter.
  <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export>
- "Partial downloads are not supported while exporting Google Workspace documents."
  <https://developers.google.com/workspace/drive/api/guides/manage-downloads>
- Export MIME types (Docs): DOCX, ODT, RTF, **PDF `application/pdf`**, plain text, HTML, zipped
  HTML, EPUB, **Markdown `text/markdown`**. Sheets: **XLSX
  `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`**, ODS, PDF, zipped HTML,
  CSV and TSV ("first-sheet only"). The live list per user is available from `about.get` with
  `fields=exportFormats`.
  <https://developers.google.com/workspace/drive/api/guides/ref-export-formats>
- The error guide does not document a specific error reason for exceeding the 10 MB export limit.
  <https://developers.google.com/workspace/drive/api/guides/handle-errors>

### `files.download` (long-running operation)

- Google lists "Google Workspace document content using the `files.download` method using
  long-running operations" as an export action alongside `files.export`. It takes an optional
  `mimeType` (export formats) and `revisionId` (blob files, Docs, and Sheets only); it returns an
  `Operation` that is polled via `operations.get` until `done=true`, then yields a download URI.
  "Operations are valid for 24 hours from the time of creation." Scopes: `drive`, `drive.file`,
  `drive.readonly`. <https://developers.google.com/workspace/drive/api/guides/manage-downloads>;
  <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/download>;
  <https://developers.google.com/workspace/drive/api/guides/long-running-operations>
- "Download links generated for Google Docs or Sheets initially return a redirect." Both the
  starting request and the final download-URI request "should both use resource keys".
  <https://developers.google.com/workspace/drive/api/guides/long-running-operations>
- **Silent:** neither page states a size limit for `files.download`, and neither says it is a way
  around the 10 MB export cap.

### `exportLinks`

- `exportLinks`: "Output only. Links for exporting Docs Editors files to specific formats."
  <https://developers.google.com/workspace/drive/api/reference/rest/v3/files>
- The downloads guide presents them as the way to export "within a browser … You can either
  redirect a user to a URL, or offer it as a clickable link." URLs in `exportLinks` include the
  resource key where one applies.
  <https://developers.google.com/workspace/drive/api/guides/manage-downloads>;
  <https://developers.google.com/workspace/drive/api/guides/resource-keys>
- **Silent:** Google documents no size limit for `exportLinks`, does not document fetching them
  server-side with a bearer token, and does not present them as a way past the 10 MB cap. Treat
  any such use as undocumented behavior.

### Blob files (uploaded PDF, DOCX, …)

- Download with `files.get` and `alt=media`; "Downloading content with alt=media only works if the
  file is stored in Drive. To download Google Docs, Sheets, and Slides use `files.export`
  instead." <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get>
- Using `alt=media` on a Docs Editors file returns `fileNotDownloadable` ("Only files with binary
  content can be downloaded. Use Export with Docs Editors files.").
  <https://developers.google.com/workspace/drive/api/guides/handle-errors>
- Byte-range (`Range` header) partial downloads are supported for blobs.
  <https://developers.google.com/workspace/drive/api/guides/manage-downloads>
- Check `capabilities.canDownload` first; owners/organizers can restrict downloading.
  <https://developers.google.com/workspace/drive/api/guides/manage-downloads>
- `acknowledgeAbuse`: "Whether the user is acknowledging the risk of downloading known malware or
  other abusive files. This is only applicable when the alt parameter is set to media and the user
  is the owner of the file or an organizer of the shared drive in which the file resides." Files
  flagged as abusive "are only downloadable by the file owner", and "Your application should
  interactively warn the user before using this query parameter."
  <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get>;
  <https://developers.google.com/workspace/drive/api/guides/manage-downloads>

### Shared drives, shortcuts, and resource keys

- `supportsAllDrives=true` must be sent on `files.get`, `files.list`, and other listed methods for
  the app to handle shared-drive files; `files.export` is not on that list.
  <https://developers.google.com/workspace/drive/api/guides/enable-shareddrives>
- A shortcut has MIME type `application/vnd.google-apps.shortcut`, with the target in
  `shortcutDetails.targetId` / `targetMimeType`; `targetMimeType` "can become stale". Shortcuts
  have no `size`. <https://developers.google.com/workspace/drive/api/guides/shortcuts>;
  <https://developers.google.com/workspace/drive/api/reference/rest/v3/files>
- Link-shared files may need the `X-Goog-Drive-Resource-Keys` header (`fileId/resourceKey`
  pairs); a shortcut exposes its target's key as `shortcutDetails.targetResourceKey`.
  <https://developers.google.com/workspace/drive/api/guides/resource-keys>
- "All apps, including apps opening files from shortcuts and third-party shortcuts, should call the
  `files.get` method to check the user's permissions for a document."
  <https://developers.google.com/workspace/drive/api/guides/integrate-open>

### Quota

- Drive API limits changed on 2026-05-01: projects created on or after that date get the new
  quotas (1,000,000 units/minute/project; 325,000 units/minute/user/project), plus a daily
  billing threshold of 400,000,000 units per project "before charges apply", with billing details
  promised later in 2026 with 90 days' notice.
  <https://developers.google.com/workspace/drive/api/guides/limits>

## 5. Refresh-token lifetime and revocation

### Why a refresh token stops working

Google's list ("You must write your code to anticipate the possibility that a granted refresh
token might no longer work"):
<https://developers.google.com/identity/protocols/oauth2>

- "The user has revoked your app's access."
- "The refresh token has not been used for six months."
- "The user changed passwords and the refresh token contains Gmail scopes." (Drive-only tokens are
  not in this case.)
- "The user account has exceeded a maximum number of granted (live) refresh tokens."
- "The user granted time-based access to your app and the access expired."
- An admin set a requested service to Restricted (`admin_policy_enforced`).
- For Google Cloud Platform APIs, an admin session length was exceeded.
- External + Testing → refresh token "expiring in 7 days", unless only identity scopes are
  requested.

### Limits

- "There is currently a limit of 100 refresh tokens per Google Account per OAuth 2.0 client ID. If
  the limit is reached, creating a new refresh token automatically invalidates the oldest refresh
  token without warning." There is also a larger per-account limit across all clients.
  <https://developers.google.com/identity/protocols/oauth2>
- "OAuth 2.0 clients that have been inactive for six months are automatically deleted." Tokens
  for a deleted client fail; a warning email is sent 30 days before; deleted clients are typically
  restorable for at least 30 days. A client counts as used if it made any token request in the
  window. <https://support.google.com/cloud/answer/15549257>

### Time-based access and session control

- Time-based access "allows a user to grant your app access to their data for a limited duration…
  available in select Google products during the consent flow". The token response then carries
  `refresh_token_expires_in`. Google's example is the Data Portability API; it does not list
  whether Drive consent offers it. <https://developers.google.com/identity/protocols/oauth2/web-server>
- Google Cloud session control (Workspace admin, 1–24 hours) applies to the Cloud console, gcloud,
  and apps "that require user authorization for Google Cloud scopes"; on expiry calls fail with
  `invalid_grant`, distinguishable by `error_subtype` (e.g. `invalid_rapt`).
  <https://developers.google.com/identity/protocols/oauth2>;
  <https://support.google.com/a/answer/9368756>
- The same Google section adds: "you must not use, or encourage the use of, user credentials for
  server-to-server deployment", in the context of session-control policies. It appears under the
  Cloud-scope session-control heading; Google does not repeat it for Drive scopes.
  <https://developers.google.com/identity/protocols/oauth2>
- Workspace web session length: "Session lengths aren't enforced on OAuth-authenticated apps or
  ChromeOS." <https://support.google.com/a/answer/7576830>
- Workspace admins can always block any OAuth app, and can mark an app Trusted, which for their
  organization lifts the 100-test-user cap and the Testing 7-day refresh-token expiry. Applies only
  if the account is in Workspace.
  <https://developers.google.com/identity/protocols/oauth2/production-readiness/overview>

### Detecting a dead token

- Token endpoint `invalid_grant`: "When refreshing an access token or using incremental
  authorization, the token may have expired or has been invalidated. Authenticate the user again
  and ask for user consent to obtain new tokens… Otherwise, the user account may have been deleted
  or disabled." A deleted client returns `deleted_client`.
  <https://developers.google.com/identity/protocols/oauth2/web-server>
- Google recommends integrating with the Cross-Account Protection (RISC) service to be notified of
  events such as `token-revoked`, `sessions-revoked`, and `account-disabled`.
  <https://developers.google.com/identity/protocols/oauth2/web-server>;
  <https://developers.google.com/identity/protocols/oauth2/resources/best-practices>

### Obtaining and revoking the token

- A refresh token is returned only when the authorization request sets `access_type=offline`;
  "Refresh tokens are valid until the user revokes access or the refresh token expires." Store it
  in "a secure, long-lived location"; losing it means repeating consent.
  <https://developers.google.com/identity/protocols/oauth2/web-server>
- Users revoke from their Google Account's linked-apps page ("Remove access").
  <https://support.google.com/accounts/answer/13533235>
- Programmatic revocation: POST to `https://oauth2.googleapis.com/revoke` with the token (access or
  refresh; revoking an access token also revokes its refresh token). 200 on success, 400 with an
  error code otherwise; "it might take some time before the revocation has full effect."
  <https://developers.google.com/identity/protocols/oauth2/web-server>
- **Project-wide effect:** "Revocation removes all OAuth 2.0 scopes previously granted to a
  project, invalidating any issued access or refresh tokens for all clients registered under that
  project." <https://developers.google.com/identity/protocols/oauth2/web-server>
- Server-side token storage: encrypt at rest; revoke and delete tokens when no longer needed.
  <https://developers.google.com/identity/protocols/oauth2/resources/best-practices>
- Google now documents optional DPoP-bound refresh tokens for the web-server flow.
  <https://developers.google.com/identity/protocols/oauth2/web-server>

## Open / unverified

1. **Picker grant → server export.** No single Google sentence says a per-file grant made in the
   browser Picker is usable by a server holding a refresh token for another client in the same
   project. The inference in §3 is well supported, but should be confirmed with a test before the
   spec relies on it.
2. **Whether per-file `drive.file` grants survive revocation.** Google says revocation removes all
   scopes granted to the project; it does not say whether the per-file grants come back if the
   same account re-consents to `drive.file`, or must be re-picked.
3. **`trigger_onepick` with a web-server OAuth client.** Documented for desktop and mobile; the
   page includes a web-app credentials step but never says a web-server redirect flow is
   supported.
4. **Picker account mismatch.** The web Picker needs a token for the account whose Drive is shown,
   and "the user must be signed in". Google does not say what happens when the browser's signed-in
   Google account (an individual board admin) differs from the account the token belongs to (the
   association).
5. **Size limits beyond `files.export`.** No documented limit, or documented guarantee, for
   `files.download` LRO exports or for `exportLinks`; no documented error reason for the 10 MB
   export limit.
6. **Shortcuts under `drive.file`.** Not documented whether picking a shortcut grants access to
   its target.
7. **Time-based access for Drive.** Not documented whether the Drive consent screen offers
   time-limited grants to a `drive.file` app.
8. **Personal-use exemption.** Whether a resident association's site can claim "personal use"
   (fewer than 100 users) is not decided by the Help Center text; it only matters if a restricted
   scope were chosen.
9. **Non-sensitive verification wording.** The Drive scope page ("only require basic OAuth App
   Verification") and the Help Center ("not mandatory"; brand verification only for name and
   logo) differ in emphasis.
10. **Drive API billing.** Google says full billing details for usage above the daily threshold
    arrive later in 2026.

## Sources

All read 2026-09-30. "Updated" is the page's own "Last updated" stamp where shown; Help Center
pages show none.

| Source                                                                                                                                        | Updated    |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| [Choose Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)                                  | 2026-09-03 |
| [Overview of the Google Picker](https://developers.google.com/workspace/drive/picker/guides/overview)                                         | 2026-09-14 |
| [Integrate the Google Picker into web apps](https://developers.google.com/workspace/drive/picker/guides/web-picker)                           | 2026-09-03 |
| [Integrate the Google Picker into desktop and mobile apps](https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker) | 2026-09-29 |
| [Use the Google Picker web component](https://developers.google.com/workspace/drive/picker/guides/web-component)                              | 2026-09-03 |
| [PickerBuilder.setAppId](https://developers.google.com/workspace/drive/picker/reference/picker.pickerbuilder.setappid)                        | 2025-06-20 |
| [PickerBuilder.setDeveloperKey](https://developers.google.com/workspace/drive/picker/reference/picker.pickerbuilder.setdeveloperkey)          | 2025-06-20 |
| [DocsView.setFileIds](https://developers.google.com/workspace/drive/picker/reference/picker.docsview.setfileids)                              | 2025-06-20 |
| [Feature.SUPPORT_DRIVES](https://developers.google.com/workspace/drive/picker/reference/picker.feature.support_drives)                        | 2025-03-26 |
| [DocumentObject.resourceKey](https://developers.google.com/workspace/drive/picker/reference/picker.documentobject.resourcekey)                | 2025-03-26 |
| [Download and export files](https://developers.google.com/workspace/drive/api/guides/manage-downloads)                                        | 2026-09-03 |
| [Manage long-running operations](https://developers.google.com/workspace/drive/api/guides/long-running-operations)                            | 2026-09-03 |
| [Export MIME types for Google Workspace documents](https://developers.google.com/workspace/drive/api/guides/ref-export-formats)               | 2026-09-03 |
| [files.export](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export)                                              | 2025-08-26 |
| [files.download](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/download)                                          | 2025-08-26 |
| [files.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get)                                                    | 2026-03-20 |
| [files resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)                                                   | 2026-07-14 |
| [Resolve errors](https://developers.google.com/workspace/drive/api/guides/handle-errors)                                                      | 2026-09-03 |
| [Implement shared drive support](https://developers.google.com/workspace/drive/api/guides/enable-shareddrives)                                | 2026-09-03 |
| [Create a shortcut to a Drive file](https://developers.google.com/workspace/drive/api/guides/shortcuts)                                       | 2026-09-03 |
| [Access link-shared files using resource keys](https://developers.google.com/workspace/drive/api/guides/resource-keys)                        | 2026-09-03 |
| [Integrate with Drive UI's "Open with" context menu](https://developers.google.com/workspace/drive/api/guides/integrate-open)                 | 2026-09-03 |
| [Configure a Drive UI integration](https://developers.google.com/workspace/drive/api/guides/enable-sdk)                                       | 2026-09-03 |
| [Drive API usage limits](https://developers.google.com/workspace/drive/api/guides/limits)                                                     | 2026-09-11 |
| [Configure the OAuth consent screen and choose scopes](https://developers.google.com/workspace/guides/configure-oauth-consent)                | 2026-09-03 |
| [OAuth 2.0 Scopes for Google APIs](https://developers.google.com/identity/protocols/oauth2/scopes)                                            | 2026-09-14 |
| [Using OAuth 2.0 to Access Google APIs](https://developers.google.com/identity/protocols/oauth2)                                              | 2026-05-26 |
| [Using OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server)                             | 2026-09-14 |
| [OAuth 2.0 best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices)                                  | 2026-05-20 |
| [OAuth app state overview](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)                             | 2026-05-22 |
| [Submit for brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification)              | 2026-08-19 |
| [Creating and managing organization resources](https://cloud.google.com/resource-manager/docs/creating-managing-organization)                 | 2026-09-24 |
| [OAuth App Verification Help Center](https://support.google.com/cloud/answer/13463073)                                                        | —          |
| [Verification requirements](https://support.google.com/cloud/answer/13464321)                                                                 | —          |
| [When is verification not needed](https://support.google.com/cloud/answer/13464323)                                                           | —          |
| [Security Assessment](https://support.google.com/cloud/answer/13465431)                                                                       | —          |
| [Restricted Scopes](https://support.google.com/cloud/answer/13464325)                                                                         | —          |
| [Manage App Audience](https://support.google.com/cloud/answer/15549945)                                                                       | —          |
| [Manage OAuth Clients](https://support.google.com/cloud/answer/15549257)                                                                      | —          |
| [Control which apps access Google Workspace data](https://support.google.com/a/answer/7281227)                                                | —          |
| [Set session length for Google Cloud services](https://support.google.com/a/answer/9368756)                                                   | —          |
| [Set session length for Google services](https://support.google.com/a/answer/7576830)                                                         | —          |
| [Manage links between your Google Account & apps from other developers](https://support.google.com/accounts/answer/13533235)                  | —          |
