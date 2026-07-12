// Best-effort RAG Markdown twin for a freshly uploaded document (ADR 0009 §1).
// Never throws: anything that cannot be turned into usable text returns
// { markdown: null, status: 'unsupported' } so the upload can proceed and the
// document is flagged "not searchable". A successful twin is written to
// rag/<id>.md by the caller and indexed at the next AI Search sync.

// Below this many trimmed characters a conversion is treated as unusable
// (e.g. a scanned/image-only PDF that yields ~nothing).
const MIN_TWIN_CHARS = 16;

// Text-native uploads are already searchable text — use the bytes directly.
const TEXT_NATIVE = new Set(['md', 'txt', 'csv']);
// Binary formats Workers AI can convert to Markdown.
const CONVERTIBLE = new Set(['pdf', 'docx', 'xls', 'xlsx', 'doc']);
// Must stay in sync with the upload allowlist EXT_TO_TYPE in
// src/pages/api/admin/documents.ts — adding an extension there without adding
// it to one of these sets silently marks that upload's twin "unsupported".

export interface TwinInput {
  filename: string;
  contentType: string;
  bytes: ArrayBuffer;
}
export interface TwinResult {
  markdown: string | null;
  status: 'ok' | 'unsupported';
}

function extOf(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

function usable(text: string): TwinResult {
  return text.trim().length >= MIN_TWIN_CHARS
    ? { markdown: text, status: 'ok' }
    : { markdown: null, status: 'unsupported' };
}

export async function generateTwin(
  env: Env,
  input: TwinInput,
): Promise<TwinResult> {
  const ext = extOf(input.filename);
  try {
    if (TEXT_NATIVE.has(ext)) {
      return usable(new TextDecoder().decode(input.bytes));
    }
    if (CONVERTIBLE.has(ext)) {
      const blob = new Blob([input.bytes], { type: input.contentType });
      const results = await env.AI.toMarkdown([{ name: input.filename, blob }]);
      const md = results?.[0];
      // Surface an unexpected response shape (e.g. a Workers AI change so
      // `format` no longer holds 'markdown'/'error') — otherwise every binary
      // would silently become "unsupported" with no trace. Log the KEYS only,
      // never document text.
      if (md && md.format !== 'markdown' && md.format !== 'error') {
        console.warn(
          '[twin] unexpected toMarkdown result shape — keys:',
          Object.keys(md),
        );
      }
      const data = md?.format === 'markdown' ? (md.data ?? '') : '';
      return usable(data);
    }
    return { markdown: null, status: 'unsupported' };
  } catch (err) {
    // A thrown error (transient Workers AI outage, malformed input) is
    // indistinguishable downstream from a genuinely unconvertible file — both
    // yield 'unsupported' and drive the board-facing "Not searchable" badge.
    // Log the extension + message only (never the filename or document bytes)
    // so an outage is diagnosable from Workers logs.
    console.warn(
      `[twin] conversion failed for .${ext}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { markdown: null, status: 'unsupported' };
  }
}
