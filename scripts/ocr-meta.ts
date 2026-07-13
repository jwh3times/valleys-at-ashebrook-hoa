// Pure, unit-tested helpers for the offline scanned-PDF OCR job
// (scripts/ocr-scanned.ts). Everything deterministic lives here; the I/O
// orchestration (wrangler, pdf rasterization, Workers AI REST) lives in the
// orchestration script.
export { ragKeyFor } from './corpus-import-meta.ts';

// Workers AI vision model used for OCR. Isolated so it is a one-line swap if
// accuracy on real scans disappoints.
export const OCR_MODEL = '@cf/moondream/moondream3.1-9B-A2B';
// Pages render at this DPI before OCR — enough for text, bounded size.
export const RENDER_DPI = 180;
// Minimum trimmed characters of transcribed text to accept a twin. Below this
// the scan is treated as unreadable and left 'unsupported' rather than writing
// a garbage twin.
export const MIN_OCR_CHARS = 40;

export interface DocRow {
  id: string;
  r2Key: string;
  filename: string;
  contentType: string;
  ragStatus: string | null;
}

/** A document is an OCR candidate iff its twin failed (unsupported) and it is a PDF. */
export function isOcrCandidate(row: DocRow): boolean {
  return (
    row.ragStatus === 'unsupported' && row.contentType === 'application/pdf'
  );
}

/** The transcription instruction sent with each page image. */
export function transcriptionPrompt(): string {
  return [
    'Transcribe all text in this document image exactly as written, preserving',
    'reading order and line breaks. Do not summarize, translate, or add commentary.',
    'Output only the transcribed text. If there is no readable text, output nothing.',
  ].join(' ');
}

/** Join per-page transcriptions into one Markdown string with page markers. */
export function assembleMarkdown(pageTexts: string[]): string {
  return pageTexts
    .map((t, i) => `## Page ${i + 1}\n\n${t.trim()}`)
    .join('\n\n')
    .trim();
}

/** Usable only if the transcribed content (NOT the page headers) clears the gate. */
export function isUsableOcr(pageTexts: string[]): boolean {
  const content = pageTexts.join(' ').replace(/\s+/g, ' ').trim();
  return content.length >= MIN_OCR_CHARS;
}

/**
 * Pull the transcribed text out of a Workers AI REST `ai/run` response. The
 * envelope is `{ result, success, errors }`; vision models have returned the
 * text under `result.response`, `result.description`, or `result` as a string.
 * Returns '' if none is present (→ treated as unusable). VERIFY the exact field
 * on the first `--sample` run and adjust here — this is the single isolation point.
 */
export function parseOcrResponse(json: unknown): string {
  const result = (json as { result?: unknown } | null)?.result;
  if (typeof result === 'string') return result;
  const r = result as
    { response?: unknown; description?: unknown; text?: unknown } | undefined;
  for (const v of [r?.response, r?.description, r?.text]) {
    if (typeof v === 'string') return v;
  }
  return '';
}
