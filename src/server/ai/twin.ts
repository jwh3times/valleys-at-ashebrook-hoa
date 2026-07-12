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
      const data = md?.format === 'markdown' ? (md.data ?? '') : '';
      return usable(data);
    }
    return { markdown: null, status: 'unsupported' };
  } catch {
    return { markdown: null, status: 'unsupported' };
  }
}
