import { seedRosterOwner } from './roster-fixtures';
import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

const captured: { planParams?: unknown; genParams?: unknown } = {};
const { retrieveMock, retrieveFromMock, anthropicState } = vi.hoisted(() => ({
  retrieveMock: vi.fn(),
  retrieveFromMock: vi.fn(
    async (
      _env: unknown,
      _query: string,
      _documentIds: string[],
    ): Promise<AiSearchChunk[]> => [],
  ),
  anthropicState: { planFail: false, genFail: false },
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
      parse: async (params: unknown) => {
        captured.planParams = params;
        if (anthropicState.planFail) throw new Error('planner down');
        return {
          parsed_output: {
            queries: ['planned one', 'planned two', 'planned three'],
          },
        };
      },
      stream: (params: unknown) => {
        captured.genParams = params;
        async function* gen() {
          if (anthropicState.genFail) throw new Error('generation down');
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: '## Summary\nOwed by ' },
          };
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: SURROGATE_NAME },
          };
        }
        const iterator = gen();
        return {
          [Symbol.asyncIterator]: () => iterator,
          finalMessage: async () => ({ stop_reason: 'end_turn' }),
        };
      },
    },
  }),
}));

import {
  generateReport,
  UnknownTemplateError,
  REPORT_MODEL,
} from '../../src/server/ai/report';
import { loadRosterEntries } from '../../src/server/ai/assistant';
import { buildPseudonymizer } from '../../src/server/ai/pii';
import { getDb } from '../../src/server/db/client';
import { lots, documents } from '../../src/server/db/schema';
import { REPORT_TEMPLATES } from '../../src/lib/reports';
import type { AiSearchChunk } from '../../src/server/ai/search';

let SURROGATE_NAME = '';

function chunk(id: string, score: number, content: string, docId: string) {
  return {
    id,
    score,
    content,
    metadata: {
      filename: 'f.pdf',
      folder: `documents/${docId}/f.pdf`,
      timestamp: 1,
    },
  };
}

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  await getDb(env).insert(lots).values({
    id: 'doc-1',
    address: '123 Ashebrook Lane',
    addressNormalized: '123 ashebrook lane',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await seedRosterOwner({
    id: 'o1',
    propertyId: 'doc-1',
    fullName: 'Jane Q Homeowner',
    email: 'jane@realmail.test',
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
  retrieveMock.mockImplementation(async (_env: unknown, query: string) => [
    chunk(
      `c-${query}`,
      0.9,
      `Provision about ${query}. Jane Q Homeowner mentioned.`,
      'doc-1',
    ),
  ]);
  SURROGATE_NAME = buildPseudonymizer(await loadRosterEntries(env))
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

describe('generateReport', () => {
  it('runs one retrieval per template sub-query and pools the results', async () => {
    retrieveMock.mockClear();
    const template = REPORT_TEMPLATES[0];
    const gen = await generateReport(env, { templateKey: template.key });
    await readAll(gen.textStream);
    expect(retrieveMock).toHaveBeenCalledTimes(template.subQueries.length);
    const queries = retrieveMock.mock.calls.map((c) => c[1]);
    expect(queries).toEqual(template.subQueries);
    expect(gen.topic).toBe(template.label);
    expect(gen.templateKey).toBe(template.key);
    expect(gen.sources.map((s) => s.id)).toEqual(['doc-1']);
  });

  it('plans sub-queries for a freeform topic', async () => {
    retrieveMock.mockClear();
    const gen = await generateReport(env, { topic: 'solar panels' });
    await readAll(gen.textStream);
    expect(retrieveMock.mock.calls.map((c) => c[1])).toEqual([
      'planned one',
      'planned two',
      'planned three',
    ]);
    expect(gen.templateKey).toBeNull();
    expect(gen.topic).toBe('solar panels');
  });

  it('falls back to single-query retrieval when planning fails', async () => {
    anthropicState.planFail = true;
    retrieveMock.mockClear();
    try {
      await readAll(
        (await generateReport(env, { topic: 'solar panels' })).textStream,
      );
      expect(retrieveMock.mock.calls.map((c) => c[1])).toEqual([
        'solar panels',
      ]);
    } finally {
      anthropicState.planFail = false;
    }
  });

  it('sends NO real roster PII in either Anthropic payload', async () => {
    await readAll(
      (await generateReport(env, { topic: 'complaints from Jane Q Homeowner' }))
        .textStream,
    );
    const both = JSON.stringify([captured.planParams, captured.genParams]);
    expect(both).not.toContain('Jane Q Homeowner');
    expect(both).not.toContain('jane@realmail.test');
    expect(both).not.toContain('123 Ashebrook Lane');
  });

  it('de-anonymizes the streamed report text', async () => {
    const text = await readAll(
      (await generateReport(env, { templateKey: 'rentals' })).textStream,
    );
    expect(text).toContain('Jane Q Homeowner');
    expect(text).not.toContain(SURROGATE_NAME);
  });

  it('dedupes identical chunks retrieved by multiple sub-queries', async () => {
    retrieveMock
      .mockImplementationOnce(async () => [
        chunk('c1', 0.9, 'Same text.', 'doc-1'),
      ])
      .mockImplementationOnce(async () => [
        chunk('c2', 0.8, 'Same text.', 'doc-1'),
      ])
      .mockImplementationOnce(async () => [
        chunk('c3', 0.7, 'Other text.', 'doc-1'),
      ])
      .mockImplementationOnce(async () => []);
    await readAll(
      (await generateReport(env, { templateKey: 'rentals' })).textStream,
    );
    const userText = (captured.genParams as { messages: { content: string }[] })
      .messages[0].content;
    expect(userText.match(/Same text\./g)).toHaveLength(1);
    expect(userText).toContain('Other text.');
  });

  it('ranks a duplicate chunk by its best score, not its first-seen score, before the cap is applied', async () => {
    // Same (folder, content) chunk returned twice: a LOW score from the FIRST
    // sub-query, then a HIGH score from the LAST sub-query. `perQuery.flat()`
    // is in sub-query order, not score order, so a dedupe-then-sort would
    // keep the low-scored first-seen copy and sort it below the (higher-
    // scored) filler chunks — where the cap can cut it. Sorting by score
    // BEFORE dedupe must keep the high-scored copy instead. 31 unique
    // candidates for a cap of 30 forces exactly one to be dropped.
    const template = REPORT_TEMPLATES.find((t) => t.key === 'rentals')!;
    retrieveMock.mockReset();
    retrieveMock
      .mockImplementationOnce(async () => [
        chunk('dup-low', 0.3, 'Duplicate provision.', 'doc-1'),
        ...Array.from({ length: 10 }, (_, i) =>
          chunk(`filler-a-${i}`, 0.55, `Filler A ${i}.`, 'doc-1'),
        ),
      ])
      .mockImplementationOnce(async () =>
        Array.from({ length: 10 }, (_, i) =>
          chunk(`filler-b-${i}`, 0.55, `Filler B ${i}.`, 'doc-1'),
        ),
      )
      .mockImplementationOnce(async () =>
        Array.from({ length: 10 }, (_, i) =>
          chunk(`filler-c-${i}`, 0.55, `Filler C ${i}.`, 'doc-1'),
        ),
      )
      .mockImplementationOnce(async () => [
        chunk('dup-high', 0.95, 'Duplicate provision.', 'doc-1'),
      ]);
    await readAll(
      (await generateReport(env, { templateKey: template.key })).textStream,
    );
    const userText = (captured.genParams as { messages: { content: string }[] })
      .messages[0].content;
    expect(userText).toContain('Duplicate provision.');
    retrieveMock.mockImplementation(async (_env: unknown, query: string) => [
      chunk(`c-${query}`, 0.9, `Provision about ${query}.`, 'doc-1'),
    ]);
  });

  it('caps pooled context at 30 chunks, keeping the top scores', async () => {
    retrieveMock.mockReset();
    retrieveMock.mockImplementation(async (_env: unknown, query: string) =>
      Array.from({ length: 10 }, (_, i) =>
        chunk(
          `c-${query}-${i}`,
          Math.random(),
          `Excerpt ${query} ${i}.`,
          'doc-1',
        ),
      ),
    );
    await readAll(
      (await generateReport(env, { templateKey: 'rentals' })).textStream,
    );
    const userText = (captured.genParams as { messages: { content: string }[] })
      .messages[0].content;
    expect(userText.match(/Excerpt /g)).toHaveLength(30);
    retrieveMock.mockImplementation(async (_env: unknown, query: string) => [
      chunk(`c-${query}`, 0.9, `Provision about ${query}.`, 'doc-1'),
    ]);
  });

  it('fixes the report section structure in the system prompt', async () => {
    await readAll(
      (await generateReport(env, { templateKey: 'rentals' })).textStream,
    );
    expect((captured.genParams as { model: string }).model).toBe(REPORT_MODEL);
    const system = (captured.genParams as { system: string }).system;
    for (const heading of [
      'Summary',
      'What the documents say',
      'Where it lives',
      'Ambiguities',
      'Gaps',
    ]) {
      expect(system).toContain(heading);
    }
    expect(system).toContain('[Source N]');
    expect(system.toLowerCase()).toContain('placeholder');
  });

  it('throws UnknownTemplateError for a bad template key', async () => {
    await expect(
      generateReport(env, { templateKey: 'nope' }),
    ).rejects.toBeInstanceOf(UnknownTemplateError);
  });
});

// #453: the same governing-documents pass the assistant got in #305. A
// library-wide search ranks correspondence and checklists above the bylaws and
// covenants, so every sub-query also searches within the governing documents.
describe('the governing documents (#453)', () => {
  const userText = () =>
    (captured.genParams as { messages: { content: string }[] }).messages[0]
      .content;
  const template = REPORT_TEMPLATES.find((t) => t.key === 'rentals')!;

  beforeAll(async () => {
    await getDb(env).insert(documents).values({
      id: 'gov-named',
      title: 'Jane Q Homeowner Easement',
      category: 'Governing Documents',
      visibility: 'board',
      r2Key: 'documents/gov-named/e.pdf',
      filename: 'e.pdf',
      sizeBytes: 1,
      contentType: 'application/pdf',
      uploadedAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterEach(() => {
    retrieveFromMock.mockReset();
    retrieveFromMock.mockImplementation(async () => []);
    retrieveMock.mockImplementation(async (_env: unknown, query: string) => [
      chunk(`c-${query}`, 0.9, `Provision about ${query}.`, 'doc-1'),
    ]);
  });

  it('also searches the governing documents for every sub-query', async () => {
    retrieveFromMock.mockClear();
    await readAll(
      (await generateReport(env, { templateKey: template.key })).textStream,
    );
    expect(retrieveFromMock.mock.calls.map((c) => [c[1], c[2]])).toEqual(
      template.subQueries.map((q) => [q, ['doc-1', 'gov-named']]),
    );
  });

  it('keeps every governing passage within the 30-passage limit, ahead of the rest', async () => {
    retrieveMock.mockImplementation(async (_env: unknown, query: string) =>
      Array.from({ length: 10 }, (_, i) =>
        chunk(`l-${query}-${i}`, 0.9, `Excerpt ${query} ${i}.`, 'doc-1'),
      ),
    );
    retrieveFromMock.mockImplementation(
      async (_env: unknown, query: unknown) => [
        chunk(`g-${String(query)}`, 0.31, `Clause ${String(query)}.`, 'doc-1'),
      ],
    );
    await readAll(
      (await generateReport(env, { templateKey: template.key })).textStream,
    );
    const text = userText();
    for (const q of template.subQueries) expect(text).toContain(`Clause ${q}.`);
    expect(text.match(/Excerpt |Clause /g)).toHaveLength(30);
    const lastGoverning = Math.max(
      ...template.subQueries.map((q) => text.indexOf(`Clause ${q}.`)),
    );
    expect(lastGoverning).toBeLessThan(text.indexOf('Excerpt '));
  });

  it('puts the best-matching governing passage first', async () => {
    const scores = [0.4, 0.8, 0.6, 0.5];
    retrieveFromMock.mockImplementation(
      async (_env: unknown, query: unknown) => {
        const i = template.subQueries.indexOf(String(query));
        return [chunk(`g-${i}`, scores[i], `Governing passage ${i}.`, 'doc-1')];
      },
    );
    await readAll(
      (await generateReport(env, { templateKey: template.key })).textStream,
    );
    expect(userText().match(/Governing passage \d/g)).toEqual([
      'Governing passage 1',
      'Governing passage 2',
      'Governing passage 3',
      'Governing passage 0',
    ]);
  });

  it('keeps one copy of a passage both searches return', async () => {
    retrieveMock.mockImplementation(async () => [
      chunk('l-1', 0.9, 'Leases must run a year.', 'doc-1'),
    ]);
    retrieveFromMock.mockImplementation(async () => [
      chunk('g-1', 0.5, 'Leases must run a year.', 'doc-1'),
    ]);
    await readAll(
      (await generateReport(env, { templateKey: template.key })).textStream,
    );
    expect(userText().match(/Leases must run a year\./g)).toHaveLength(1);
  });

  it('writes the report from the governing passages when the library search finds nothing', async () => {
    retrieveMock.mockImplementation(async () => []);
    retrieveFromMock.mockImplementation(async () => [
      chunk('g-1', 0.5, 'Article IX: leasing.', 'doc-1'),
    ]);
    const gen = await generateReport(env, { templateKey: template.key });
    await readAll(gen.textStream);
    expect(gen.sources.map((s) => s.id)).toEqual(['doc-1']);
    expect(userText()).toContain('Article IX: leasing.');
  });

  it('still writes the report, without governing passages, when the governing search fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    retrieveFromMock.mockImplementation(async () => {
      throw new Error('filter rejected');
    });
    const gen = await generateReport(env, { templateKey: template.key });
    expect((await readAll(gen.textStream)).length).toBeGreaterThan(0);
    expect(userText()).toContain(`Provision about ${template.subQueries[0]}.`);
    expect(userText()).toContain('- "CCRs"');
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('tells the model which governing documents exist, with titles pseudonymized', async () => {
    await readAll(
      (await generateReport(env, { templateKey: template.key })).textStream,
    );
    const text = userText();
    expect(text).toMatch(/^Governing documents in the library:\n- "CCRs"\n/);
    expect(text).toContain(`- "${SURROGATE_NAME} Easement"`);
    expect(text).not.toContain('Jane Q Homeowner');
    const system = (captured.genParams as { system: string }).system;
    expect(system).toMatch(/never say the association lacks a document/i);
  });
});
