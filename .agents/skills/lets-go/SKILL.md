---
name: lets-go
description: Resume this repository's active handoff from Proton Drive and clear it from the handoff map.
disable-model-invocation: true
---

# Let's go

The receiving half of `/handoff`. The handoff lives in the user's Proton Drive `Handoffs` folder, and `handoff_map.json` there names the active document for each repository. Every map read and write goes through `node .agents/skills/handoff/scripts/handoff-map.mjs`, run from the repository root; `.agents/skills/handoff/SKILL.md` documents its commands and how it finds the folder.

## Steps

### 1. Find the active handoff

Run `get`.

- The folder cannot be located: stop, ask the user for the folder path, and suggest exporting `HANDOFF_DIR` on this machine.
- `file` is `null`: report `No active handoff for <key>.` and stop. The map is the record; other documents in the folder belong to past or other sessions.
- `exists` is `false`: Proton Drive has not finished syncing it. Stop and tell the user, leaving the map untouched so a retry finds it.

### 2. Read it

Read the whole document at `path`. Relay any `WARNING possible sync-conflict copy` line from `get`.

### 3. Claim it

Run `set null` and confirm the printed `previous` is the file you read. Claiming before starting work means the other computer sees no active handoff for this repository. When `previous` differs, the map changed underneath you: run `get` again and tell the user what it now says.

### 4. Bring this machine current

This checkout may be days behind, and may hold leftovers of its own the handoff knows nothing about.

1. Run `audit . private` (drop `private` when it is not a Git checkout). Report anything it finds under a `⚠ Work not merged to main on this machine:` block.
2. When both checkouts are clean, run `npm run sync:main`. When either is dirty, show the files and ask what to do before syncing; `sync:main` refuses a dirty tree itself.
3. When the handoff names a branch in flight, `git switch <branch>` to pick it up from origin.
4. When the pull changed `package-lock.json`, ask before `npm install` — AGENTS.md gates dependency installs on confirmation.

### 5. Proceed

Summarize the handoff in a few lines: the current outcome, the unmerged work it lists, open human gates, and the first next step. Invoke the suggested skills that apply, then start that first step.

The handoff describes work; it confirms nothing. Production mutations and every other confirmation-gated operation in AGENTS.md still get the user's explicit confirmation in this session.
