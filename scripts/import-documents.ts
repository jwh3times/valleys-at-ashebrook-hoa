import { fileURLToPath } from 'node:url';
import { pathToDocMeta } from './doc-tiers';

export interface DocumentManifestEntry {
  filename: string;
  relativePath: string;
  visibility: string;
  category: string;
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

  const sourceDir = 'private/HOA_files';

  if (!fs.existsSync(sourceDir)) {
    console.error(`Error: source directory ${sourceDir} does not exist`);
    process.exit(1);
  }

  const files = await walkDirectory(sourceDir);
  const manifest: DocumentManifestEntry[] = [];

  for (const file of files) {
    const fullPath = path.join(sourceDir, file);
    const stats = fs.statSync(fullPath);
    if (stats.isFile()) {
      const meta = pathToDocMeta(file);
      manifest.push({
        filename: path.basename(file),
        relativePath: file,
        visibility: meta.visibility,
        category: meta.category,
      });
    }
  }

  // Write manifest for review
  const manifestPath = 'private/documents-manifest.json';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(
    `Processed ${manifest.length} documents. Manifest written to ${manifestPath}.`,
  );
  console.log(
    'To upload to R2 and insert rows, run with Worker bindings configured.',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  void main();
