import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  sha256Hex,
  groupExact,
  groupNear,
  autoResolvableExact,
  type DocLike,
  type DupeGroup,
} from '../src/server/content/dedupe.ts';
import type { DocumentEntry } from './import-documents.ts';

function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

export function buildHashUpdateSql(
  rows: { id: string; contentHash: string }[],
): string {
  return (
    rows
      .map(
        (r) =>
          `UPDATE documents SET content_hash = ${sqlStr(r.contentHash)} WHERE id = ${sqlStr(r.id)};`,
      )
      .join('\n') + '\n'
  );
}

export function planExactDeletions(
  groups: DupeGroup[],
): { keepId: string; deleteIds: string[] }[] {
  return groups
    .map(autoResolvableExact)
    .filter(
      (x): x is { keepId: string; deleteIds: string[] } =>
        x !== null && x.deleteIds.length > 0,
    );
}

async function main() {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const commit = process.argv.includes('--commit');
  const sourceDir = 'private/HOA_files';
  const manifestPath = 'private/documents-manifest.json';

  if (!fs.existsSync(manifestPath)) {
    console.error(
      `Error: ${manifestPath} not found. Run \`npm run docs:import\` first.`,
    );
    process.exit(1);
  }

  const entries = JSON.parse(
    fs.readFileSync(manifestPath, 'utf8'),
  ) as DocumentEntry[];

  const docs: DocLike[] = [];
  const hashRows: { id: string; contentHash: string }[] = [];
  for (const e of entries) {
    const full = path.join(sourceDir, e.relativePath);
    if (!fs.existsSync(full)) {
      console.warn(`Skipping (missing on disk): ${e.relativePath}`);
      continue;
    }
    const contentHash = await sha256Hex(fs.readFileSync(full));
    hashRows.push({ id: e.id, contentHash });
    docs.push({
      id: e.id,
      title: e.title,
      filename: e.filename,
      sizeBytes: e.sizeBytes,
      contentType: e.contentType,
      visibility: e.visibility as DocLike['visibility'],
      category: e.category,
      contentHash,
    });
  }

  const exact = groupExact(docs);
  const near = groupNear(docs);
  const deletions = planExactDeletions(exact);
  const deletedIds = new Set(deletions.flatMap((d) => d.deleteIds));

  const reportPath = 'private/dedupe-report.json';
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        exactGroups: exact.length,
        nearGroups: near.length,
        autoDeletable: [...deletedIds],
        crossTierExact: exact
          .filter((g) => autoResolvableExact(g) === null)
          .map((g) => g.members.map((m) => m.filename)),
        exact,
        near,
      },
      null,
      2,
    ),
  );

  console.log(
    `Hashed ${docs.length} files. Exact groups: ${exact.length}, near groups: ${near.length}. ` +
      `${deletedIds.size} files auto-deletable (same-tier exact). Report: ${reportPath}.`,
  );

  if (!commit) {
    console.log(
      `\nReview ${reportPath}, then re-run with \`-- --commit\` to write hashes and delete same-tier exact duplicates.`,
    );
    return;
  }

  const nodeRequire = createRequire(import.meta.url);
  const wranglerBin = path.join(
    path.dirname(nodeRequire.resolve('wrangler/package.json')),
    'bin',
    'wrangler.js',
  );
  const runWrangler = (args: string[]) =>
    execFileSync(process.execPath, [wranglerBin, ...args], {
      stdio: 'inherit',
    });

  const hashSqlPath = 'private/dedupe-hashes.sql';
  fs.writeFileSync(hashSqlPath, buildHashUpdateSql(hashRows));
  console.log('Writing content hashes to D1...');
  runWrangler([
    'd1',
    'execute',
    'ashebrook-hoa',
    '--remote',
    '--file',
    hashSqlPath,
  ]);

  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const id of deletedIds) {
    const entry = byId.get(id);
    if (!entry) continue;
    console.log(`Deleting R2 object for ${entry.filename} (${id})`);
    runWrangler([
      'r2',
      'object',
      'delete',
      `ashebrook-hoa-docs/${entry.r2Key}`,
      '--remote',
    ]);
  }

  if (deletedIds.size > 0) {
    const ids = [...deletedIds].map((id) => sqlStr(id)).join(', ');
    const delSqlPath = 'private/dedupe-delete.sql';
    fs.writeFileSync(
      delSqlPath,
      `DELETE FROM documents WHERE id IN (${ids});\n`,
    );
    console.log('Deleting duplicate rows from D1...');
    runWrangler([
      'd1',
      'execute',
      'ashebrook-hoa',
      '--remote',
      '--file',
      delSqlPath,
    ]);
  }

  console.log(
    `\nDone. Wrote ${hashRows.length} hashes; deleted ${deletedIds.size} same-tier exact duplicates. ` +
      `Cross-tier exact groups and near-duplicates remain for review in the admin Duplicates panel.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  void main();
