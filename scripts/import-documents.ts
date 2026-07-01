import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { pathToDocMeta } from './doc-tiers';

export interface DocumentEntry {
  id: string;
  relativePath: string;
  filename: string;
  title: string;
  category: string;
  visibility: string;
  r2Key: string;
  sizeBytes: number;
  contentType: string;
}

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.msg': 'application/vnd.ms-outlook',
  '.zip': 'application/zip',
  '.rtf': 'application/rtf',
};

export function contentTypeFor(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const ext = dot === -1 ? '' : filename.slice(dot).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

export function buildInsertSql(entries: DocumentEntry[]): string {
  const now = Math.floor(Date.now() / 1000);
  const cols =
    'id, title, category, visibility, r2_key, filename, size_bytes, content_type, uploaded_at, updated_at';
  const values = entries
    .map(
      (e) =>
        `(${sqlStr(e.id)}, ${sqlStr(e.title)}, ${sqlStr(e.category)}, ${sqlStr(e.visibility)}, ${sqlStr(e.r2Key)}, ${sqlStr(e.filename)}, ${e.sizeBytes}, ${sqlStr(e.contentType)}, ${now}, ${now})`,
    )
    .join(',\n');
  return `INSERT INTO documents (${cols}) VALUES\n${values};\n`;
}

async function walkDirectory(dir: string): Promise<string[]> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const files: string[] = [];

  async function walk(currentPath: string, baseDir: string): Promise<void> {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(baseDir, fullPath);
      if (entry.isDirectory()) {
        await walk(fullPath, baseDir);
      } else {
        files.push(relativePath);
      }
    }
  }

  await walk(dir, dir);
  return files;
}

async function main() {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const commit = process.argv.includes('--commit');
  const sourceDir = 'private/HOA_files';

  if (!fs.existsSync(sourceDir)) {
    console.error(`Error: source directory ${sourceDir} does not exist`);
    process.exit(1);
  }

  const files = await walkDirectory(sourceDir);
  const entries: DocumentEntry[] = [];

  for (const relativePath of files) {
    const fullPath = path.join(sourceDir, relativePath);
    const stats = fs.statSync(fullPath);
    if (!stats.isFile()) continue;

    const filename = path.basename(relativePath);
    const safeName = filename.replace(/[^\w.\-]/g, '_');
    const id = crypto.randomUUID();
    const r2Key = `documents/${id}/${safeName}`;
    const { visibility, category } = pathToDocMeta(relativePath);
    const title = filename.replace(/\.[^.]+$/, '');
    const sizeBytes = stats.size;
    const contentType = contentTypeFor(filename);

    entries.push({
      id,
      relativePath,
      filename,
      title,
      category,
      visibility,
      r2Key,
      sizeBytes,
      contentType,
    });
  }

  // Always write the manifest and SQL regardless of mode.
  const manifestPath = 'private/documents-manifest.json';
  fs.writeFileSync(manifestPath, JSON.stringify(entries, null, 2));

  const sqlPath = 'private/documents-import.sql';
  fs.writeFileSync(sqlPath, buildInsertSql(entries));

  console.log(
    `Processed ${entries.length} documents. Manifest written to ${manifestPath}, SQL to ${sqlPath}.`,
  );

  if (!commit) {
    console.log(
      `\nReview ${manifestPath} (especially the board/homeowner tiers), then re-run with \`-- --commit\` to upload.`,
    );
    return;
  }

  // Commit phase: upload each file to R2, then run the D1 insert.
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const total = entries.length;

  for (let i = 0; i < total; i++) {
    const entry = entries[i];
    const fullPath = path.resolve(sourceDir, entry.relativePath);
    console.log(
      `[${i + 1}/${total}] Uploading ${entry.filename} → ${entry.r2Key}`,
    );
    execFileSync(
      npx,
      [
        'wrangler',
        'r2',
        'object',
        'put',
        `ashebrook-hoa-docs/${entry.r2Key}`,
        '--file',
        fullPath,
        '--remote',
        '--content-type',
        entry.contentType,
      ],
      { stdio: 'inherit' },
    );
  }

  console.log(`\nAll ${total} files uploaded. Running D1 insert...`);
  execFileSync(
    npx,
    [
      'wrangler',
      'd1',
      'execute',
      'ashebrook-hoa',
      '--remote',
      '--file',
      sqlPath,
    ],
    { stdio: 'inherit' },
  );

  console.log(`\nDone. ${total} documents imported.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  void main();
