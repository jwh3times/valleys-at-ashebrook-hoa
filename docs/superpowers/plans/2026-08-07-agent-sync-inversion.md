# Agent Sync Inversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `.agents/skills` the single authored skill tree, generate complete Claude Code skill copies under `.claude/skills`, and generate Codex custom-agent TOML from `.claude/agents`.

**Architecture:** Invert the existing `scripts/sync-agent-skills.ts` planner so it produces two deterministic generated trees from two authored inputs. Keep rendering pure and separately testable, then use a filesystem planner/diff/sync layer that never follows links and a CLI layer that writes or checks the complete output contract.

**Tech Stack:** Node.js 26, TypeScript with `--experimental-strip-types`, Vitest, Prettier, GitHub Actions, Markdown/YAML-frontmatter skills, Codex TOML custom agents.

## Global Constraints

- `.agents/skills/<name>/**` is authored; `.claude/skills/<name>/**` is generated and never edited.
- `.claude/agents/<name>.md` is authored; `.codex/agents/<name>.toml` is generated and never edited.
- Mirror every skill file recursively; only generated `SKILL.md` receives a banner.
- The `SKILL.md` banner is a YAML comment on line 2, immediately after the opening `---`.
- Supporting files are copied as exact buffers.
- Generated text is deterministic LF with no timestamps.
- Symbolic links and Windows junctions are unlinked, never recursively traversed or deleted through.
- Run formatting before regeneration: `npm run format`, then `npm run sync:agents`.
- CI check mode is `npm run sync:agents -- --check` and never writes.
- Do not add dependencies.

---

### Task 1: Pure skill and Codex-agent renderers

**Files:**

- Modify: `test/unit/sync-agent-skills.test.ts`
- Modify: `scripts/sync-agent-skills.ts`

**Interfaces:**

- Produces: `normalizeLf(source: string): string`
- Produces: `renderSkillMirror(source: string, sourceRel: string): Buffer`
- Produces: `renderCodexAgent(source: string, sourceRel: string): Buffer`
- Retains: `parseFrontmatter(source: string): Frontmatter`

- [ ] **Step 1: Replace the old direction-specific renderer tests with failing tests**

```ts
const skillSource = `---\r\nname: ship\r\ndescription: Ship the branch.\r\n---\r\n\r\n# Ship\r\n`;

it('puts the generated YAML comment on line 2 and normalizes LF', () => {
  const out = renderSkillMirror(
    skillSource,
    '.agents/skills/ship/SKILL.md',
  ).toString('utf8');
  expect(out.split('\n').slice(0, 4)).toEqual([
    '---',
    '# GENERATED — do not edit. Source: .agents/skills/ship/SKILL.md',
    'name: ship',
    'description: Ship the branch.',
  ]);
  expect(out).not.toContain('\r');
  expect(parseFrontmatter(out).data.name).toBe('ship');
});

it('renders current Codex custom-agent TOML fields', () => {
  const out = renderCodexAgent(agentSource, '.claude/agents/docs-updater.md').toString('utf8');
  expect(out).toContain('name = "docs-updater"');
  expect(out).toContain('description = "Keeps the docs current."');
  expect(out).toContain('developer_instructions = """');
  expect(out).toContain('You keep documentation current.');
  expect(out).not.toContain('tools =');
  expect(out).not.toContain('model =');
});
```

- [ ] **Step 2: Run the focused tests and verify red**

Run: `npx vitest run test/unit/sync-agent-skills.test.ts`

Expected: FAIL because `renderCodexAgent` does not exist and the skill banner is not on line 2.

- [ ] **Step 3: Implement the minimal pure renderers**

```ts
export const GENERATED_SKILL_COMMENT = '# GENERATED — do not edit. Source:';

export function normalizeLf(source: string): string {
  return source.replace(/\r\n?/g, '\n');
}

export function renderSkillMirror(source: string, sourceRel: string): Buffer {
  const normalized = normalizeLf(source);
  if (!normalized.startsWith('---\n')) {
    throw new Error(`${sourceRel} must start with YAML frontmatter`);
  }
  const rendered = normalized.replace(
    '---\n',
    `---\n${GENERATED_SKILL_COMMENT} ${sourceRel}\n`,
  );
  return Buffer.from(rendered.endsWith('\n') ? rendered : `${rendered}\n`, 'utf8');
}

export function renderCodexAgent(source: string, sourceRel: string): Buffer {
  const { data, body } = parseFrontmatter(normalizeLf(source));
  if (!data.name || !data.description) {
    throw new Error(`${sourceRel} requires name and description frontmatter`);
  }
  if (body.includes('"""')) {
    throw new Error(`${sourceRel} contains an unsupported triple-quote delimiter`);
  }
  const rendered = [
    '# GENERATED — do not edit.',
    `# Source: ${sourceRel}`,
    `name = ${JSON.stringify(data.name)}`,
    `description = ${JSON.stringify(data.description)}`,
    'developer_instructions = """',
    body,
    '"""',
    '',
  ].join('\n');
  return Buffer.from(rendered, 'utf8');
}
```

- [ ] **Step 4: Run the focused tests and verify green**

Run: `npx vitest run test/unit/sync-agent-skills.test.ts`

Expected: renderer tests PASS; filesystem tests may still be red until Task 2.

- [ ] **Step 5: Commit the renderer slice**

```bash
git add scripts/sync-agent-skills.ts test/unit/sync-agent-skills.test.ts
git commit -m "feat: render Claude skills and Codex agents"
```

### Task 2: Safe full-tree planner, drift check, and synchronizer

**Files:**

- Modify: `test/unit/sync-agent-skills.test.ts`
- Modify: `scripts/sync-agent-skills.ts`

**Interfaces:**

- Consumes: `renderSkillMirror`, `renderCodexAgent`
- Produces: `GeneratedTreePlan { root: string; files: Map<string, Buffer> }`
- Produces: `plan(root?: string): GeneratedTreePlan[]`
- Produces: `diff(root?: string, plans?: GeneratedTreePlan[]): Drift`
- Produces: `sync(root?: string): { written: string[]; removed: string[] }`
- Produces: `isAuthoredPath(filePath: string, root?: string): boolean`

- [ ] **Step 1: Write fixture-based failing tests at the filesystem seam**

```ts
it('plans every file in an authored skill and both generated trees', () => {
  const root = fixtureRepo();
  write(root, '.agents/skills/demo/SKILL.md', skillSource);
  write(root, '.agents/skills/demo/scripts/run.sh', Buffer.from([0, 1, 2, 255]));
  write(root, '.claude/agents/docs-updater.md', agentSource);

  const plans = plan(root);
  expect(planned(plans, '.claude/skills/demo/SKILL.md')).toBeDefined();
  expect(planned(plans, '.claude/skills/demo/scripts/run.sh')).toEqual(
    Buffer.from([0, 1, 2, 255]),
  );
  expect(planned(plans, '.codex/agents/docs-updater.toml')).toBeDefined();
});

it('reports missing, stale, and extraneous generated files without writing', () => {
  const root = fixtureRepo();
  seedAuthoredSources(root);
  write(root, '.claude/skills/demo/SKILL.md', 'stale');
  write(root, '.claude/skills/orphan/SKILL.md', 'extra');
  expect(diff(root)).toEqual({
    missing: ['.codex/agents/docs-updater.toml'],
    stale: ['.claude/skills/demo/SKILL.md'],
    extraneous: ['.claude/skills/orphan/SKILL.md'],
  });
});

it('unlinks a generated-tree junction without deleting its target', () => {
  const root = fixtureRepo();
  const external = path.join(root, 'junction-target');
  write(root, 'junction-target/keep.txt', 'keep');
  write(root, '.agents/skills/demo/SKILL.md', skillSource);
  fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
  fs.symlinkSync(
    external,
    path.join(root, '.claude', 'skills', 'demo'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  sync(root);

  expect(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8')).toBe('keep');
  expect(fs.lstatSync(path.join(root, '.claude', 'skills', 'demo')).isSymbolicLink()).toBe(false);
});
```

- [ ] **Step 2: Run the focused tests and verify red**

Run: `npx vitest run test/unit/sync-agent-skills.test.ts`

Expected: FAIL because planning still reads `.claude/skills`, writes `.agents/skills`, and has no `.codex/agents` plan.

- [ ] **Step 3: Implement the two-tree planner**

```ts
export const SKILL_SOURCE_DIR = '.agents/skills';
export const CLAUDE_SKILL_DIR = '.claude/skills';
export const AGENT_SOURCE_DIR = '.claude/agents';
export const CODEX_AGENT_DIR = '.codex/agents';

export type GeneratedTreePlan = {
  root: string;
  files: Map<string, Buffer>;
};

function listRealFiles(dir: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`Authored tree contains unsupported link: ${path.join(dir, entry.name)}`);
    }
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listRealFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files.sort();
}

function planSkills(root: string): GeneratedTreePlan {
  const files = new Map<string, Buffer>();
  const sourceRoot = path.join(root, SKILL_SOURCE_DIR);
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillRoot = path.join(sourceRoot, entry.name);
    for (const rel of listRealFiles(skillRoot)) {
      const sourceRel = `${SKILL_SOURCE_DIR}/${entry.name}/${rel}`;
      const source = fs.readFileSync(path.join(skillRoot, ...rel.split('/')));
      files.set(
        `${entry.name}/${rel}`,
        rel === 'SKILL.md'
          ? renderSkillMirror(source.toString('utf8'), sourceRel)
          : source,
      );
    }
  }
  return { root: CLAUDE_SKILL_DIR, files };
}

function planAgents(root: string): GeneratedTreePlan {
  const files = new Map<string, Buffer>();
  const sourceRoot = path.join(root, AGENT_SOURCE_DIR);
  for (const file of fs.readdirSync(sourceRoot).sort()) {
    if (!file.endsWith('.md')) continue;
    const sourceRel = `${AGENT_SOURCE_DIR}/${file}`;
    files.set(
      file.replace(/\.md$/, '.toml'),
      renderCodexAgent(fs.readFileSync(path.join(sourceRoot, file), 'utf8'), sourceRel),
    );
  }
  return { root: CODEX_AGENT_DIR, files };
}

export function plan(root: string = REPO_ROOT): GeneratedTreePlan[] {
  return [planSkills(root), planAgents(root)];
}
```

- [ ] **Step 4: Implement safe generated-tree reconciliation**

```ts
function removeGeneratedEntry(abs: string): void {
  const stat = fs.lstatSync(abs);
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(abs);
    return;
  }
  fs.rmSync(abs, { recursive: true, force: true });
}
```

Use `lstatSync` before every replacement or prune operation, compare buffers exactly, create parent
directories for planned files, and remove empty directories after stale files are pruned.

- [ ] **Step 5: Run the focused tests and verify green and deterministic output**

Run: `npx vitest run test/unit/sync-agent-skills.test.ts`

Expected: all sync tests PASS. Run `sync(root)` twice in a test and assert the second result is
`{ written: [], removed: [] }`.

- [ ] **Step 6: Commit the filesystem slice**

```bash
git add scripts/sync-agent-skills.ts test/unit/sync-agent-skills.test.ts
git commit -m "feat: invert agent synchronization"
```

### Task 3: CLI contract, hooks, formatter, and CI

**Files:**

- Modify: `test/unit/sync-agent-skills.test.ts`
- Modify: `scripts/sync-agent-skills.ts`
- Modify: `package.json`
- Modify: `.claude/settings.json`
- Modify: `.prettierignore`
- Modify: `.github/workflows/build.yml`

**Interfaces:**

- Consumes: `plan`, `diff`, `sync`, `isAuthoredPath`
- Produces: `npm run sync:agents`
- Produces: `npm run sync:agents -- --check`

- [ ] **Step 1: Write failing tests for path classification and check-only behavior**

```ts
it('classifies only authored inputs as hook sources', () => {
  expect(isAuthoredPath('.agents/skills/ship/SKILL.md')).toBe(true);
  expect(isAuthoredPath('.claude/agents/docs-updater.md')).toBe(true);
  expect(isAuthoredPath('.claude/skills/ship/SKILL.md')).toBe(false);
  expect(isAuthoredPath('.codex/agents/docs-updater.toml')).toBe(false);
});

it('leaves generated files unchanged when check mode reports drift', () => {
  const root = fixtureRepo();
  seedAuthoredSources(root);
  const before = snapshotTree(root);
  expect(hasDrift(diff(root))).toBe(true);
  expect(snapshotTree(root)).toEqual(before);
});
```

- [ ] **Step 2: Run the focused tests and verify red**

Run: `npx vitest run test/unit/sync-agent-skills.test.ts`

Expected: FAIL because the old hook classifier treats generated paths as sources.

- [ ] **Step 3: Update command and integration wiring**

```json
"sync:agents": "node --experimental-strip-types scripts/sync-agent-skills.ts"
```

Remove `agents:sync` and `agents:check`. Update `.claude/settings.json` to call
`scripts/sync-agent-skills.ts --hook`, update `.prettierignore` to include
`.claude/skills/` and `.codex/agents/`, and update CI to run:

```yaml
- run: npm run sync:agents -- --check
```

- [ ] **Step 4: Update CLI output and hook filtering**

Check mode prints the exact generated roots and exits 1 on drift. Write mode prints written and
removed paths. Hook mode runs only when `.agents/skills/**` or `.claude/agents/*.md` changed and
always exits 0 after reporting errors.

- [ ] **Step 5: Run the focused tests and command contract**

Run: `npx vitest run test/unit/sync-agent-skills.test.ts`

Expected: PASS.

Run: `npm run sync:agents -- --check`

Expected before migration: FAIL with reported drift and no filesystem changes.

- [ ] **Step 6: Commit the integration slice**

```bash
git add scripts/sync-agent-skills.ts test/unit/sync-agent-skills.test.ts package.json .claude/settings.json .prettierignore .github/workflows/build.yml
git commit -m "ci: enforce the authored agent trees"
```

### Task 4: Migrate authored and generated trees

**Files:**

- Modify: `.agents/skills/ship/SKILL.md`
- Delete: `.agents/skills/code-reviewer/SKILL.md`
- Delete: `.agents/skills/docs-updater/SKILL.md`
- Replace generated tree: `.claude/skills/**`
- Create generated files: `.codex/agents/code-reviewer.toml`
- Create generated files: `.codex/agents/docs-updater.toml`
- Preserve: `skills-lock.json`

**Interfaces:**

- Consumes: `npm run sync:agents`
- Produces: a repository tree satisfying `npm run sync:agents -- --check`

- [ ] **Step 1: Make `.agents/skills/ship` the clean authored copy**

Replace its generated copy with the former `.claude/skills/ship/SKILL.md` content and remove the old
generated HTML banner. Remove the obsolete generated `code-reviewer` and `docs-updater` skills;
their authored Claude agents now generate `.codex/agents/*.toml`.

- [ ] **Step 2: Run format over all authored repository files**

Run: `npm run format`

Expected: exit 0; `.agents/skills` is formatted while generated `.claude/skills` and
`.codex/agents` are ignored.

- [ ] **Step 3: Regenerate both output trees**

Run: `npm run sync:agents`

Expected: installer-created junctions are replaced by real generated directories; source files
beneath `.agents/skills` remain intact.

- [ ] **Step 4: Verify the migrated tree is in sync**

Run: `npm run sync:agents -- --check`

Expected: exit 0 with both generated trees reported in sync.

- [ ] **Step 5: Confirm Git sees generated files, not links or duplicate source paths**

Run: `git status --short`

Expected: authored `.agents/skills`, generated `.claude/skills`, `.codex/agents`, and
`skills-lock.json` appear; no symlink/junction-only entries remain.

- [ ] **Step 6: Commit the migration slice**

```bash
git add .agents/skills .claude/skills .codex/agents skills-lock.json
git commit -m "feat: add repository engineering skills"
```

### Task 5: Documentation and release entry

**Files:**

- Modify: `AGENTS.md`
- Modify if drifted: `README.md`
- Check only unless relevant: `SETUP.md`
- Check only unless relevant: `SECURITY.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: completed repository diff and `bash scripts/next-version.sh`
- Produces: documented source-of-truth, command order, symlink warning, and target-version release notes

- [ ] **Step 1: Update agent-facing documentation**

Replace the old `.claude`-to-`.agents` mirror description with:

```md
`.agents/skills` is the authored source for complete skill directories. Run `npm run format` before
`npm run sync:agents`; the latter regenerates `.claude/skills` for Claude Code and
`.codex/agents` from authored `.claude/agents`. Never edit generated trees or reintroduce skill
symlinks: with `core.symlinks=false`, Git stages linked contents as duplicate files.
```

Update the commands and CI descriptions everywhere they occur.

- [ ] **Step 2: Run the docs-updater role against this branch diff**

Give it `git diff $(git merge-base main HEAD)..HEAD --stat`, tell it to maintain only `AGENTS.md`,
`README.md`, `SETUP.md`, and `SECURITY.md`, and explicitly leave `CHANGELOG.md` untouched.

- [ ] **Step 3: Compute the target version**

Run: `bash scripts/next-version.sh`

Expected: one bare SemVer. Do not calculate it manually.

- [ ] **Step 4: Add or rewrite the matching changelog section**

Immediately below `## [Unreleased]`, add today-dated release notes under `### Changed` describing
the authoritative `.agents` tree, complete-directory generation, safe removal of junctions, and
Codex custom-agent TOML generation.

- [ ] **Step 5: Format and commit documentation**

Run: `npm run format`

Then regenerate because authored skills were formatted:

Run: `npm run sync:agents`

```bash
git add AGENTS.md README.md SETUP.md SECURITY.md CHANGELOG.md .claude/skills .codex/agents
git commit -m "docs: document agent synchronization"
```

### Task 6: Full verification, fresh checkout, and PR

**Files:**

- Verify: all changed files
- Update only if target version changed: `CHANGELOG.md`

**Interfaces:**

- Consumes: completed branch
- Produces: pushed branch and open PR

- [ ] **Step 1: Run format, regenerate, and check in the required order**

```bash
npm run format
npm run sync:agents
npm run sync:agents -- --check
```

Expected: all exit 0; check reports both generated trees in sync.

- [ ] **Step 2: Run every CI gate**

```bash
npm run format:check
npm run sync:agents -- --check
npm run lint:coercions
npm run check
npm test
npm run test:server
npm run build
```

Expected: every command exits 0 with no failing tests.

- [ ] **Step 3: Validate all generated skill frontmatter**

Run a Node script that recursively opens `.claude/skills/*/SKILL.md`, asserts line 1 is `---`, line
2 starts with `# GENERATED — do not edit. Source:`, finds the closing `---`, and verifies parsed
frontmatter contains non-empty `name` and `description`.

Expected: every generated skill passes.

- [ ] **Step 4: Commit any final formatting or generated changes**

```bash
git add -A
git commit -m "chore: finalize agent sync migration"
```

Skip the commit only when `git status --short` is empty.

- [ ] **Step 5: Verify a detached fresh checkout**

```powershell
$agentSyncWorktree = Join-Path ([System.IO.Path]::GetTempPath()) (`
  'ashebrook-agent-sync-' + [guid]::NewGuid().ToString('N')
)
git worktree add --detach $agentSyncWorktree HEAD
node --experimental-strip-types (`
  Join-Path $agentSyncWorktree 'scripts/sync-agent-skills.ts'
) --check
git worktree remove --force $agentSyncWorktree
```

Expected: the detached checkout reports both generated trees in sync. Resolve the temporary path
first and verify it is outside the repository before removing the worktree.

- [ ] **Step 6: Recompute the target version immediately before push**

Run: `bash scripts/next-version.sh`

If it differs from the changelog section, rename that existing section, format, regenerate, rerun
the affected checks, and commit the correction.

- [ ] **Step 7: Push and open or update the PR**

```bash
git push -u origin codex/add-repo-skills
gh pr list --head codex/add-repo-skills --state open --json number -q '.[0].number'
```

If no PR exists, create one against `main`. The PR body explains both verified failure modes:
directory walkers skip links, and `core.symlinks=false` makes Git stage duplicate contents. If a PR
already exists, update its title and body instead of opening a duplicate. Do not merge it.
