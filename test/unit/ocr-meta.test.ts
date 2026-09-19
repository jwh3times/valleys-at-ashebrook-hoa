import { describe, it, expect } from 'vitest';
import {
  isOcrCandidate,
  transcriptionPrompt,
  assembleMarkdown,
  isUsableOcr,
  parseOcrResponse,
  ragKeyFor,
  MIN_OCR_CHARS,
  OCR_EXCLUDED_DOCUMENT_IDS,
  type DocRow,
} from '../../scripts/ocr-meta.ts';

const row = (over: Partial<DocRow> = {}): DocRow => ({
  id: 'd1',
  r2Key: 'documents/d1/scan.pdf',
  filename: 'scan.pdf',
  contentType: 'application/pdf',
  ragStatus: 'unsupported',
  ...over,
});

describe('ocr-meta', () => {
  it('selects only unsupported PDFs as OCR candidates', () => {
    expect(isOcrCandidate(row())).toBe(true);
    expect(isOcrCandidate(row({ ragStatus: 'ok' }))).toBe(false);
    expect(isOcrCandidate(row({ ragStatus: null }))).toBe(false);
    expect(isOcrCandidate(row({ contentType: 'application/msword' }))).toBe(
      false,
    );
  });

  it('never selects a deliberately excluded document, whatever its status', () => {
    // #278: `rag_status = 'unsupported'` was being read as "should be OCR'd".
    // These rows have no twin because the corpus build left them out on
    // purpose, not because a conversion failed, so a later status backfill
    // must not quietly enlist them.
    const excluded = [...OCR_EXCLUDED_DOCUMENT_IDS][0];
    expect(isOcrCandidate(row({ id: excluded }))).toBe(false);
    // The same row would otherwise qualify on every other test.
    expect(isOcrCandidate(row({ id: 'not-excluded' }))).toBe(true);
  });

  it('excludes every superseded preliminary financial report', () => {
    // The 14 PDFs are the whole hazard: the 15th twin-less document is an RTF,
    // which the content-type rule already refuses.
    expect(OCR_EXCLUDED_DOCUMENT_IDS.size).toBe(14);
    for (const id of OCR_EXCLUDED_DOCUMENT_IDS) {
      expect(isOcrCandidate(row({ id }))).toBe(false);
    }
  });

  it('scopes candidates to an explicit id set when one is given', () => {
    // `--only=` is the operator's scoping tool; an empty or absent set means
    // "no explicit scope", not "nothing qualifies".
    expect(isOcrCandidate(row({ id: 'a' }), { onlyIds: new Set(['a']) })).toBe(
      true,
    );
    expect(isOcrCandidate(row({ id: 'b' }), { onlyIds: new Set(['a']) })).toBe(
      false,
    );
    expect(isOcrCandidate(row({ id: 'b' }), { onlyIds: new Set() })).toBe(true);
  });

  it('will not let --only override a deliberate exclusion', () => {
    const excluded = [...OCR_EXCLUDED_DOCUMENT_IDS][0];
    expect(
      isOcrCandidate(row({ id: excluded }), {
        onlyIds: new Set([excluded]),
      }),
    ).toBe(false);
  });

  it('assembles per-page text into page-marked markdown', () => {
    const md = assembleMarkdown(['First page text.', 'Second page text.']);
    expect(md).toContain('## Page 1');
    expect(md).toContain('First page text.');
    expect(md).toContain('## Page 2');
    expect(md).toContain('Second page text.');
  });

  it('gates usability on transcribed content, not the page headers', () => {
    // A blank scan yields empty page text; even though assembleMarkdown emits
    // "## Page N" headers, the gate must reject it (no garbage twin).
    expect(isUsableOcr(['', '  ', '\n'])).toBe(false);
    expect(isUsableOcr(['short'])).toBe(false);
    expect(isUsableOcr(['x'.repeat(MIN_OCR_CHARS)])).toBe(true);
  });

  it('extracts text from the Workers AI response, empty when absent', () => {
    expect(
      parseOcrResponse({
        result: { response: 'transcribed text' },
        success: true,
      }),
    ).toBe('transcribed text');
    expect(parseOcrResponse({ result: { description: 'alt field' } })).toBe(
      'alt field',
    );
    expect(parseOcrResponse({ result: {} })).toBe('');
    expect(parseOcrResponse(null)).toBe('');
  });

  it('builds a transcription prompt and the rag key', () => {
    expect(transcriptionPrompt().toLowerCase()).toContain('transcribe');
    expect(ragKeyFor('d1')).toBe('rag/d1.md');
  });
});
