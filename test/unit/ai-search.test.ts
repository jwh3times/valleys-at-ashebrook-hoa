import { describe, it, expect, vi } from 'vitest';
import { retrieve, AiSearchUnavailableError } from '../../src/server/ai/search';

function fakeEnv(search: (opts: unknown) => Promise<unknown>): Env {
  return {
    AI_SEARCH_INSTANCE: 'test-instance',
    AI: { autorag: () => ({ search }) },
  } as unknown as Env;
}

describe('retrieve', () => {
  it('passes the query to the configured instance', async () => {
    const search = vi.fn(async () => ({ data: [] }));
    await retrieve(fakeEnv(search), 'what is the late fee?');
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'what is the late fee?' }),
    );
  });

  // The real AI Search / AutoRAG binding returns items whose text is an array of
  // {type,text} blocks and whose folder lives under `attributes` — NOT the
  // `{ content: string, metadata: { folder } }` shape the code originally assumed
  // (that mismatch 500'd in production: `Cannot read properties of undefined
  // (reading 'folder')`). retrieve() must normalize it.
  it('normalizes the AutoRAG data[] shape (content array + attributes.folder)', async () => {
    const search = vi.fn(async () => ({
      search_query: 'q',
      has_more: false,
      data: [
        {
          file_id: 'uuid-1',
          filename: 'a.pdf',
          score: 0.9,
          content: [
            { type: 'text', text: 'hello ' },
            { type: 'text', text: 'world' },
          ],
          attributes: { folder: 'documents/uuid-1/', timestamp: 1 },
        },
      ],
    }));
    const chunks = await retrieve(fakeEnv(search), 'x');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('hello world');
    expect(chunks[0].id).toBe('uuid-1');
    expect(chunks[0].metadata.folder).toBe('documents/uuid-1/');
    expect(chunks[0].metadata.filename).toBe('a.pdf');
  });

  // The rebranded "AI Search" surface has instead surfaced results under `chunks`
  // with a plain `text` field and the path under `item.key`. Normalize that too.
  it('normalizes the AI Search chunks[] shape (text + item.key)', async () => {
    const search = vi.fn(async () => ({
      search_query: 'q',
      chunks: [
        {
          id: 'uuid-2',
          score: 0.8,
          text: 'second doc',
          item: { key: 'documents/uuid-2/notes.pdf', timestamp: 2 },
        },
      ],
    }));
    const chunks = await retrieve(fakeEnv(search), 'x');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('second doc');
    expect(chunks[0].id).toBe('uuid-2');
    expect(chunks[0].metadata.folder).toBe('documents/uuid-2/notes.pdf');
  });

  // A plain-string `content` + `metadata.folder` is still accepted.
  it('accepts a plain-string content shape', async () => {
    const search = vi.fn(async () => ({
      data: [
        {
          id: '1',
          score: 0.9,
          content: 'plain',
          metadata: {
            filename: 'a.pdf',
            folder: 'documents/uuid-3/',
            timestamp: 1,
          },
        },
      ],
    }));
    const chunks = await retrieve(fakeEnv(search), 'x');
    expect(chunks[0].content).toBe('plain');
    expect(chunks[0].metadata.folder).toBe('documents/uuid-3/');
  });

  it('wraps binding errors as AiSearchUnavailableError', async () => {
    const search = vi.fn(async () => {
      throw new Error('AutoRAGNotFoundError');
    });
    await expect(retrieve(fakeEnv(search), 'x')).rejects.toBeInstanceOf(
      AiSearchUnavailableError,
    );
  });
});
