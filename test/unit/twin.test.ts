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
