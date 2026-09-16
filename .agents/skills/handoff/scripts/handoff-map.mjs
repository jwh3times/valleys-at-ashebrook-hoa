/**
 * Proton Drive handoff map helper, shared by the `handoff` and `lets-go`
 * skills so both machines (Windows and Fedora) read and write the map the
 * same way.
 *
 *   node .agents/skills/handoff/scripts/handoff-map.mjs audit [repo...]
 *   node .agents/skills/handoff/scripts/handoff-map.mjs get
 *   node .agents/skills/handoff/scripts/handoff-map.mjs set <file-name|null>
 *
 * The Handoffs folder is `HANDOFFS_DIR` (or the older `HANDOFF_DIR`) when
 * set, otherwise the one `<home>/<*proton*>/[<account>/]My files/Documents/Handoffs`
 * that holds a `handoff_map.json`. On a machine without the Proton Drive
 * desktop client the variable names a local mirror that the skills pull and
 * push through the `proton-drive` CLI. The map is shared by every repository,
 * so this never creates one.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAP_FILE = 'handoff_map.json';
const DIR_ENV = 'HANDOFFS_DIR';
const LEGACY_DIR_ENV = 'HANDOFF_DIR';

function fail(message) {
  console.error(`handoff-map: ${message}`);
  process.exit(1);
}

function git(args, cwd = process.cwd()) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Proton Drive's Windows folders are cloud-filter reparse points, which a
 * Dirent does not report as directories, so anything not plainly a file is
 * stat'ed through.
 */
function childDirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => {
      if (entry.isDirectory()) return true;
      if (entry.isFile()) return false;
      try {
        return fs.statSync(path.join(dir, entry.name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((entry) => path.join(dir, entry.name));
}

/** Case-insensitive, because Proton names it "My files" on Windows. */
function childNamed(dir, name) {
  if (!dir) return undefined;
  return childDirs(dir).find(
    (child) => path.basename(child).toLowerCase() === name.toLowerCase(),
  );
}

function locateDir() {
  const envName = [DIR_ENV, LEGACY_DIR_ENV].find((name) =>
    process.env[name]?.trim(),
  );
  const override = envName && process.env[envName].trim();
  if (override) {
    if (!fs.existsSync(path.join(override, MAP_FILE))) {
      fail(
        `${envName}=${override} contains no ${MAP_FILE}; ` +
          'on a CLI-mirror machine pull it first with ' +
          `proton-drive filesystem download -f remove /my-files/Documents/Handoffs/${MAP_FILE} "${override}"`,
      );
    }
    return override;
  }

  const found = new Set();
  const roots = childDirs(os.homedir()).filter((dir) =>
    /proton/i.test(path.basename(dir)),
  );
  for (const root of roots) {
    for (const base of [root, ...childDirs(root)]) {
      const handoffs = childNamed(
        childNamed(childNamed(base, 'My files'), 'Documents'),
        'Handoffs',
      );
      if (handoffs && fs.existsSync(path.join(handoffs, MAP_FILE))) {
        found.add(handoffs);
      }
    }
  }

  if (found.size === 1) return [...found][0];
  if (found.size === 0) {
    fail(
      `no Proton Drive Handoffs folder with ${MAP_FILE} under ${os.homedir()}; ` +
        `set ${DIR_ENV} to the folder path`,
    );
  }
  fail(
    `several Handoffs folders found; set ${DIR_ENV} to one of:\n  ${[...found].join('\n  ')}`,
  );
}

/** The origin repository name, else the main checkout's directory name. */
function repoKey() {
  const url = git(['remote', 'get-url', 'origin']);
  const fromUrl = url && /([^/:\\]+?)(?:\.git)?\/*$/.exec(url)?.[1];
  if (fromUrl) return fromUrl;
  const common = git([
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (common) return path.basename(path.dirname(common));
  fail('not inside a Git repository');
}

function readMap(dir) {
  const file = path.join(dir, MAP_FILE);
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  let map;
  try {
    map = JSON.parse(raw);
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`);
  }
  const active = map?.Active_Handoffs;
  if (!active || typeof active !== 'object' || Array.isArray(active)) {
    fail(`${file} has no Active_Handoffs object`);
  }
  return { file, map, eol: raw.includes('\r\n') ? '\r\n' : '\n' };
}

/** Proton Drive names sync-conflict copies after the original file. */
function warnConflictCopies(dir) {
  const copies = fs
    .readdirSync(dir)
    .filter(
      (name) => name !== MAP_FILE && /^handoff_map\b.*\.json$/i.test(name),
    );
  for (const copy of copies) {
    console.error(
      `handoff-map: WARNING possible sync-conflict copy of the map: ${copy}`,
    );
  }
}

function findKey(active, key) {
  return Object.keys(active).find(
    (existing) => existing.toLowerCase() === key.toLowerCase(),
  );
}

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function get() {
  const dir = locateDir();
  warnConflictCopies(dir);
  const key = repoKey();
  const { map } = readMap(dir);
  const existing = findKey(map.Active_Handoffs, key);
  const file = existing ? map.Active_Handoffs[existing] : null;
  console.log(
    JSON.stringify(
      {
        dir,
        key: existing ?? key,
        file,
        path: file ? path.join(dir, file) : null,
        exists: file ? fs.existsSync(path.join(dir, file)) : null,
      },
      null,
      2,
    ),
  );
}

function set(value) {
  if (value === undefined) fail('usage: set <file-name|null>');
  const dir = locateDir();
  warnConflictCopies(dir);
  const key = repoKey();
  const next = value === 'null' ? null : value;
  if (next !== null) {
    if (path.basename(next) !== next) {
      fail('set takes a bare file name inside the Handoffs folder');
    }
    if (!fs.existsSync(path.join(dir, next))) {
      fail(`${next} does not exist in ${dir}`);
    }
  }

  // Re-read immediately before writing: the other machine may have synced a
  // change to another repository's entry since this session started.
  const { file, map, eol } = readMap(dir);
  const existing = findKey(map.Active_Handoffs, key);
  const previous = existing ? map.Active_Handoffs[existing] : null;
  if (existing) {
    map.Active_Handoffs[existing] = next;
  } else {
    const entries = [...Object.entries(map.Active_Handoffs), [key, next]];
    entries.sort(([a], [b]) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    );
    map.Active_Handoffs = Object.fromEntries(entries);
  }
  map.Last_Updated = stamp();
  fs.writeFileSync(
    file,
    JSON.stringify(map, null, 2).replace(/\n/g, eol) + eol,
    'utf8',
  );
  console.log(
    JSON.stringify({ key: existing ?? key, previous, current: next }, null, 2),
  );
}

/** Everything in one repository that has not reached origin's default branch. */
function auditRepo(root) {
  const findings = [];
  if (git(['rev-parse', '--git-dir'], root) === null) {
    return { root, skipped: 'not a Git repository', findings };
  }
  const fetched = git(['fetch', '--prune', '--quiet', 'origin'], root) !== null;
  const head = git(
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    root,
  );
  const base = head?.startsWith('origin/') ? head : 'origin/main';

  for (const block of (git(['worktree', 'list', '--porcelain'], root) ?? '')
    .split(/\n\s*\n/)
    .filter(Boolean)) {
    const worktree = /^worktree (.+)$/m.exec(block)?.[1];
    if (!worktree) continue;
    const dirty = (git(['status', '--porcelain'], worktree) ?? '')
      .split('\n')
      .filter(Boolean).length;
    if (dirty > 0) {
      findings.push(`uncommitted: ${dirty} changed file(s) in ${worktree}`);
    }
  }

  const refs = git(
    [
      'for-each-ref',
      '--format=%(refname:short)|%(upstream:short)|%(upstream:track)',
      'refs/heads',
    ],
    root,
  );
  for (const line of (refs ?? '').split('\n').filter(Boolean)) {
    const [branch, upstream, track] = line.split('|');
    const unmerged = Number(
      git(['rev-list', '--count', `${base}..${branch}`], root) ?? '0',
    );
    if (unmerged === 0) continue;
    const remote = !upstream
      ? 'never pushed'
      : track.includes('gone')
        ? `upstream ${upstream} deleted`
        : track.includes('ahead')
          ? `${track.replace(/[[\]]/g, '')} of ${upstream}`
          : `pushed to ${upstream}`;
    findings.push(
      `branch ${branch}: ${unmerged} commit(s) not in ${base} (${remote})`,
    );
  }

  const stashes = (git(['stash', 'list'], root) ?? '')
    .split('\n')
    .filter(Boolean).length;
  if (stashes > 0) findings.push(`stash: ${stashes} entr(ies)`);

  return { root, base, fetched, findings };
}

function audit(roots) {
  let unmerged = false;
  for (const root of roots.length > 0 ? roots : ['.']) {
    const result = auditRepo(path.resolve(root));
    console.log(`== ${result.root}`);
    if (result.skipped) {
      console.log(`   skipped: ${result.skipped}`);
      continue;
    }
    if (!result.fetched) {
      console.log(
        `   fetch failed; compared against last-fetched ${result.base}`,
      );
    }
    if (result.findings.length === 0) {
      console.log(`   everything merged to ${result.base}`);
    }
    for (const finding of result.findings) console.log(`   ${finding}`);
    unmerged ||= result.findings.length > 0;
  }
  console.log(`status: ${unmerged ? 'unmerged' : 'clean'}`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'audit') audit(rest);
else if (command === 'get') get();
else if (command === 'set') set(rest[0]);
else
  fail('usage: handoff-map.mjs audit [repo...] | get | set <file-name|null>');
