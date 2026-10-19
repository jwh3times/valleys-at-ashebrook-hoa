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
import { ragKeyFor } from './corpus-import-meta.ts';
import { resolvePrivatePath } from './private-root.ts';

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

/**
 * What removing the duplicates `deleteIds` takes: one statement deleting their
 * rows, then each one's original and search twin (#442). The rows go first,
 * as in the app's own delete: if D1 refuses them (a recorded change cites one
 * as evidence), nothing has been removed from R2.
 */
export function planDuplicateRemoval(
  entries: DocumentEntry[],
  deleteIds: string[],
): { deleteRowsSql: string | null; r2Keys: string[] } {
  if (deleteIds.length === 0) return { deleteRowsSql: null, r2Keys: [] };
  const byId = new Map(entries.map((e) => [e.id, e]));
  return {
    deleteRowsSql: `DELETE FROM documents WHERE id IN (${deleteIds.map(sqlStr).join(', ')});\n`,
    // An id missing from the manifest still loses its twin; its original is
    // left for the R2 orphan sweep, since only the manifest knows its key.
    r2Keys: deleteIds.flatMap((id) => {
      const entry = byId.get(id);
      return entry ? [entry.r2Key, ragKeyFor(id)] : [ragKeyFor(id)];
    }),
  };
}

async function main() {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const commit = process.argv.includes('--commit');
  const sourceDir = resolvePrivatePath(['HOA_files']);
  const manifestPath = resolvePrivatePath(['documents-manifest.json']);

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

  const reportPath = resolvePrivatePath(['dedupe-report.json']);
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

  const hashSqlPath = resolvePrivatePath(['dedupe-hashes.sql']);
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

  const removal = planDuplicateRemoval(entries, [...deletedIds]);
  if (removal.deleteRowsSql) {
    const delSqlPath = resolvePrivatePath(['dedupe-delete.sql']);
    fs.writeFileSync(delSqlPath, removal.deleteRowsSql);
    console.log('Deleting duplicate rows from D1...');
    try {
      runWrangler([
        'd1',
        'execute',
        'ashebrook-hoa',
        '--remote',
        '--file',
        delSqlPath,
      ]);
    } catch (err) {
      console.error(
        'D1 refused the delete, so nothing was removed from R2. A recorded change may cite one of these documents as evidence; resolve it in /admin -> Duplicates instead.',
      );
      throw err;
    }
  }
  for (const key of removal.r2Keys) {
    console.log(`Deleting R2 object ${key}`);
    runWrangler([
      'r2',
      'object',
      'delete',
      `ashebrook-hoa-docs/${key}`,
      '--remote',
    ]);
  }

  console.log(
    `\nDone. Wrote ${hashRows.length} hashes; deleted ${deletedIds.size} same-tier exact duplicates. ` +
      `Cross-tier exact groups and near-duplicates remain for review in the admin Duplicates panel.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  void main();
