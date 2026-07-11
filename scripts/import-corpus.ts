import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { buildInsertSql, type DocumentEntry } from './import-documents.ts';
import {
  toDocumentEntry,
  ragKeyFor,
  type ManifestEntry,
} from './corpus-import-meta.ts';

const HOA = 'private/HOA_files';
const CORPUS = 'private/rag_corpus';
const MANIFEST = `${CORPUS}/import-manifest.json`;
const ID_MAP = `${CORPUS}/import-ids.json`; // relativePath -> uuid (stable re-runs)
const UPLOADED = `${CORPUS}/import-uploaded.json`; // resume: keys already put
const SQL = 'private/corpus-import.sql';

const nodeRequire = createRequire(import.meta.url);
const wranglerBin = path.join(
  path.dirname(nodeRequire.resolve('wrangler/package.json')),
  'bin',
  'wrangler.js',
);
const runWrangler = (args: string[]) =>
  execFileSync(process.execPath, [wranglerBin, ...args], { stdio: 'inherit' });
const runWranglerJson = (args: string[]): string =>
  execFileSync(process.execPath, [wranglerBin, ...args], { encoding: 'utf8' });
const tryDeleteR2 = (key: string) => {
  try {
    runWrangler([
      'r2',
      'object',
      'delete',
      `ashebrook-hoa-docs/${key}`,
      '--remote',
    ]);
  } catch (e) {
    console.warn(
      `[wipe] delete skipped/failed for ${key} (continuing): ${(e as Error).message}`,
    );
  }
};

function loadJson<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function main() {
  const commit = process.argv.includes('--commit');
  const wipe = process.argv.includes('--wipe');

  const manifest = loadJson<ManifestEntry[]>(MANIFEST, []);
  if (manifest.length === 0) {
    console.error(
      `No manifest at ${MANIFEST}. Run build-import-manifest.py first.`,
    );
    process.exit(1);
  }

  const ids = new Map<string, string>(
    Object.entries(loadJson<Record<string, string>>(ID_MAP, {})),
  );
  const entries: DocumentEntry[] = [];
  for (const m of manifest) {
    const full = path.join(HOA, m.relativePath);
    if (!fs.existsSync(full)) {
      console.error(`Missing source: ${full}`);
      process.exit(1);
    }
    const id = ids.get(m.relativePath) ?? crypto.randomUUID();
    ids.set(m.relativePath, id);
    entries.push(toDocumentEntry(m, id, fs.statSync(full).size));
  }
  fs.writeFileSync(ID_MAP, JSON.stringify(Object.fromEntries(ids), null, 2));
  fs.writeFileSync(SQL, buildInsertSql(entries));

  const indexed = manifest.filter((m) => m.ragRelPath).length;
  console.log(
    `Manifest: ${entries.length} human files, ${indexed} rag twins. SQL -> ${SQL}.`,
  );
  if (!commit) {
    console.log(
      `\nDry run. Re-run with \`-- --commit\` (add \`--wipe\` to clear the current library first).`,
    );
    return;
  }

  // --- destructive wipe of the current library (only with --wipe) ---
  if (wipe) {
    console.log('\n[wipe] reading current documents from remote D1…');
    const out = runWranglerJson([
      'd1',
      'execute',
      'ashebrook-hoa',
      '--remote',
      '--json',
      '--command',
      'SELECT id, r2_key FROM documents',
    ]);
    const rows: { id: string; r2_key: string }[] =
      JSON.parse(out)[0]?.results ?? [];
    console.log(
      `[wipe] deleting ${rows.length} R2 objects (+ rag twins) and all rows…`,
    );
    for (const r of rows) {
      tryDeleteR2(r.r2_key);
      tryDeleteR2(ragKeyFor(r.id));
    }
    runWrangler([
      'd1',
      'execute',
      'ashebrook-hoa',
      '--remote',
      '--command',
      'DELETE FROM documents',
    ]);
    fs.writeFileSync(UPLOADED, '[]');
  }

  // --- upload human files + rag twins (resumable) ---
  const uploaded = new Set<string>(loadJson<string[]>(UPLOADED, []));
  const put = (key: string, file: string, type: string) => {
    if (uploaded.has(key)) return;
    runWrangler([
      'r2',
      'object',
      'put',
      `ashebrook-hoa-docs/${key}`,
      '--file',
      file,
      '--remote',
      '--content-type',
      type,
    ]);
    uploaded.add(key);
    fs.writeFileSync(UPLOADED, JSON.stringify([...uploaded], null, 2));
  };
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i],
      m = manifest[i];
    console.log(`[${i + 1}/${entries.length}] ${e.filename}`);
    put(e.r2Key, path.resolve(HOA, e.relativePath), e.contentType);
    if (m.ragRelPath)
      put(ragKeyFor(e.id), path.resolve(CORPUS, m.ragRelPath), 'text/markdown');
  }

  console.log('\nRunning D1 insert…');
  runWrangler(['d1', 'execute', 'ashebrook-hoa', '--remote', '--file', SQL]);
  console.log(
    `\nDone. ${entries.length} documents imported (${indexed} indexed).`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  void main();
