# PROTOTYPE results — #290 Google Drive import (run 2026-10-17)

Throwaway. The verdict is recorded on public #290. This file keeps the run's evidence beside the code
that produced it.

## Setup

- **Account and browser.** One throwaway test Google account, run from Firefox 158 on Linux.
- **Cloud project.** The OAuth client and Picker key live in the **same Cloud project as resident
  Google sign-in**, with their own client. The project is In production, with `drive.file` added to
  its consent screen.
- **Files.** The sample set is one Doc, one Sheet, one Slides deck, one uploaded PDF and one uploaded
  JPG. The optional over-10 MB Doc was skipped: Docs re-compresses photos on PDF export, so one large
  photo stayed far under the cap.

## Verdict

| #   | Question                                                         | Answer                                                                                                                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Can the server export Picker-selected files with its own token?  | **Yes.** A token minted from the stored refresh token (not the Picker's) exported the Doc and Slides as PDF and the Sheet as XLSX, and downloaded the PDF. The JPG was refused by the allowlist, as designed. An unpicked file ID returned `404 notFound`.                                        |
| Q2  | Does the Picker work with another Google account signed in?     | **It follows the connected account, never the admin's own.** B, signed into both accounts: it showed the test account's files at once. C, signed into the admin's own account only: it showed "sign in to access this content", and worked once the test account was also signed in. |
| Q3  | Are repeat exports of an unchanged file byte-identical?          | **Not for Sheets.** Docs → PDF and Slides → PDF were byte-identical across three exports. Sheets → XLSX differed every time: same size, 22 bytes differing from byte 10, which is consistent with ZIP entry timestamps. `modifiedTime` was unchanged throughout.                                      |

## Side findings

- **Granular consent can drop `drive.file`.** On the first two connects the operator left Google's
  Drive checkbox unticked. Google returned only `openid` and `userinfo.email`, the connection still
  looked successful, and every Drive call failed with `403 insufficientPermissions`.
- **File grants survive disconnect.** Connection 4 came after a disconnect, which revoked the token
  at Google, and a reconnect as the same account. It exported all previously picked files without a
  new pick.
- **Picker key and website restriction.** With the key's Application restriction set to Websites
  (`http://localhost:8790/*`), the Picker refused it in Firefox with "The API developer key is
  invalid." With the restriction set to None, it worked. Not yet compared in Chrome.
- **Private windows.** A Firefox private window needed the connected account signed in before the
  Picker would load.

## Redacted report as pasted by the operator

- Q1: negative control `403 insufficientPermissions` (connection without `drive.file`), then `404 notFound`.
- Q1: connections 3 and 4 — presentation → pdf 636280 B, spreadsheet → xlsx 5109 B, document → pdf
  23893 B, pdf download 55604 B, all **OK**; jpeg **refused (by design)**.
- Q2: runs A, B and C each logged `picker loaded` and `picked` (C only after signing in as the test account).
- Q3: presentation pdf **byte-identical** ×3; document pdf **byte-identical** ×3; spreadsheet xlsx
  **different** ×3 (sizes equal, first difference at byte 10, 22 differing bytes); `modifiedTime`
  unchanged for all.
- Connections made: 4. Access tokens minted: 16.
