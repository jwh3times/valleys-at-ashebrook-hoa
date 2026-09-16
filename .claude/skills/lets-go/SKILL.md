---
# GENERATED — do not edit. Source: .agents/skills/lets-go/SKILL.md
name: lets-go
description: Resume this repository's active handoff from Proton Drive and clear it from the handoff map.
disable-model-invocation: true
---

# Let's go

The receiving half of `/handoff`. The handoff lives in the user's Proton Drive `Handoffs` folder, and `handoff_map.json` there names the active document for each repository. Every map read and write goes through `node .agents/skills/handoff/scripts/handoff-map.mjs`, run from the repository root; `.agents/skills/handoff/SKILL.md` documents its commands, how it finds the folder, and the two transports. Decide the transport first: with the Proton Drive **desktop client** the folder syncs itself and every step marked _(CLI mirror only)_ is skipped; on the **CLI mirror** machine `HANDOFFS_DIR` is a local mirror that these steps pull and push through the `proton-drive` CLI against `/my-files/Documents/Handoffs`.

## Steps

### 1. Find the active handoff

**Pull** _(CLI mirror only)_ — fetch the current map before reading it:

```bash
mkdir -p "$HANDOFFS_DIR"
proton-drive filesystem download -f remove /my-files/Documents/Handoffs/handoff_map.json "$HANDOFFS_DIR"
```

Complete when the transfer summary lists the map as downloaded. `You need to login first` means the CLI session lapsed: stop and ask the user to run `proton-drive auth login`.

Run `get`.

- The folder cannot be located: stop, ask the user for the folder path, and suggest exporting `HANDOFFS_DIR` on this machine.
- `file` is `null`: report `No active handoff for <key>.` and stop. The map is the record; other documents in the folder belong to past or other sessions.
- `exists` is `false`, CLI mirror: the document is not local yet. **Pull** it, then run `get` again:

  ```bash
  proton-drive filesystem download -f remove "/my-files/Documents/Handoffs/<file>" "$HANDOFFS_DIR"
  ```

  When the download reports the file missing, the other machine has not uploaded it. Stop and tell the user the file name, leaving the map untouched so a retry finds it.

- `exists` is `false`, desktop client: the client has not synced the document here yet. Stop and tell the user the file name, leaving the map untouched so a retry after sync still works.

### 2. Read it

Read the whole document at `path`. Relay any `WARNING possible sync-conflict copy` line from `get`.

### 3. Claim it

Run `set null` and confirm the printed `previous` is the file you read. Claiming before starting work means the other computer sees no active handoff for this repository. When `previous` differs, the map changed underneath you: run `get` again and tell the user what it now says.

**Push** _(CLI mirror only)_ — the cleared map goes back to the cloud, so the other machine cannot resume the same handoff a second time:

```bash
proton-drive filesystem upload -f create-new-revision -t "$HANDOFFS_DIR/handoff_map.json" /my-files/Documents/Handoffs
```

Complete when the transfer summary lists the map as uploaded.

### 4. Bring this machine current

This checkout may be days behind, and may hold leftovers of its own the handoff knows nothing about.

1. Run `audit . private` (drop `private` when it is not a Git checkout). Report anything it finds under a `⚠ Work not merged to main on this machine:` block.
2. When both checkouts are clean, run `npm run sync:main`. When either is dirty, show the files and ask what to do before syncing; `sync:main` refuses a dirty tree itself.
3. When the handoff names a branch in flight, `git switch <branch>` to pick it up from origin.
4. When the pull changed `package-lock.json`, ask before `npm install` — AGENTS.md gates dependency installs on confirmation.

### 5. Proceed

Summarize the handoff in a few lines: the current outcome, the unmerged work it lists, open human gates, and the first next step. Invoke the suggested skills that apply, then start that first step.

The handoff describes work; it confirms nothing. Production mutations and every other confirmation-gated operation in AGENTS.md still get the user's explicit confirmation in this session.
