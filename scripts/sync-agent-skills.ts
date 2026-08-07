/**
 * Synchronize the authored Codex skills and Claude agents into the formats
 * consumed by Claude Code and Codex respectively.
 *
 *   AUTHORED   `.agents/skills/<name>/**`, `.claude/agents/*.md`
 *   GENERATED  `.claude/skills/<name>/**`, `.codex/agents/*.toml`
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

export const SKILL_SOURCE_DIR = '.agents/skills';
export const CLAUDE_SKILL_DIR = '.claude/skills';
export const AGENT_SOURCE_DIR = '.claude/agents';
export const CODEX_AGENT_DIR = '.codex/agents';
export const GENERATED_SKILL_COMMENT = '# GENERATED — do not edit. Source:';

export type Frontmatter = { data: Record<string, string>; body: string };

/** Read the flat YAML frontmatter used by skills and Claude custom agents. */
export function parseFrontmatter(source: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { data: {}, body: source.trim() };

  const data: Record<string, string> = {};
  let lastKey = '';
  for (const line of match[1].split(/\r?\n/)) {
    const keyed = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(line);
    if (keyed) {
      lastKey = keyed[1];
      data[lastKey] = keyed[2].trim();
    } else if (lastKey && line.trim()) {
      data[lastKey] = `${data[lastKey]} ${line.trim()}`.trim();
    }
  }
  return { data, body: source.slice(match[0].length).trim() };
}

export function normalizeLf(source: string): string {
  return source.replace(/\r\n?/g, '\n');
}

/** Render the otherwise-identical Claude skill with in-frontmatter provenance. */
export function renderSkillMirror(source: string, sourceRel: string): Buffer {
  const normalized = normalizeLf(source);
  if (!normalized.startsWith('---\n')) {
    throw new Error(`${sourceRel} must start with YAML frontmatter`);
  }
  const rendered = normalized.replace(
    '---\n',
    `---\n${GENERATED_SKILL_COMMENT} ${sourceRel}\n`,
  );
  return Buffer.from(
    rendered.endsWith('\n') ? rendered : `${rendered}\n`,
    'utf8',
  );
}

/** Render the Claude custom-agent subset supported by Codex's TOML registry. */
export function renderCodexAgent(source: string, sourceRel: string): Buffer {
  const { data, body } = parseFrontmatter(normalizeLf(source));
  if (!data.name || !data.description) {
    throw new Error(`${sourceRel} requires name and description frontmatter`);
  }
  if (body.includes('"""')) {
    throw new Error(
      `${sourceRel} contains an unsupported triple-quote delimiter`,
    );
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

export type GeneratedTreePlan = {
  /** Repository-relative generated-tree root, with POSIX separators. */
  root: string;
  /** Repository-relative-to-root generated files, with POSIX separators. */
  files: Map<string, Buffer>;
};

const toPosix = (value: string) => value.replace(/\\/g, '/');
const displayPath = (tree: GeneratedTreePlan, rel: string) =>
  `${tree.root}/${rel}`;

function lstatOrUndefined(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** List authored files, rejecting every kind of link before it can be read. */
function listRealFiles(dir: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Authored tree contains unsupported link: ${path.join(dir, entry.name)}`,
      );
    }
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listRealFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files.sort();
}

/** List generated leaves without traversing generated-tree links. */
function listGeneratedFiles(dir: string, prefix = ''): string[] {
  if (!lstatOrUndefined(dir)) return [];

  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      files.push(...listGeneratedFiles(path.join(dir, entry.name), rel));
    } else {
      files.push(rel);
    }
  }
  return files.sort();
}

function planSkills(root: string): GeneratedTreePlan {
  const files = new Map<string, Buffer>();
  const sourceRoot = path.join(root, ...SKILL_SOURCE_DIR.split('/'));
  if (!lstatOrUndefined(sourceRoot)) return { root: CLAUDE_SKILL_DIR, files };

  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Authored tree contains unsupported link: ${path.join(sourceRoot, entry.name)}`,
      );
    }
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
  const sourceRoot = path.join(root, ...AGENT_SOURCE_DIR.split('/'));
  if (!lstatOrUndefined(sourceRoot)) return { root: CODEX_AGENT_DIR, files };

  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Authored tree contains unsupported link: ${path.join(sourceRoot, entry.name)}`,
      );
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const sourceRel = `${AGENT_SOURCE_DIR}/${entry.name}`;
    files.set(
      entry.name.replace(/\.md$/, '.toml'),
      renderCodexAgent(
        fs.readFileSync(path.join(sourceRoot, entry.name), 'utf8'),
        sourceRel,
      ),
    );
  }
  return { root: CODEX_AGENT_DIR, files };
}

/** Build the complete generated output from the two authored trees. */
export function plan(root: string = REPO_ROOT): GeneratedTreePlan[] {
  return [planSkills(root), planAgents(root)];
}

export type Drift = {
  missing: string[];
  stale: string[];
  extraneous: string[];
};

/** Compare the generated filesystem seam without modifying it. */
export function diff(
  root: string = REPO_ROOT,
  plans: GeneratedTreePlan[] = plan(root),
): Drift {
  const drift: Drift = { missing: [], stale: [], extraneous: [] };

  for (const tree of plans) {
    const treeRoot = path.join(root, ...tree.root.split('/'));
    for (const [rel, expected] of tree.files) {
      const target = path.join(treeRoot, ...rel.split('/'));
      const stat = lstatOrUndefined(target);
      if (!stat) {
        drift.missing.push(displayPath(tree, rel));
      } else if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        !fs.readFileSync(target).equals(expected)
      ) {
        drift.stale.push(displayPath(tree, rel));
      }
    }

    for (const rel of listGeneratedFiles(treeRoot)) {
      if (!tree.files.has(rel)) drift.extraneous.push(displayPath(tree, rel));
    }
  }

  drift.missing.sort();
  drift.stale.sort();
  drift.extraneous.sort();
  return drift;
}

export function hasDrift(drift: Drift): boolean {
  return Object.values(drift).some((entries) => entries.length > 0);
}

function removeGeneratedEntry(target: string): void {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(target);
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function requireRealParent(root: string, generatedRoot: string): void {
  let current = root;
  const parts = generatedRoot.split('/');
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = lstatOrUndefined(current);
    if (!stat) {
      fs.mkdirSync(current);
    } else if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `Generated tree parent is not a real directory: ${current}`,
      );
    }
  }
}

function ensureRealGeneratedDirectory(
  target: string,
  display: string,
  removed: string[],
): void {
  const stat = lstatOrUndefined(target);
  if (stat?.isDirectory() && !stat.isSymbolicLink()) return;
  if (stat) {
    removeGeneratedEntry(target);
    removed.push(display);
  }
  fs.mkdirSync(target, { recursive: true });
}

function ensureGeneratedFileParent(
  treeRoot: string,
  tree: GeneratedTreePlan,
  rel: string,
  removed: string[],
): void {
  let current = treeRoot;
  const parts = rel.split('/').slice(0, -1);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    ensureRealGeneratedDirectory(
      current,
      displayPath(tree, parts.slice(0, index + 1).join('/')),
      removed,
    );
  }
}

function removeEmptyDirectories(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const child = path.join(dir, entry.name);
    removeEmptyDirectories(child);
    const stat = lstatOrUndefined(child);
    if (
      stat?.isDirectory() &&
      !stat.isSymbolicLink() &&
      fs.readdirSync(child).length === 0
    ) {
      fs.rmdirSync(child);
    }
  }
}

/** Reconcile both generated trees without ever traversing a link. */
export function sync(root: string = REPO_ROOT): {
  written: string[];
  removed: string[];
} {
  const written: string[] = [];
  const removed: string[] = [];

  for (const tree of plan(root)) {
    requireRealParent(root, tree.root);
    const treeRoot = path.join(root, ...tree.root.split('/'));
    ensureRealGeneratedDirectory(treeRoot, tree.root, removed);

    for (const [rel, contents] of tree.files) {
      ensureGeneratedFileParent(treeRoot, tree, rel, removed);
      const target = path.join(treeRoot, ...rel.split('/'));
      const stat = lstatOrUndefined(target);
      if (
        stat?.isFile() &&
        !stat.isSymbolicLink() &&
        fs.readFileSync(target).equals(contents)
      ) {
        continue;
      }
      if (stat) {
        removeGeneratedEntry(target);
        removed.push(displayPath(tree, rel));
      }
      fs.writeFileSync(target, contents);
      written.push(displayPath(tree, rel));
    }

    for (const rel of listGeneratedFiles(treeRoot)) {
      if (tree.files.has(rel)) continue;
      removeGeneratedEntry(path.join(treeRoot, ...rel.split('/')));
      removed.push(displayPath(tree, rel));
    }
    removeEmptyDirectories(treeRoot);
  }

  return { written, removed };
}

/** True when a touched path belongs to an authored input tree. */
export function isAuthoredPath(
  filePath: string,
  root: string = REPO_ROOT,
): boolean {
  const file = toPosix(filePath).replace(/^\.\//, '');
  const base = toPosix(root).replace(/\/+$/, '');
  const rel = file.toLowerCase().startsWith(`${base.toLowerCase()}/`)
    ? file.slice(base.length + 1)
    : file;
  if (rel.startsWith('..')) return false;
  return (
    rel.startsWith(`${SKILL_SOURCE_DIR}/`) ||
    rel.startsWith(`${AGENT_SOURCE_DIR}/`)
  );
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

async function runHook(): Promise<void> {
  try {
    const raw = await readStdin();
    if (raw.trim()) {
      const payload = JSON.parse(raw) as {
        tool_input?: { file_path?: string; path?: string };
      };
      const touched = payload.tool_input?.file_path ?? payload.tool_input?.path;
      if (touched && !isAuthoredPath(touched)) return;
    }
    const { written, removed } = sync();
    const changed = written.length + removed.length;
    if (changed > 0) {
      console.log(
        `agents:sync regenerated ${changed} file(s) in generated trees.`,
      );
    }
  } catch (error) {
    console.log(`agents:sync hook skipped: ${(error as Error).message}`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--hook')) {
    await runHook();
    return;
  }

  if (process.argv.includes('--check')) {
    const drift = diff();
    if (!hasDrift(drift)) {
      console.log('Generated agent trees are in sync.');
      return;
    }
    console.error('Generated agent trees are out of sync:');
    for (const entry of drift.missing) console.error(`  missing      ${entry}`);
    for (const entry of drift.stale) console.error(`  stale        ${entry}`);
    for (const entry of drift.extraneous)
      console.error(`  extraneous  ${entry}`);
    process.exit(1);
  }

  const { written, removed } = sync();
  if (written.length === 0 && removed.length === 0) {
    console.log('Generated agent trees already up to date.');
    return;
  }
  for (const entry of written) console.log(`  wrote    ${entry}`);
  for (const entry of removed) console.log(`  removed  ${entry}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
