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

/**
 * Documents the corpus build left out ON PURPOSE, which must never be OCR'd
 * back in (#278).
 *
 * `rag_status` was carrying two different questions: "could this be converted"
 * and "should this be in the index". Fifteen documents have no `rag/<id>.md`
 * twin, and none of them is a failed conversion — fourteen are preliminary
 * monthly financial reports superseded by the final board copies, and one is
 * an image-only RTF that the `application/pdf` rule below already refuses. So
 * only the fourteen need naming here.
 *
 * Why this list exists rather than nothing: marking those rows
 * `rag_status = 'unsupported'` is otherwise a reasonable thing to do, because
 * it earns them an accurate "Not searchable" badge in the admin Documents
 * panel. Before this list, that reasonable act silently made the superseded
 * financials the default candidate set for `npm run ocr:scanned --commit`.
 * That is why the badge backfill was declined on 2026-08-30 and `rag_status`
 * stays NULL corpus-wide.
 *
 * The full breakdown of which documents these are, and why each was excluded,
 * is in the private ops record; only opaque ids live here.
 */
export const OCR_EXCLUDED_DOCUMENT_IDS: ReadonlySet<string> = new Set([
  'f769f3fa-7748-4779-9956-1e972841c871',
  'cccb12c8-731e-4c81-9d7d-dc6b8e880bc4',
  'aa2dee19-40e8-4064-9414-84adde80a38c',
  '8e77cb42-512e-482a-967b-9464415854a2',
  '3676ed0b-40f2-476c-8ead-a45d4b7b9fb1',
  'bfa29777-2ef8-443b-8293-c85010824282',
  '43da9217-ba6a-4cc9-8753-65056aabdee2',
  'dea94482-6e15-4167-97b2-6a0769c9664d',
  '941068e8-e775-488e-92f8-af36d7477aac',
  '8f0ae94b-445a-4783-b778-4cbb46709af7',
  '38865ef9-114c-40f1-987e-4b809e6389b4',
  '0338a0fa-b7c3-4937-b51d-7151f8582299',
  'f5bfe628-34b0-460d-98dd-bb76bd33e720',
  '9f16685b-8d69-48f9-8600-a040733ed07d',
]);

export interface OcrCandidateOptions {
  /**
   * Restrict candidates to these ids — the `--only=` flag. An absent or empty
   * set means "no explicit scope", never "nothing qualifies", so the default
   * run is unchanged.
   */
  onlyIds?: ReadonlySet<string>;
}

/**
 * A document is an OCR candidate iff its twin failed (unsupported), it is a
 * PDF, it is not deliberately excluded, and it is within any explicit scope.
 *
 * The exclusion is checked HERE rather than in the caller's SQL so that it
 * cannot be forgotten by a future caller, and so it is testable without D1.
 * `--only=` deliberately cannot widen it: scoping a run is an operator
 * convenience, while the exclusion is a decision about the corpus.
 */
export function isOcrCandidate(
  row: DocRow,
  options: OcrCandidateOptions = {},
): boolean {
  if (OCR_EXCLUDED_DOCUMENT_IDS.has(row.id)) return false;
  const only = options.onlyIds;
  if (only && only.size > 0 && !only.has(row.id)) return false;
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
