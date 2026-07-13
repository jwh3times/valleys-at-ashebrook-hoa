import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateTwin } from '../../src/server/ai/twin';

function fakeEnv(toMarkdown: (files: unknown) => Promise<unknown>): Env {
  return { AI: { toMarkdown } } as unknown as Env;
}
const enc = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer as ArrayBuffer;

describe('generateTwin', () => {
  // Suppress diagnostic logging so test output stays pristine; individual cases
  // re-read `console.warn` (the spy) to assert on the error/shape paths.
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses a text-native file (.md) directly as the twin, with no AI call', async () => {
    const env = fakeEnv(async () => {
      throw new Error('toMarkdown should not be called for text-native files');
    });
    const out = await generateTwin(env, {
      filename: 'notes.md',
      contentType: 'text/markdown',
      bytes: enc('# Bylaws\nSection 1 covers assessments.'),
    });
    expect(out.status).toBe('ok');
    expect(out.markdown).toContain('# Bylaws');
  });

  it('converts a binary file via env.AI.toMarkdown', async () => {
    const toMarkdown = vi.fn(async () => [
      {
        name: 'b.pdf',
        format: 'markdown',
        data: '# Bylaws\nReal extracted text.',
      },
    ]);
    const out = await generateTwin(fakeEnv(toMarkdown), {
      filename: 'b.pdf',
      contentType: 'application/pdf',
      bytes: enc('%PDF-1.4 ...'),
    });
    expect(toMarkdown).toHaveBeenCalledTimes(1);
    expect(out.status).toBe('ok');
    expect(out.markdown).toContain('Real extracted text');
  });

  it('flags an errored or ~empty conversion as unsupported (no twin)', async () => {
    const errored = fakeEnv(async () => [
      { name: 's.pdf', format: 'error', error: 'no text layer' },
    ]);
    expect(
      await generateTwin(errored, {
        filename: 's.pdf',
        contentType: 'application/pdf',
        bytes: enc('scan'),
      }),
    ).toEqual({ markdown: null, status: 'unsupported' });

    const empty = fakeEnv(async () => [
      { name: 's.pdf', format: 'markdown', data: '   ' },
    ]);
    expect(
      await generateTwin(empty, {
        filename: 's.pdf',
        contentType: 'application/pdf',
        bytes: enc('scan'),
      }),
    ).toEqual({ markdown: null, status: 'unsupported' });
  });

  it('flags a metadata-only conversion (image-only scan) as unsupported', async () => {
    // Workers AI toMarkdown emits a fixed envelope (# title / ## Metadata / …
    // / ## Contents / ### Page N) for EVERY PDF, even when it extracts no page
    // text. This is the real shape returned for an image-only scan — ~300 chars
    // of boilerplate but zero extracted content. The quality gate must measure
    // the extracted content, not the envelope, or every scan is misclassified
    // 'ok' (searchable) and never gets the "Not searchable" badge or OCR pickup.
    const metadataOnly = [
      '# MeredithDonations2021.pdf',
      '## Metadata',
      '- PDFFormatVersion=1.4',
      '- IsLinearized=false',
      '- IsAcroFormPresent=false',
      '- Producer=iText® 5.4.4 ©2000-2013 1T3XT BVBA (AGPL-version)',
      '- ModDate=D:20220207185353Z',
      '- CreationDate=D:20220207185353Z',
      '',
      '',
      '## Contents',
      '### Page 1',
      '',
    ].join('\n');
    const env = fakeEnv(async () => [
      { name: 's.pdf', format: 'markdown', data: metadataOnly },
    ]);
    const out = await generateTwin(env, {
      filename: 's.pdf',
      contentType: 'application/pdf',
      bytes: enc('%PDF-1.4 <image-only scan>'),
    });
    expect(out).toEqual({ markdown: null, status: 'unsupported' });
  });

  it('keeps a conversion with real page text under the metadata envelope', async () => {
    // Same envelope, but Page 1 has extracted prose — must stay searchable.
    const withContent = [
      '# bylaws.pdf',
      '## Metadata',
      '- PDFFormatVersion=1.4',
      '- Producer=iText® 5.4.4',
      '',
      '## Contents',
      '### Page 1',
      'Section 1 covers annual assessments and the reserve fund.',
    ].join('\n');
    const env = fakeEnv(async () => [
      { name: 'b.pdf', format: 'markdown', data: withContent },
    ]);
    const out = await generateTwin(env, {
      filename: 'b.pdf',
      contentType: 'application/pdf',
      bytes: enc('%PDF-1.4 ...'),
    });
    expect(out.status).toBe('ok');
    expect(out.markdown).toContain('annual assessments');
    // The stored twin keeps the full markdown, metadata envelope included —
    // only the searchability GATE ignores it, not what we persist/index.
    expect(out.markdown).toContain('Producer');
  });

  it('treats a metadata block that runs to EOF (no ## Contents) as unsupported', async () => {
    const metadataToEof = [
      '# s.pdf',
      '## Metadata',
      '- PDFFormatVersion=1.4',
      '- Producer=Some Scanner',
      '- CreationDate=D:20220207185353Z',
    ].join('\n');
    const env = fakeEnv(async () => [
      { name: 's.pdf', format: 'markdown', data: metadataToEof },
    ]);
    const out = await generateTwin(env, {
      filename: 's.pdf',
      contentType: 'application/pdf',
      bytes: enc('%PDF-1.4 <scan>'),
    });
    expect(out).toEqual({ markdown: null, status: 'unsupported' });
  });

  it('handles CRLF line endings in the metadata envelope', async () => {
    const crlf =
      '# s.pdf\r\n## Metadata\r\n- Producer=x\r\n\r\n## Contents\r\n### Page 1\r\n';
    const env = fakeEnv(async () => [
      { name: 's.pdf', format: 'markdown', data: crlf },
    ]);
    const out = await generateTwin(env, {
      filename: 's.pdf',
      contentType: 'application/pdf',
      bytes: enc('%PDF-1.4 <scan>'),
    });
    expect(out).toEqual({ markdown: null, status: 'unsupported' });
  });

  it('keeps text on a later page when an earlier page is empty', async () => {
    const multiPage = [
      '# b.pdf',
      '## Metadata',
      '- Producer=x',
      '## Contents',
      '### Page 1',
      '',
      '### Page 2',
      'The reserve study was completed in 2024 and is on file.',
    ].join('\n');
    const env = fakeEnv(async () => [
      { name: 'b.pdf', format: 'markdown', data: multiPage },
    ]);
    const out = await generateTwin(env, {
      filename: 'b.pdf',
      contentType: 'application/pdf',
      bytes: enc('%PDF-1.4 ...'),
    });
    expect(out.status).toBe('ok');
    expect(out.markdown).toContain('reserve study');
  });

  it('keeps a plain conversion that has no envelope or headings at all', async () => {
    const env = fakeEnv(async () => [
      {
        name: 'b.docx',
        format: 'markdown',
        data: 'The board approved the 2025 budget at the March meeting.',
      },
    ]);
    const out = await generateTwin(env, {
      filename: 'b.docx',
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: enc('PK ...'),
    });
    expect(out.status).toBe('ok');
    expect(out.markdown).toContain('2025 budget');
  });

  it('never throws — a toMarkdown failure returns unsupported and is logged', async () => {
    const env = fakeEnv(async () => {
      throw new Error('AI unavailable');
    });
    const out = await generateTwin(env, {
      filename: 'b.docx',
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: enc('PK ...'),
    });
    expect(out).toEqual({ markdown: null, status: 'unsupported' });
    // The transient failure is surfaced (not silently swallowed)...
    expect(console.warn).toHaveBeenCalledTimes(1);
    // ...but neither the filename nor document bytes are logged.
    const logged = vi.mocked(console.warn).mock.calls.flat().join(' ');
    expect(logged).not.toContain('b.docx');
    expect(logged).not.toContain('PK ...');
  });

  it('logs an unexpected toMarkdown result shape (keys only, no content)', async () => {
    // Simulate a Workers AI response whose `format` field no longer matches, so
    // a silent "everything unsupported" regression would otherwise go unnoticed.
    const env = fakeEnv(async () => [
      { name: 'b.pdf', kind: 'markdown', text: 'renamed fields' },
    ]);
    const out = await generateTwin(env, {
      filename: 'b.pdf',
      contentType: 'application/pdf',
      bytes: enc('%PDF-1.4 ...'),
    });
    expect(out).toEqual({ markdown: null, status: 'unsupported' });
    expect(console.warn).toHaveBeenCalledTimes(1);
    const logged = vi.mocked(console.warn).mock.calls.flat();
    // Keys are logged for diagnosis; the extracted text/content is not.
    expect(JSON.stringify(logged)).toContain('kind');
    expect(JSON.stringify(logged)).not.toContain('renamed fields');
  });

  it('returns unsupported without an AI call for an unknown extension', async () => {
    const toMarkdown = vi.fn();
    const out = await generateTwin(fakeEnv(toMarkdown), {
      filename: 'archive.rtf',
      contentType: 'application/rtf',
      bytes: enc('{\\rtf1 ...}'),
    });
    expect(out).toEqual({ markdown: null, status: 'unsupported' });
    expect(toMarkdown).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('flags an ~empty text-native file as unsupported', async () => {
    const env = fakeEnv(async () => []);
    const out = await generateTwin(env, {
      filename: 'empty.txt',
      contentType: 'text/plain',
      bytes: enc('  '),
    });
    expect(out).toEqual({ markdown: null, status: 'unsupported' });
  });
});
