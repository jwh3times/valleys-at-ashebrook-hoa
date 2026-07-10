import { describe, it, expect, vi } from 'vitest';
import { retrieve, AiSearchUnavailableError } from '../../src/server/ai/search';

function fakeEnv(search: (opts: unknown) => Promise<unknown>): Env {
  return {
    AI_SEARCH_INSTANCE: 'test-instance',
    AI: { autorag: () => ({ search }) },
  } as unknown as Env;
}

describe('retrieve', () => {
  it('passes the query to the configured instance and returns chunks', async () => {
    const search = vi.fn(async () => ({
      search_query: 'q',
      has_more: false,
      data: [
        {
          id: '1',
          score: 0.9,
          content: 'hello',
          metadata: {
            filename: 'a.pdf',
            folder: 'documents/uuid-1/',
            timestamp: 1,
          },
        },
      ],
    }));
    const chunks = await retrieve(fakeEnv(search), 'what is the late fee?');
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'what is the late fee?' }),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('hello');
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
