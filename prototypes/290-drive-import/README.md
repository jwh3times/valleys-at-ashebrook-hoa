# PROTOTYPE — #290 Google Drive import (throwaway)

Throwaway code that lives on the `prototype/290-drive-import` branch only. Never merge it to `main`.
It is a plain Node server with no dependencies, it runs on your machine against a **throwaway test
Google account**, and it touches nothing in production.

The code checks three things the #290 design relies on, which Google's docs don't state:

| #   | Question                                                                                                                                                              | Decides                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Q1  | Can the **server** export a file chosen in the browser's Google Picker (`drive.file`), using a token it mints from its stored refresh token rather than the Picker's? | Whether the "pick in the browser, export on the server" design works at all.         |
| Q2  | Does the Picker work when the browser is also signed into a **different** Google account, such as the board admin's own?                                              | The board admin's experience and any instructions they need.                         |
| Q3  | Do repeat exports of an **unchanged** Doc, Sheet or Slides deck give different bytes?                                                                                 | Whether the duplicate rule for "same Drive file and `modifiedTime`" (Q17) is needed. |

The page also runs two side checks:

- **Negative control:** a file ID that was never picked should be unreadable under `drive.file`.
- **Disconnect and reconnect:** whether files picked before a disconnect are still readable after reconnecting.

## Prerequisites

- The setup on ops #41 is done, including the 1Password item `Google Drive Import Prototype` with its four fields.
- The 1Password CLI is signed in (`op whoami`).

## Run

From the repository root:

```bash
npm run prototype:drive
```

Then open http://localhost:8790. `op run` injects the four values from `prototype.env`, which holds
secret references only. The server never prints, logs or renders a token. All state is in memory, so
stopping the server wipes it.

## Steps

The page walks through these in order. Each result appears under **Results**.

1. **Connect.** Choose the throwaway test account on Google's screen.
2. **Negative control.** Paste the ID of a test file you haven't picked yet. Expect `404 notFound` or `appNotAuthorizedToFile`.
3. **Picker, scenario A.** Use a browser profile signed into the test account only. Pick the Doc, Sheet, Slides and PDF, and anything else you want to see refused. Record what the Picker showed.
4. **Export.** The server mints a **new** token and exports everything picked. This answers Q1.
5. **Repeat-export comparison.** Each Google file is exported three times and the copies compared. This answers Q3.
6. **Picker, scenarios B and C.** Repeat the Picker in a browser also signed into your own Google account, then in a browser signed into your own account only. Export after each. If the Picker shows your own files, exporting them fails, which is the signal for Q2.
7. **Optional: disconnect and reconnect** as the same account, then export again without re-picking.
8. Open **Redacted Markdown report**. It labels files instead of naming them and omits IDs and email addresses. Paste it into the agent session.
