import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createCanvas } from '@napi-rs/canvas';
import {
  OCR_MODEL,
  RENDER_DPI,
  ragKeyFor,
  isOcrCandidate,
  transcriptionPrompt,
  assembleMarkdown,
  isUsableOcr,
  parseOcrResponse,
  type DocRow,
} from './ocr-meta.ts';

const D1 = 'ashebrook-hoa';
const BUCKET = 'ashebrook-hoa-docs';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? '';

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

/** Unsupported PDFs from remote D1, filtered through the shared candidate rule. */
function candidates(): DocRow[] {
  const out = runWranglerJson([
    'd1',
    'execute',
    D1,
    '--remote',
    '--json',
    '--command',
    "SELECT id, r2_key, filename, content_type, rag_status FROM documents WHERE rag_status = 'unsupported' AND content_type = 'application/pdf'",
  ]);
  const rows: Record<string, unknown>[] = JSON.parse(out)[0]?.results ?? [];
  return rows
    .map((r) => ({
      id: String(r.id),
      r2Key: String(r.r2_key),
      filename: String(r.filename),
      contentType: String(r.content_type),
      ragStatus: (r.rag_status as string | null) ?? null,
    }))
    .filter(isOcrCandidate);
}

function getPdf(row: DocRow): Buffer {
  const tmp = path.join(os.tmpdir(), `ocr-${row.id}.pdf`);
  runWrangler([
    'r2',
    'object',
    'get',
    `${BUCKET}/${row.r2Key}`,
    '--file',
    tmp,
    '--remote',
  ]);
  const bytes = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  return bytes;
}

/** Render each PDF page to a PNG buffer. VERIFY on first --sample run: pdfjs-dist
 * legacy build + @napi-rs/canvas is the known-working Node combo, but the exact
 * render() canvas wiring is version-sensitive — this is the isolation point. */
async function rasterize(pdfBytes: Buffer): Promise<Buffer[]> {
  const pdfjs =
    (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
      getDocument: (o: unknown) => { promise: Promise<any> };
    };
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes) })
    .promise;
  const pages: Buffer[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: RENDER_DPI / 72 });
    const canvas = createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx as unknown, viewport }).promise;
    pages.push(canvas.toBuffer('image/png'));
  }
  return pages;
}

/** OCR one page image via Workers AI REST. VERIFY on first --sample run: the
 * vision input shape (`image` as a byte array + `prompt` is the common form);
 * parseOcrResponse isolates the response read. */
async function ocrPage(png: Buffer, attempt = 0): Promise<string> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${OCR_MODEL}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image: [...new Uint8Array(png)],
        prompt: transcriptionPrompt(),
      }),
    },
  );
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return ocrPage(png, attempt + 1);
  }
  if (!res.ok) throw new Error(`Workers AI ${res.status}: ${await res.text()}`);
  return parseOcrResponse(await res.json());
}

async function ocrDoc(
  row: DocRow,
): Promise<{ markdown: string; usable: boolean; pages: number }> {
  const images = await rasterize(getPdf(row));
  const texts: string[] = [];
  for (let i = 0; i < images.length; i++) {
    process.stdout.write(`    page ${i + 1}/${images.length}\r`);
    texts.push(await ocrPage(images[i]));
  }
  return {
    markdown: assembleMarkdown(texts),
    usable: isUsableOcr(texts),
    pages: images.length,
  };
}

async function main() {
  const commit = process.argv.includes('--commit');
  const sample = process.argv.includes('--sample');
  const limArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limArg ? Number(limArg.split('=')[1]) : Infinity;

  const rows = candidates();
  console.log(`${rows.length} scanned/unsupported PDF candidate(s).`);

  if (!commit && !sample) {
    for (const r of rows) console.log(`  ${r.id}  ${r.filename}`);
    console.log(
      `\nDry run. Add \`--sample\` to OCR one and preview, or \`--commit\` to write twins.`,
    );
    return;
  }
  if (!ACCOUNT_ID || !API_TOKEN) {
    console.error(
      'Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI Run + R2 + D1 read/write; wrangler inherits it).',
    );
    process.exit(1);
  }

  if (sample) {
    const r = rows[0];
    if (!r) return console.log('No candidates to sample.');
    console.log(`\nSampling ${r.filename} (${r.id})…`);
    const { markdown, usable, pages } = await ocrDoc(r);
    console.log(
      `\n--- ${pages} page(s), usable=${usable} ---\n${markdown}\n---`,
    );
    console.log('\nSample only — nothing written.');
    return;
  }

  let done = 0;
  for (const r of rows.slice(0, limit)) {
    console.log(`\n[${done + 1}] ${r.filename} (${r.id})`);
    const { markdown, usable, pages } = await ocrDoc(r);
    if (!usable) {
      console.log(`  ${pages} page(s): no usable text — left 'unsupported'.`);
      continue;
    }
    const twin = path.join(os.tmpdir(), `ocr-${r.id}.md`);
    fs.writeFileSync(twin, markdown);
    runWrangler([
      'r2',
      'object',
      'put',
      `${BUCKET}/${ragKeyFor(r.id)}`,
      '--file',
      twin,
      '--remote',
      '--content-type',
      'text/markdown',
    ]);
    fs.rmSync(twin, { force: true });
    // r.id is our own crypto.randomUUID() (no quotes possible) — safe to inline.
    runWrangler([
      'd1',
      'execute',
      D1,
      '--remote',
      '--command',
      `UPDATE documents SET rag_status = 'ok' WHERE id = '${r.id}'`,
    ]);
    console.log(`  ${pages} page(s): twin written, rag_status → 'ok'.`);
    done++;
  }
  console.log(
    `\nDone. ${done} document(s) made searchable (searchable at the next AI Search sync).`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  void main();
