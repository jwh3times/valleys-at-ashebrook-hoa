import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

// Retrieval is mocked (no AI binding in the test pool); Anthropic is mocked to
// capture the outgoing payload and return a scripted surrogate answer.
const captured: { params?: unknown } = {};
vi.mock('../../src/server/ai/search', async (orig) => ({
  ...(await orig<typeof import('../../src/server/ai/search')>()),
  retrieve: async () => [
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
  ],
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
          finalMessage: async () => ({ stop_reason: 'end_turn' }),
        };
      },
    },
  }),
}));

import { answer, loadRosterEntries } from '../../src/server/ai/assistant';
import { buildPseudonymizer } from '../../src/server/ai/pii';
import { getDb } from '../../src/server/db/client';
import { owners, properties, documents } from '../../src/server/db/schema';

// Derive the surrogate the mock will echo, from the same roster the test seeds.
let SURROGATE_NAME = '';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
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
});
