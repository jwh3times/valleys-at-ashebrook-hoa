---
# GENERATED — do not edit. Source: .agents/skills/handoff/SKILL.md
name: handoff
description: Write a handoff document to Proton Drive, register it in the handoff map, and close out the session so the other computer can resume with /lets-go.
argument-hint: 'What will the next session be used for?'
disable-model-invocation: true
---

# Handoff

Hands this session to the next one — usually on the user's other computer (they switch between Windows and Fedora). The document travels through Proton Drive, in `<Proton Drive>/<account>/My files/Documents/Handoffs/`. `handoff_map.json` there records the one **active** handoff per repository; `/lets-go` on the other machine reads it, resumes from the document, and clears the entry.

The map and the unmerged-work audit go through one helper, run from the repository root on either OS:

| Command                                                                | Does                                                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `node .agents/skills/handoff/scripts/handoff-map.mjs audit . private`  | Fetches, then lists uncommitted files, branches not in origin's default branch, and stashes.        |
| `node .agents/skills/handoff/scripts/handoff-map.mjs get`              | Prints this repository's `dir`, map `key`, and active `file` (`null` when none).                    |
| `node .agents/skills/handoff/scripts/handoff-map.mjs set <file\|null>` | Re-reads the map, sets this repository's entry, stamps `Last_Updated`, preserves every other entry. |

The helper finds the folder from `HANDOFFS_DIR`, else by searching the home directory for a Proton folder holding `handoff_map.json`. When it cannot, stop and ask the user for the folder path, and suggest exporting `HANDOFFS_DIR` on that machine. The map is shared by every repository the user works in, so edit it only through `set`.

## Transport

Decide once, before step 1, how files reach Proton Drive on this machine:

- **Desktop client** (Windows): the Proton Drive client syncs the folder itself. Skip every step marked _(CLI mirror only)_.
- **CLI mirror** (Fedora): `command -v proton-drive` succeeds and no synced Proton folder exists. Proton ships no Linux sync client, so `HANDOFFS_DIR` names a local mirror folder and every transfer is explicit through `proton-drive filesystem download` / `upload` against the cloud folder `/my-files/Documents/Handoffs`. `HANDOFFS_DIR` must be exported; when it is not, stop and ask the user to export it (for example `~/Documents/Handoffs`) in a shell profile. `You need to login first` means the CLI session lapsed: stop and ask the user to run `proton-drive auth login` themselves.

Pull only what is read and push only what was written. Download with `-f remove` so a stale local copy is replaced by the cloud copy; upload with `-f create-new-revision -t` so the cloud keeps history and never prompts. A prompt would hang the session, so never run either command without its strategy flag.

## Steps

### 1. Audit unmerged work — alert now

Run the `audit` command (drop `private` when it is not a Git checkout) and `gh pr list --author @me --state open`.

When the audit ends `status: unmerged` or any PR is open, **alert the user before doing anything else**, in a block headed `⚠ Work not merged to main:` with one line per finding across both repositories and every open PR by URL. Mark the machine-local findings — uncommitted files, a branch `never pushed` or `ahead`, stashes — as **will not reach the other computer**. Then continue: the alert informs, and the user decides whether to interrupt.

### 2. Write the document

**Pull** _(CLI mirror only)_ — refresh the map before reading it:

```bash
mkdir -p "$HANDOFFS_DIR"
proton-drive filesystem download -f remove /my-files/Documents/Handoffs/handoff_map.json "$HANDOFFS_DIR"
```

Complete when the transfer summary lists the map as downloaded.

Run `get` first. A non-null `file` is an earlier handoff for this repository that was never picked up: read it, carry forward whatever is still live, and name it in one line as superseded. Leave that file in place.

Write the document so a fresh agent can continue the work:

- An **Unmerged work** section carrying step 1's findings — branch names and PR URLs are what the next session checks out.
- A **Suggested skills** section naming the skills the next agent should invoke.
- References, not restatements: link specs, plans, ADRs, issues, commits, and diffs by path or URL.
- Redacted: no API keys, passwords, personal data, production identifiers, or resident data. The document leaves both repositories for a personal cloud drive, so private detail stays in the private tracker and is linked by URL.

When the user passed arguments, treat them as what the next session will focus on and tailor the document to it.

### 3. Save it to Proton Drive

Name it `<key>-handoff-<YYYY-MM-DD>.md`, with `key` from `get`. Append `-<short-focus-slug>` when arguments were given or the name is taken; every save is a new file. Write it directly into `dir`, then read it back to confirm it landed whole.

**Push** _(CLI mirror only)_ — the document must reach the cloud before the map names it:

```bash
proton-drive filesystem upload -f create-new-revision -t "$HANDOFFS_DIR/<file-name>" /my-files/Documents/Handoffs
```

Complete when the transfer summary lists the document as uploaded.

### 4. Register it in the map

Run `set <file-name>` and confirm the printed `current` is that file name. Relay any `WARNING possible sync-conflict copy` line to the user: the other computer may be reading a stale map until it is resolved.

**Push** _(CLI mirror only)_ — the updated map goes back to the cloud, or the other machine never learns of the handoff:

```bash
proton-drive filesystem upload -f create-new-revision -t "$HANDOFFS_DIR/handoff_map.json" /my-files/Documents/Handoffs
```

Complete when the transfer summary lists the map as uploaded.

### 5. Run end-session

Invoke the `end-session` skill with the Skill tool, passing `invoked by handoff; document at <full path>` as its arguments. It sweeps memory, issues and the board, the private companion, and the workspace, and writes its own report.

### 6. Re-audit and report

end-session can commit, clean, or remove worktrees, so run step 1's commands again. After end-session's report, add two lines — the handoff's full path and the map entry now pointing at it. When anything is still unmerged, finish with the `⚠ Work not merged to main:` block again, so it is the last thing the user reads.
