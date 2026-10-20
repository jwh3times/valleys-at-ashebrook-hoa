import { describe, it, expect, vi } from 'vitest';
import {
  retrieve,
  retrieveFrom,
  AiSearchUnavailableError,
} from '../../src/server/ai/search';

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

// #305: the governing-documents pass. A vector search over the whole library
// ranks correspondence and checklists above the bylaws and covenants, so the
// assistant also searches only within the governing documents.
describe('retrieveFrom', () => {
  it("searches only the named documents' search twins", async () => {
    const search = vi.fn(async () => ({ data: [] }));
    await retrieveFrom(fakeEnv(search), 'who serves on the board?', [
      'gov-1',
      'gov-2',
    ]);
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'who serves on the board?',
        max_num_results: 4,
        // AI Search matches a twin by its bare name, without the rag/ folder.
        filters: {
          type: 'or',
          filters: [
            { type: 'eq', key: 'filename', value: 'gov-1.md' },
            { type: 'eq', key: 'filename', value: 'gov-2.md' },
          ],
        },
      }),
    );
  });

  it('returns nothing, without searching, when there are no documents to search', async () => {
    const search = vi.fn(async () => ({ data: [] }));
    expect(await retrieveFrom(fakeEnv(search), 'q', [])).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it('wraps binding errors as AiSearchUnavailableError', async () => {
    const search = vi.fn(async () => {
      throw new Error('down');
    });
    await expect(
      retrieveFrom(fakeEnv(search), 'q', ['gov-1']),
    ).rejects.toBeInstanceOf(AiSearchUnavailableError);
  });

  // #453: AI Search fails every search whose `or` filter has more than 48
  // clauses (measured against production, 2026-10-20).
  it('never sends a filter of more than 40 documents, and still searches every one', async () => {
    const search = vi.fn(async (_opts: unknown) => ({ data: [] }));
    const ids = Array.from({ length: 90 }, (_, i) => `gov-${i}`);
    await retrieveFrom(fakeEnv(search), 'q', ids);
    const batches = search.mock.calls.map(
      ([opts]) =>
        (opts as { filters: { filters: { value: string }[] } }).filters.filters,
    );
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(40);
    expect(batches.flat().map((f) => f.value)).toEqual(
      ids.map((id) => `${id}.md`),
    );
  });

  it('keeps the best-scoring passages across the batches', async () => {
    const hit = (id: string, score: number) => ({
      id,
      score,
      content: id,
      metadata: { filename: `${id}.md`, folder: 'rag/', timestamp: 1 },
    });
    const pages = [
      [hit('a', 0.5), hit('b', 0.4)],
      [hit('c', 0.9), hit('d', 0.3)],
    ];
    const search = vi.fn(async () => ({ data: pages.shift() }));
    const ids = Array.from({ length: 41 }, (_, i) => `gov-${i}`);
    const found = await retrieveFrom(fakeEnv(search), 'q', ids, 3);
    expect(found.map((c) => c.id)).toEqual(['c', 'a', 'b']);
  });
});
