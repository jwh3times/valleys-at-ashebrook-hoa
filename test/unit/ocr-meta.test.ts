import { describe, it, expect } from 'vitest';
import {
  isOcrCandidate,
  transcriptionPrompt,
  assembleMarkdown,
  isUsableOcr,
  parseOcrResponse,
  ragKeyFor,
  MIN_OCR_CHARS,
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
