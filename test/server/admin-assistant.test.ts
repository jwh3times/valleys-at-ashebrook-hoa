import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

// Retrieval is mocked (no AI binding in the test pool); Anthropic is mocked to
// capture the outgoing payload and return a scripted surrogate answer.
const captured: { params?: unknown } = {};
const { retrieveMock, mockFinal } = vi.hoisted(() => ({
  retrieveMock: vi.fn(),
  mockFinal: { stop_reason: 'end_turn' },
}));
vi.mock('../../src/server/ai/search', async (orig) => ({
  ...(await orig<typeof import('../../src/server/ai/search')>()),
  retrieve: retrieveMock,
}));
vi.mock('../../src/server/ai/anthropic', () => ({
  AssistantNotConfiguredError: class extends Error {},
  getAnthropic: () => ({
    messages: {
      stream: (params: unknown) => {
        captured.params = params;
        // Async-iterable of text deltas that echo the surrogate name back.
        async function* gen() {
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'The balance for ' },
          };
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: SURROGATE_NAME },
          };
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: ' is $50.' },
          };
        }
        const it = gen();
        return {
          [Symbol.asyncIterator]: () => it,
          finalMessage: async () => ({ stop_reason: mockFinal.stop_reason }),
        };
      },
    },
  }),
}));

import { answer, loadRosterEntries } from '../../src/server/ai/assistant';
import { buildPseudonymizer } from '../../src/server/ai/pii';
import { getDb } from '../../src/server/db/client';
import { owners, properties, documents } from '../../src/server/db/schema';
import { POST } from '../../src/pages/api/admin/assistant';

// Derive the surrogate the mock will echo, from the same roster the test seeds.
let SURROGATE_NAME = '';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  retrieveMock.mockImplementation(async () => [
    {
      id: 'c1',
      score: 0.9,
      content: 'Jane Q Homeowner owes $50 at 123 Ashebrook Lane.',
      metadata: {
        filename: 'f.pdf',
        folder: 'documents/uuid-1/f.pdf',
        timestamp: 1,
      },
    },
  ]);
  await getDb(env).insert(properties).values({
    id: 'uuid-1',
    address: '123 Ashebrook Lane',
    addressNormalized: '123 ashebrook lane',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await getDb(env).insert(owners).values({
    id: 'o1',
    propertyId: 'uuid-1',
    fullName: 'Jane Q Homeowner',
    phone: '(919) 555-0100',
    email: 'jane@realmail.com',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  // A former (inactive) owner — must still be pseudonymized even though the
  // roster feed is not filtered to active status (loadRosterEntries feeds
  // only the PII dictionary, never a user-facing read).
  await getDb(env).insert(owners).values({
    id: 'o2',
    propertyId: 'uuid-1',
    fullName: 'Pat Pastowner',
    status: 'inactive',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await getDb(env).insert(documents).values({
    id: 'uuid-1',
    title: 'Ledger',
    category: 'Financials',
    visibility: 'board',
    r2Key: 'documents/uuid-1/f.pdf',
    filename: 'f.pdf',
    sizeBytes: 1,
    contentType: 'application/pdf',
    uploadedAt: new Date(),
    updatedAt: new Date(),
  });
  const entries = await loadRosterEntries(env);
  SURROGATE_NAME = buildPseudonymizer(entries)
    .anonymize('Jane Q Homeowner')
    .trim();
});

async function readAll(rs: ReadableStream<string>): Promise<string> {
  const reader = rs.getReader();
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += value;
  }
  return out;
}

describe('assistant.answer', () => {
  it('sends NO real roster PII to Anthropic', async () => {
    await answer(env, { question: 'What does Jane Q Homeowner owe?' });
    const payload = JSON.stringify(captured.params);
    expect(payload).not.toContain('Jane Q Homeowner');
    expect(payload).not.toContain('123 Ashebrook Lane');
    expect(payload).not.toContain('919');
    expect(payload).not.toContain('jane@realmail.com');
  });

  it('pseudonymizes former (inactive) owners too', async () => {
    await answer(env, { question: 'What about Pat Pastowner?' });
    const payload = JSON.stringify(captured.params);
    expect(payload).not.toContain('Pat Pastowner');
  });

  it('anonymizes conversation history before sending to Anthropic', async () => {
    await answer(env, {
      question: 'and what about now?',
      history: [
        {
          role: 'user',
          content:
            'Does Jane Q Homeowner at 123 Ashebrook Lane, (919) 555-0100 / jane@realmail.com owe dues?',
        },
        {
          role: 'assistant',
          content: 'I could not find that in the documents.',
        },
      ],
    });
    const payload = JSON.stringify(captured.params);
    expect(payload).not.toContain('Jane Q Homeowner');
    expect(payload).not.toContain('123 Ashebrook Lane');
    expect(payload).not.toContain('(919) 555-0100');
    expect(payload).not.toContain('919');
    expect(payload).not.toContain('jane@realmail.com');
  });

  it('de-anonymizes the streamed answer before returning it', async () => {
    const { sources, textStream } = await answer(env, {
      question: 'balance for Jane Q Homeowner?',
    });
    expect(sources).toEqual([
      {
        id: 'uuid-1',
        title: expect.any(String),
        category: expect.any(String),
        href: '/api/files/uuid-1',
      },
    ]);
    const text = await readAll(textStream);
    expect(text).toContain('Jane Q Homeowner'); // surrogate mapped back to the real name
    expect(text).not.toContain(SURROGATE_NAME);
  });

  it('appends a visible notice when generation is truncated by max_tokens', async () => {
    mockFinal.stop_reason = 'max_tokens';
    try {
      const { textStream } = await answer(env, {
        question: 'summarize every covenant article in detail',
      });
      const text = await readAll(textStream);
      expect(text).toContain('cut off by the length limit');
    } finally {
      mockFinal.stop_reason = 'end_turn';
    }
  });

  it('requests enough max_tokens headroom for adaptive thinking', async () => {
    await answer(env, { question: 'headroom check' });
    const params = captured.params as { max_tokens: number };
    // Adaptive thinking spends from the same max_tokens budget as the visible
    // answer; a chat-sized cap can be consumed by thinking alone.
    expect(params.max_tokens).toBeGreaterThanOrEqual(16000);
  });

  it('instructs hybrid answering with clear doc-vs-general-knowledge labeling', async () => {
    await answer(env, { question: 'what are the rules about fences?' });
    const system = (captured.params as { system: string }).system;
    const lower = system.toLowerCase();
    // General knowledge is permitted (hybrid), not documents-only.
    expect(lower).toContain('general knowledge');
    // ...but anything not from the documents must be labeled as such.
    expect(lower).toContain('not from the documents');
    // Document-sourced facts are still cited by [Source N].
    expect(system).toContain('[Source N]');
    // The PII placeholder rule is preserved (de-anonymization depends on it).
    expect(lower).toContain('placeholder');
  });

  it('numbers excerpt citations per-document, matching the sources order', async () => {
    await getDb(env).insert(documents).values({
      id: 'uuid-2',
      title: 'Rules',
      category: 'Governing Documents',
      visibility: 'board',
      r2Key: 'documents/uuid-2/g.pdf',
      filename: 'g.pdf',
      sizeBytes: 1,
      contentType: 'application/pdf',
      uploadedAt: new Date(),
      updatedAt: new Date(),
    });
    retrieveMock.mockImplementationOnce(async () => [
      {
        id: 'c1',
        score: 0.9,
        content: 'Ledger excerpt one.',
        metadata: {
          filename: 'f.pdf',
          folder: 'documents/uuid-1/f.pdf',
          timestamp: 1,
        },
      },
      {
        id: 'c2',
        score: 0.8,
        content: 'Rules excerpt.',
        metadata: {
          filename: 'g.pdf',
          folder: 'documents/uuid-2/g.pdf',
          timestamp: 2,
        },
      },
      {
        id: 'c3',
        score: 0.7,
        content: 'Ledger excerpt two.',
        metadata: {
          filename: 'f.pdf',
          folder: 'documents/uuid-1/f.pdf',
          timestamp: 3,
        },
      },
    ]);

    const { sources } = await answer(env, { question: 'multi-doc question' });
    expect(sources.map((s) => s.id)).toEqual(['uuid-1', 'uuid-2']);

    const params = captured.params as {
      messages: { role: string; content: string }[];
    };
    const userText = params.messages[params.messages.length - 1].content;
    expect(userText).toContain(
      '[Source 1] Financials — "Ledger"\nLedger excerpt one.',
    );
    expect(userText).toContain(
      '[Source 2] Governing Documents — "Rules"\nRules excerpt.',
    );
    expect(userText).toContain(
      '[Source 1] Financials — "Ledger"\nLedger excerpt two.',
    );
    expect(userText).not.toContain('[Source 3]');

    const distinctLabels = new Set(userText.match(/\[Source \d+\]/g));
    expect(distinctLabels.size).toBe(sources.length);

    // No PII regression: still anonymized.
    expect(userText).not.toContain('Jane Q Homeowner');
    expect(userText).not.toContain('123 Ashebrook Lane');
  });

  it('drops orphan chunks whose uuid has no document row', async () => {
    retrieveMock.mockImplementationOnce(async () => [
      {
        id: 'orphan',
        score: 0.9,
        content: 'Stale orphan text that must not reach the model.',
        metadata: {
          filename: 'x.pdf',
          folder: 'documents/no-such-uuid/x.pdf',
          timestamp: 1,
        },
      },
    ]);
    const { sources, documentsFound } = await answer(env, {
      question: 'orphan?',
    });
    expect(sources).toEqual([]);
    expect(documentsFound).toBe(false);
    const params = captured.params as { messages: { content: string }[] };
    const userText = params.messages[params.messages.length - 1].content;
    expect(userText).not.toContain('Stale orphan text');
    expect(userText).not.toContain('[Source]');
    expect(userText).toContain('(no relevant excerpts found)');
  });

  it('reports documentsFound=false and still answers when retrieval is empty', async () => {
    retrieveMock.mockImplementationOnce(async () => []);
    const { sources, documentsFound, textStream } = await answer(env, {
      question: 'no docs?',
    });
    expect(sources).toEqual([]);
    expect(documentsFound).toBe(false);
    const text = await readAll(textStream);
    expect(text.length).toBeGreaterThan(0); // general-knowledge answer still streams
  });

  it('sends a pseudonymized document title to the model but keeps the real title in sources', async () => {
    await getDb(env).insert(documents).values({
      id: 'uuid-3',
      title: 'Jane Q Homeowner Complaint',
      category: 'Member Correspondence',
      visibility: 'board',
      r2Key: 'documents/uuid-3/h.pdf',
      filename: 'h.pdf',
      sizeBytes: 1,
      contentType: 'application/pdf',
      uploadedAt: new Date(),
      updatedAt: new Date(),
    });
    retrieveMock.mockImplementationOnce(async () => [
      {
        id: 'c1',
        score: 0.9,
        content: 'A complaint was filed.',
        metadata: {
          filename: 'h.pdf',
          folder: 'documents/uuid-3/h.pdf',
          timestamp: 1,
        },
      },
    ]);
    const { sources } = await answer(env, { question: 'complaint?' });
    expect(sources[0].title).toBe('Jane Q Homeowner Complaint'); // real title for the board
    const params = captured.params as { messages: { content: string }[] };
    const userText = params.messages[params.messages.length - 1].content;
    expect(userText).not.toContain('Jane Q Homeowner'); // title pseudonymized before the model
    expect(userText).toContain('Member Correspondence'); // category sent verbatim
  });
});

async function sse(res: Response): Promise<string> {
  return await res.text();
}

describe('POST /api/admin/assistant', () => {
  it('403s a non-board caller (fail-closed)', async () => {
    // Pass a non-board caller directly via `locals.authContext`, the fast-path
    // `resolveAuthContext` reads before ever falling back to the top-level
    // (board) `getAuthContext` mock. This proves fail-closed behavior without
    // relying on module-cache resets.
    const res = await POST({
      locals: {
        authContext: { userId: 'h', role: 'homeowner', propertyIds: [] },
      },
      request: new Request('http://localhost/api/admin/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'hi' }),
      }),
    } as never);
    expect(res.status).toBe(403);
  });

  it('400s a malformed body', async () => {
    const res = await POST({
      request: new Request('http://localhost/api/admin/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    } as never);
    expect(res.status).toBe(400);
  });

  it('400s an empty question', async () => {
    const res = await POST({
      request: new Request('http://localhost/api/admin/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '   ' }),
      }),
    } as never);
    expect(res.status).toBe(400);
  });

  it('streams sources then tokens then done for a board caller', async () => {
    const res = await POST({
      request: new Request('http://localhost/api/admin/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'balance for Jane Q Homeowner?' }),
      }),
    } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await sse(res);
    expect(body).toContain('event: sources');
    expect(body).toContain('event: token');
    expect(body).toContain('event: done');
    expect(body).toContain('Jane Q Homeowner'); // de-anonymized in the token stream
  });

  it('does not shear a roster value in history before pseudonymizing', async () => {
    // The endpoint must NOT truncate raw history content before masking. Pad so
    // the roster address starts near index 1989 and its tail crosses the
    // 2000-char cap. The OLD parseHistory sliced raw content to 2000 first,
    // shearing "…Ashebrook Lane" and leaking the "123 Ashe" head fragment;
    // answer() then could not match the partial address. captured.params is set
    // synchronously when answer() opens the (mocked) Anthropic stream.
    const pad = 'x'.repeat(1988);
    const res = await POST({
      request: new Request('http://localhost/api/admin/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question: 'and now?',
          history: [
            { role: 'user', content: `${pad} 123 Ashebrook Lane owes dues` },
          ],
        }),
      }),
    } as never);
    await res.text(); // drain the SSE stream
    const payload = JSON.stringify(captured.params);
    expect(payload).not.toContain('123 Ashe');
  });
});
