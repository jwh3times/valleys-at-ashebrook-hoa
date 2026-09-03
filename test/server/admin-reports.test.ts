import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

const captured: { params?: unknown[] } = { params: [] };
const { retrieveMock, genState, authState, anthropicState } = vi.hoisted(
  () => ({
    retrieveMock: vi.fn(),
    // `hang: true` makes the mocked generation stream stall forever right
    // after its first token, so a test can prove disconnect-cancellation is
    // what ends the read loop — not a race against natural completion.
    genState: { fail: false, hang: false },
    // Controllable stand-in for the real getAuthContext fallback that
    // resolveAuthContext calls when `locals.authContext` is nullish (both
    // absent `locals.authContext` and an explicit `null` fall through to
    // this mock — `null ?? x` evaluates `x` — see src/server/authz/api-guards.ts).
    // Defaults to a board caller so existing tests need no changes; flipped
    // to `null` by the 401 fail-closed test below.
    // Built inline rather than via legacyAuthContext: vi.hoisted runs before
    // module imports initialize, so calling it here throws on the uninitialized
    // binding. Kept in sync by the type annotation — a field added to
    // AuthContext fails this file at compile time.
    authState: {
      ctx: {
        userId: 'board-1',
        personId: null,
        capabilities: new Set(['board', 'member'] as const),
        lotIds: [],
        contentTier: 'board',
        hasCurrentBoardTerm: false,
        role: 'board',
        propertyIds: [],
      } as import('../../src/server/authz/guards').AuthContext | null,
    },
    anthropicState: { throwNotConfigured: false },
  }),
);
vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => authState.ctx,
}));
vi.mock('../../src/server/ai/search', async (orig) => ({
  ...(await orig<typeof import('../../src/server/ai/search')>()),
  retrieve: retrieveMock,
}));
vi.mock('../../src/server/ai/anthropic', () => {
  class AssistantNotConfiguredError extends Error {}
  return {
    AssistantNotConfiguredError,
    getAnthropic: () => {
      if (anthropicState.throwNotConfigured) {
        throw new AssistantNotConfiguredError();
      }
      return {
        messages: {
          parse: async (params: unknown) => {
            captured.params!.push(params);
            return {
              parsed_output: { queries: ['q one', 'q two', 'q three'] },
            };
          },
          stream: (params: unknown) => {
            captured.params!.push(params);
            async function* gen() {
              if (genState.fail) throw new Error('boom');
              yield {
                type: 'content_block_delta',
                delta: {
                  type: 'text_delta',
                  text: '## Summary\nRentals are restricted.',
                },
              };
              if (genState.hang) {
                // Never resolves on its own; only cancellation ends the
                // read loop that's consuming this generator.
                await new Promise<never>(() => {});
              }
            }
            const iterator = gen();
            return {
              [Symbol.asyncIterator]: () => iterator,
              finalMessage: async () => ({ stop_reason: 'end_turn' }),
            };
          },
        },
      };
    },
  };
});

import { POST, GET, DELETE } from '../../src/pages/api/admin/reports';
import { getDb } from '../../src/server/db/client';
import {
  owners,
  properties,
  documents,
  reports,
} from '../../src/server/db/schema';
import { AiSearchUnavailableError } from '../../src/server/ai/search';
import { legacyAuthContext } from '../../src/server/authz/context';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  await getDb(env).insert(properties).values({
    id: 'doc-1',
    address: '123 Ashebrook Lane',
    addressNormalized: '123 ashebrook lane',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await getDb(env).insert(owners).values({
    id: 'o1',
    propertyId: 'doc-1',
    fullName: 'Jane Q Homeowner',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await getDb(env).insert(documents).values({
    id: 'doc-1',
    title: 'CCRs',
    category: 'Governing Documents',
    visibility: 'board',
    r2Key: 'documents/doc-1/f.pdf',
    filename: 'f.pdf',
    sizeBytes: 1,
    contentType: 'application/pdf',
    uploadedAt: new Date(),
    updatedAt: new Date(),
  });
  retrieveMock.mockImplementation(async () => [
    {
      id: 'c1',
      score: 0.9,
      content: 'Leases must run 12 months. Jane Q Homeowner filed a note.',
      metadata: {
        filename: 'f.pdf',
        folder: 'documents/doc-1/f.pdf',
        timestamp: 1,
      },
    },
  ]);
});

function post(body: unknown, locals?: unknown) {
  return POST({
    locals: locals ?? {},
    request: new Request('http://localhost/api/admin/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  } as never);
}

const homeownerLocals = {
  authContext: legacyAuthContext('h1', 'homeowner', []),
};

// Reassemble the `event: token` frames' text payloads. The de-anonymization
// stream (src/server/ai/pii.ts) buffers the trailing `maxSurrogateLen`
// characters of the model's output to avoid ever splitting a surrogate across
// emits, so a short reply can legitimately land its tail across two `token`
// frames — checking the raw SSE body for a contiguous substring is flaky
// against that (correct) buffering; reassembling the token stream is not.
function tokensText(body: string): string {
  return [...body.matchAll(/event: token\ndata: (\{.*\})\n/g)]
    .map((m) => (JSON.parse(m[1]) as { text: string }).text)
    .join('');
}

describe('POST /api/admin/reports', () => {
  it('403s a non-board caller (fail-closed)', async () => {
    const res = await post({ template: 'rentals' }, homeownerLocals);
    expect(res.status).toBe(403);
  });

  it('401s an anonymous caller (fail-closed) when no auth context resolves', async () => {
    authState.ctx = null;
    try {
      // `{}` has no `authContext` key, so resolveAuthContext falls through to
      // the (mocked) getAuthContext fallback, which now resolves null —
      // exercising requireBoard's `if (!ctx) return 401` branch for real.
      const res = await post({ template: 'rentals' }, {});
      expect(res.status).toBe(401);
    } finally {
      authState.ctx = legacyAuthContext('board-1', 'board', []);
    }
  });

  it('400s malformed JSON', async () => {
    expect((await post('not json')).status).toBe(400);
  });

  it('400s when both template and topic are provided', async () => {
    expect((await post({ template: 'rentals', topic: 'x' })).status).toBe(400);
  });

  it('400s when neither template nor topic is provided', async () => {
    expect((await post({})).status).toBe(400);
  });

  it('400s an unknown template key', async () => {
    expect((await post({ template: 'nope' })).status).toBe(400);
  });

  it('400s an over-length topic', async () => {
    expect((await post({ topic: 'x'.repeat(201) })).status).toBe(400);
  });

  it('streams sources, tokens, done — and saves the row before done', async () => {
    const res = await post({ template: 'rentals' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('event: sources');
    expect(body).toContain('event: token');
    expect(body).toContain('event: done');
    expect(tokensText(body)).toContain('Rentals are restricted.');

    const idMatch = body.match(/event: done\ndata: \{"id":"([^"]+)"\}/);
    expect(idMatch).not.toBeNull();
    const rows = await getDb(env).select().from(reports);
    const row = rows.find((r) => r.id === idMatch![1]);
    expect(row).toBeDefined();
    expect(row!.topic).toBe('Rentals & leasing');
    expect(row!.templateKey).toBe('rentals');
    expect(row!.contentMd).toContain('Rentals are restricted.');
    expect(row!.createdBy).toBe('board-1');
    expect(JSON.parse(row!.sourcesJson)).toEqual([
      { id: 'doc-1', title: 'CCRs', category: 'Governing Documents' },
    ]);
  });

  it('does not persist a truncated report when the client disconnects mid-generation', async () => {
    genState.hang = true;
    try {
      const before = (await getDb(env).select().from(reports)).length;
      const res = await post({ template: 'rentals' });
      const reader = res.body!.getReader();
      // Read only the first chunk (the `sources` frame) — the generation is
      // stalled on genState.hang, so nothing else can have been produced yet.
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(new TextDecoder().decode(first.value)).toContain('event: sources');
      // Disconnect mid-stream, before any `token`/`done` frame arrives.
      await reader.cancel();
      // Let the cancel() callback's teardown (setting clientGone and
      // cancelling the inner reader) run before asserting.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const after = (await getDb(env).select().from(reports)).length;
      expect(after).toBe(before);
    } finally {
      genState.hang = false;
    }
  });

  it('sends no real roster PII to Anthropic across planning and generation', async () => {
    captured.params = [];
    await (await post({ topic: 'complaints from Jane Q Homeowner' })).text();
    // Non-vacuous: prove the pipeline actually reached Anthropic (planner
    // create + generation stream) before trusting the absence assertions
    // below — otherwise a broken pipeline that never called Anthropic would
    // pass these `not.toContain` checks while proving nothing.
    expect(captured.params!.length).toBe(2);
    const payload = JSON.stringify(captured.params);
    expect(payload).not.toContain('Jane Q Homeowner');
    expect(payload).not.toContain('123 Ashebrook Lane');
  });

  it('emits error and saves nothing when generation fails', async () => {
    genState.fail = true;
    try {
      const before = (await getDb(env).select().from(reports)).length;
      const body = await (await post({ template: 'rentals' })).text();
      expect(body).toContain('event: error');
      expect(body).not.toContain('event: done');
      const after = (await getDb(env).select().from(reports)).length;
      expect(after).toBe(before);
    } finally {
      genState.fail = false;
    }
  });

  it('maps AssistantNotConfiguredError to a 500 with a friendly message', async () => {
    anthropicState.throwNotConfigured = true;
    try {
      const res = await post({ template: 'rentals' });
      expect(res.status).toBe(500);
      expect(await res.text()).toContain("isn't configured");
    } finally {
      anthropicState.throwNotConfigured = false;
    }
  });

  it('maps AiSearchUnavailableError to a 503', async () => {
    retrieveMock.mockImplementationOnce(async () => {
      throw new AiSearchUnavailableError(new Error('search down'));
    });
    const res = await post({ template: 'rentals' });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('temporarily unavailable');
  });

  it('returns 422 without starting generation or saving when retrieval finds nothing', async () => {
    retrieveMock.mockImplementation(async () => []);
    try {
      captured.params = [];
      const before = (await getDb(env).select().from(reports)).length;

      const res = await post({ template: 'rentals' });

      expect(res.status).toBe(422);
      expect(await res.text()).toContain('No searchable documents matched');
      expect(captured.params).toEqual([]);
      expect(await getDb(env).select().from(reports)).toHaveLength(before);
    } finally {
      retrieveMock.mockImplementation(async () => [
        {
          id: 'c1',
          score: 0.9,
          content: 'Leases must run 12 months. Jane Q Homeowner filed a note.',
          metadata: {
            filename: 'f.pdf',
            folder: 'documents/doc-1/f.pdf',
            timestamp: 1,
          },
        },
      ]);
    }
  });
});

describe('GET /api/admin/reports', () => {
  it('403s a non-board caller', async () => {
    const res = await GET({
      locals: homeownerLocals,
      request: new Request('http://localhost/api/admin/reports'),
    } as never);
    expect(res.status).toBe(403);
  });

  it('lists saved reports newest-first with metadata only', async () => {
    const res = await GET({
      locals: {},
      request: new Request('http://localhost/api/admin/reports'),
    } as never);
    expect(res.status).toBe(200);
    const page = (await res.json()) as {
      items: { id: string; topic: string; contentMd?: string }[];
      nextCursor: string | null;
    };
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items[0].contentMd).toBeUndefined();
  });

  it('paginates report history without duplicating or skipping rows', async () => {
    await getDb(env)
      .insert(reports)
      .values([
        {
          id: 'page-1',
          topic: 'Oldest page fixture',
          templateKey: null,
          contentMd: 'oldest',
          sourcesJson: '[]',
          createdAt: new Date('2030-01-02T00:00:00.000Z'),
          createdBy: 'board-1',
        },
        {
          id: 'page-2',
          topic: 'Middle page fixture',
          templateKey: null,
          contentMd: 'middle',
          sourcesJson: '[]',
          createdAt: new Date('2030-01-02T00:00:00.000Z'),
          createdBy: 'board-1',
        },
        {
          id: 'page-3',
          topic: 'Newest page fixture',
          templateKey: null,
          contentMd: 'newest',
          sourcesJson: '[]',
          createdAt: new Date('2030-01-03T00:00:00.000Z'),
          createdBy: 'board-1',
        },
      ]);

    const first = await GET({
      locals: {},
      request: new Request('http://localhost/api/admin/reports?limit=2'),
    } as never);
    const firstPage = (await first.json()) as {
      items: { id: string; contentMd?: string }[];
      nextCursor: string | null;
    };
    expect(firstPage.items.map((r) => r.id)).toEqual(['page-3', 'page-2']);
    expect(firstPage.items.every((r) => r.contentMd === undefined)).toBe(true);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const second = await GET({
      locals: {},
      request: new Request(
        `http://localhost/api/admin/reports?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
      ),
    } as never);
    const secondPage = (await second.json()) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(secondPage.items[0].id).toBe('page-1');
    expect(secondPage.items.map((r) => r.id)).not.toContain('page-2');
  });

  it('rejects invalid report-history pagination inputs', async () => {
    const badLimit = await GET({
      locals: {},
      request: new Request('http://localhost/api/admin/reports?limit=0'),
    } as never);
    expect(badLimit.status).toBe(400);

    const badCursor = await GET({
      locals: {},
      request: new Request('http://localhost/api/admin/reports?cursor=nope'),
    } as never);
    expect(badCursor.status).toBe(400);
  });

  it('returns a full report by id, and 404s an unknown id', async () => {
    const all = await getDb(env).select().from(reports);
    const res = await GET({
      locals: {},
      request: new Request(
        `http://localhost/api/admin/reports?id=${all[0].id}`,
      ),
    } as never);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as {
      contentMd: string;
      sources: unknown[];
    };
    expect(detail.contentMd.length).toBeGreaterThan(0);
    expect(Array.isArray(detail.sources)).toBe(true);

    const missing = await GET({
      locals: {},
      request: new Request('http://localhost/api/admin/reports?id=nope'),
    } as never);
    expect(missing.status).toBe(404);
  });
});

describe('DELETE /api/admin/reports', () => {
  function del(body: unknown, locals?: unknown) {
    return DELETE({
      locals: locals ?? {},
      request: new Request('http://localhost/api/admin/reports', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    } as never);
  }

  it('403s a non-board caller', async () => {
    expect((await del({ id: 'x' }, homeownerLocals)).status).toBe(403);
  });

  it('deletes a report and 404s an unknown id', async () => {
    const all = await getDb(env).select().from(reports);
    const target = all[0].id;
    expect((await del({ id: target })).status).toBe(204);
    const remaining = await getDb(env).select().from(reports);
    expect(remaining.find((r) => r.id === target)).toBeUndefined();
    expect((await del({ id: target })).status).toBe(404);
  });
});
