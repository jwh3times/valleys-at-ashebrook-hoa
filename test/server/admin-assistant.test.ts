import { seedRosterOwner } from './roster-fixtures';
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { AiSearchChunk } from '../../src/server/ai/search';
import { INPUT_LIMITS } from '../../src/lib/types';

vi.mock('../../src/server/authz/context', async (importActual) => ({
  ...(await importActual<typeof import('../../src/server/authz/context')>()),
  getAuthContext: async () => callerContext('b', 'board', []),
}));

// Retrieval is mocked (no AI binding in the test pool); Anthropic is mocked to
// capture the outgoing payload and return a scripted surrogate answer.
const captured: { params?: unknown } = {};
const { retrieveMock, retrieveFromMock, mockFinal } = vi.hoisted(() => ({
  retrieveMock: vi.fn(),
  retrieveFromMock: vi.fn(
    async (..._args: unknown[]): Promise<AiSearchChunk[]> => [],
  ),
  mockFinal: { stop_reason: 'end_turn' },
}));
vi.mock('../../src/server/ai/search', async (orig) => ({
  ...(await orig<typeof import('../../src/server/ai/search')>()),
  retrieve: retrieveMock,
  retrieveFrom: retrieveFromMock,
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
        const iterator = gen();
        return {
          [Symbol.asyncIterator]: () => iterator,
          finalMessage: async () => ({ stop_reason: mockFinal.stop_reason }),
        };
      },
    },
  }),
}));

import { answer, loadRosterEntries } from '../../src/server/ai/assistant';
import { buildPseudonymizer } from '../../src/server/ai/pii';
import { getDb } from '../../src/server/db/client';
import { lots, documents } from '../../src/server/db/schema';
import { POST } from '../../src/pages/api/admin/assistant';
import { callerContext } from './caller-context';

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
  await getDb(env).insert(lots).values({
    id: 'uuid-1',
    address: '123 Ashebrook Lane',
    addressNormalized: '123 ashebrook lane',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await seedRosterOwner({
    id: 'o1',
    propertyId: 'uuid-1',
    fullName: 'Jane Q Homeowner',
    phone: '(919) 555-0100',
    email: 'jane@realmail.test',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  // A former (inactive) owner — must still be pseudonymized even though the
  // roster feed is not filtered to active status (loadRosterEntries feeds
  // only the PII dictionary, never a user-facing read).
  await seedRosterOwner({
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
    expect(payload).not.toContain('jane@realmail.test');
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
            'Does Jane Q Homeowner at 123 Ashebrook Lane, (919) 555-0100 / jane@realmail.test owe dues?',
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
    expect(payload).not.toContain('jane@realmail.test');
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

// #305: a library-wide vector search ranks correspondence and checklists
// above the bylaws and covenants, and the model, seeing no bylaws passage,
// said the association had no bylaws.
describe('the governing documents (#305)', () => {
  const chunk = (id: string, docId: string, content: string) => ({
    id,
    score: 0.5,
    content,
    metadata: {
      filename: `${docId}.md`,
      folder: `rag/${docId}.md`,
      timestamp: 1,
    },
  });
  const userText = () => {
    const params = captured.params as { messages: { content: string }[] };
    return params.messages[params.messages.length - 1].content;
  };

  beforeAll(async () => {
    const doc = (id: string, title: string, category: string) => ({
      id,
      title,
      category,
      visibility: 'public' as const,
      r2Key: `documents/${id}/x.pdf`,
      filename: 'x.pdf',
      sizeBytes: 1,
      contentType: 'application/pdf',
      uploadedAt: new Date(),
      updatedAt: new Date(),
    });
    await getDb(env)
      .insert(documents)
      .values([
        doc('gov-bylaws', 'By-Laws', 'Governing Documents'),
        doc('gov-named', 'Jane Q Homeowner Easement', 'Governing Documents'),
        doc('letter-1', 'Annual meeting letter', 'Meetings'),
      ]);
  });

  it('also searches the governing documents, adding their passages after the rest', async () => {
    retrieveMock.mockImplementationOnce(async () => [
      chunk('c1', 'letter-1', 'The meeting is in April.'),
    ]);
    retrieveFromMock.mockImplementationOnce(async () => [
      chunk('c2', 'gov-bylaws', 'Article II: the annual meeting.'),
    ]);

    const { sources } = await answer(env, {
      question: 'When is the annual meeting?',
    });

    const [, query, ids] = retrieveFromMock.mock.calls.at(-1) as unknown as [
      Env,
      string,
      string[],
    ];
    expect(query).toBe('When is the annual meeting?');
    expect(ids).toEqual(expect.arrayContaining(['gov-bylaws', 'gov-named']));
    expect(ids).not.toContain('letter-1');
    expect(sources.map((s) => s.id)).toEqual(['letter-1', 'gov-bylaws']);
    expect(userText()).toContain(
      '[Source 2] Governing Documents — "By-Laws"\nArticle II: the annual meeting.',
    );
  });

  it('never repeats a passage both searches found', async () => {
    const same = chunk('c1', 'gov-bylaws', 'Article II: the annual meeting.');
    retrieveMock.mockImplementationOnce(async () => [same]);
    retrieveFromMock.mockImplementationOnce(async () => [{ ...same }]);
    await answer(env, { question: 'When is the annual meeting?' });
    expect(userText().split('Article II: the annual meeting.').length - 1).toBe(
      1,
    );
  });

  it('tells the model which governing documents exist, with titles pseudonymized', async () => {
    retrieveMock.mockImplementationOnce(async () => []);
    await answer(env, { question: 'Do we have the bylaws?' });
    const text = userText();
    expect(text).toMatch(/Governing documents in the library:[^]*- "By-Laws"/);
    expect(text).not.toContain('Jane Q Homeowner');
    expect(text).toMatch(/- "[^"]*Easement"/);
    const system = (captured.params as { system: string }).system;
    expect(system).toMatch(/never say the association lacks a document/i);
  });

  it('keeps a governing passage the library search did not return, even from the same document', async () => {
    retrieveMock.mockImplementationOnce(async () => [
      chunk('gov-bylaws', 'gov-bylaws', 'Article I: the association.'),
    ]);
    retrieveFromMock.mockImplementationOnce(async () => [
      chunk('gov-bylaws', 'gov-bylaws', 'Article IV: the directors.'),
    ]);
    await answer(env, { question: 'Who are the directors?' });
    expect(userText()).toContain('Article I: the association.');
    expect(userText()).toContain('Article IV: the directors.');
  });

  it('still answers, without governing passages, when the governing search fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    retrieveMock.mockImplementationOnce(async () => [
      chunk('c1', 'letter-1', 'The meeting is in April.'),
    ]);
    retrieveFromMock.mockImplementationOnce(async () => {
      throw new Error('filter rejected');
    });
    const { sources, textStream } = await answer(env, {
      question: 'When is the annual meeting?',
    });
    expect(sources.map((s) => s.id)).toEqual(['letter-1']);
    expect((await readAll(textStream)).length).toBeGreaterThan(0);
    // The model is still told the governing documents exist.
    expect(userText()).toContain('- "By-Laws"');
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('searches with the previous question too, so a follow-up keeps its context', async () => {
    retrieveMock.mockImplementationOnce(async () => []);
    await answer(env, {
      question: 'And what about quorum?',
      history: [
        { role: 'user', content: 'Where is the pool?' },
        { role: 'assistant', content: 'Behind the clubhouse.' },
        { role: 'user', content: 'What do the bylaws say about meetings?' },
        { role: 'assistant', content: 'They require an annual meeting.' },
      ],
    });
    const expected =
      'What do the bylaws say about meetings?\nAnd what about quorum?';
    expect(retrieveMock.mock.calls.at(-1)?.[1]).toBe(expected);
    expect(retrieveFromMock.mock.calls.at(-1)?.[1]).toBe(expected);
  });

  it('caps the previous question it searches with at the question limit', async () => {
    retrieveMock.mockImplementationOnce(async () => []);
    await answer(env, {
      question: 'And quorum?',
      history: [{ role: 'user', content: 'x'.repeat(30_000) }],
    });
    const query = retrieveMock.mock.calls.at(-1)?.[1] as string;
    expect(query).toBe(
      `${'x'.repeat(INPUT_LIMITS.assistantQuestion)}\nAnd quorum?`,
    );
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
        authContext: callerContext('h', 'homeowner', []),
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

  it('drops an oversized history turn whole rather than trimming it', async () => {
    // The ten-turn cap bounds how MANY turns are scanned, not how big they are,
    // so a board caller could hand the pseudonymizer's regex pass megabytes.
    // The budget (ten times the per-question limit, across all turns) is spent
    // newest-first and enforced by dropping whole turns — trimming inside one
    // would shear a roster value and leak the unmasked head, which is exactly
    // what the test above forbids.
    const oversized = `OVERSIZED-MARKER ${'y'.repeat(30_000)}`;
    const res = await POST({
      request: new Request('http://localhost/api/admin/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question: 'and now?',
          history: [
            { role: 'user', content: oversized },
            { role: 'user', content: 'KEPT-MARKER a short recent turn' },
          ],
        }),
      }),
    } as never);
    await res.text();
    const payload = JSON.stringify(captured.params);
    expect(payload).toContain('KEPT-MARKER');
    expect(payload).not.toContain('OVERSIZED-MARKER');
    expect(payload).not.toContain('yyyy');
  });
});
