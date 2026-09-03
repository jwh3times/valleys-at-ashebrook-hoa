import { getAnthropic } from './anthropic';
import { buildPseudonymizer, type Pseudonymizer } from './pii';
import { retrieve, type AiSearchChunk } from './search';
import { buildExcerptContext } from './context';
import {
  loadRosterEntries,
  claudeTextStream,
  type ClaudeStream,
} from './assistant';
import type { Source } from './sources';
import { REPORT_TEMPLATES } from '../../lib/reports';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod/v4';

export const PLANNER_MODEL = 'claude-haiku-4-5';
export const REPORT_CONTEXT_CHUNK_CAP = 30;

const PLANNER_PROMPT = [
  'You expand a homeowners-association research topic into retrieval search queries.',
  'Return 3 to 6 short search queries covering the distinct angles of the topic as it would appear in HOA governing documents (CC&Rs, bylaws, articles, amendments, rules).',
].join('\n');

const plannerOutput = z.object({
  queries: z.array(z.string()).min(3).max(6),
});

/**
 * Expand a freeform topic into retrieval sub-queries via a small Haiku call.
 * The topic is pseudonymized before it reaches Anthropic; returned queries are
 * de-anonymized so retrieval (which runs inside Cloudflare over real text)
 * matches real documents. Any failure degrades to [topic] — never throws.
 */
export async function planSubQueries(
  env: Env,
  pseud: Pseudonymizer,
  topic: string,
): Promise<string[]> {
  try {
    const client = getAnthropic(env);
    const res = await client.messages.parse({
      model: PLANNER_MODEL,
      max_tokens: 500,
      system: PLANNER_PROMPT,
      messages: [{ role: 'user', content: `Topic: ${pseud.anonymize(topic)}` }],
      output_config: { format: zodOutputFormat(plannerOutput) },
    });
    const queries = (res.parsed_output?.queries ?? [])
      .filter((q) => q.trim() !== '')
      .slice(0, 6)
      .map((q) => pseud.deanonymize(q.trim()));
    return queries.length >= 1 ? queries : [topic];
  } catch {
    return [topic];
  }
}

export const REPORT_MODEL = 'claude-opus-4-8';

// One logical instruction per element (same convention as assistant.ts).
const REPORT_SYSTEM_PROMPT = [
  'You write a structured research report for a neighborhood HOA board, grounded ONLY in the numbered document excerpts provided.',
  '',
  'Produce GitHub-flavored markdown with exactly these five sections, in order:',
  '## Summary — three to six sentences answering the topic overall.',
  '## What the documents say — the substantive provisions, grouped logically.',
  '## Where it lives — which document and section each provision comes from, as a list.',
  '## Ambiguities and conflicts — places the documents are unclear or disagree; if none, say so.',
  '## Gaps — aspects of the topic the documents do not address; if none, say so.',
  '',
  'Cite every claim drawn from an excerpt with its [Source N] label. When governing documents (CC&Rs, bylaws, articles, amendments, rules) conflict with other retrieved material, the governing documents control — note the difference.',
  'Do not present general knowledge as document content; if you add context the excerpts do not support, clearly mark it, for example "General knowledge (not from the documents):".',
  'Do not fabricate document contents or [Source N] citations. Names, addresses, phone numbers, and emails in the excerpts are placeholders — use them exactly as written; never alter, abbreviate, or reformat them.',
  'Respond with the report only — no preamble.',
].join('\n');

export class UnknownTemplateError extends Error {
  constructor(key: string) {
    super(`Unknown report template: ${key}`);
    this.name = 'UnknownTemplateError';
  }
}

export class NoRelevantDocumentsError extends Error {
  constructor() {
    super('No searchable documents matched this report topic');
    this.name = 'NoRelevantDocumentsError';
  }
}

export interface ReportGeneration {
  topic: string; // template label, or the freeform topic as entered
  templateKey: string | null;
  sources: Source[]; // real titles; board-facing; NOT sent to Anthropic
  textStream: ReadableStream<string>; // de-anonymized markdown
}

/** Pool chunks across sub-queries: best-score first, dedupe by (folder, content), capped. */
function poolChunks(perQuery: AiSearchChunk[][]): AiSearchChunk[] {
  // Sort BEFORE dedupe: a duplicate chunk can be returned at a low score by one
  // sub-query and a high score by another (they run independent retrievals), and
  // `perQuery.flat()` is in sub-query order, not score order. Sorting first means
  // the first-seen (kept) copy is always the best-scored one, so a strong hit
  // can't be discarded in favor of a weak duplicate before the cap is applied.
  const all = perQuery.flat().sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const pooled: AiSearchChunk[] = [];
  for (const c of all) {
    const key = `${c.metadata.folder} ${c.content}`;
    if (!seen.has(key)) {
      seen.add(key);
      pooled.push(c);
    }
  }
  return pooled.slice(0, REPORT_CONTEXT_CHUNK_CAP);
}

export async function generateReport(
  env: Env,
  input: { templateKey?: string; topic?: string },
): Promise<ReportGeneration> {
  const pseud = buildPseudonymizer(await loadRosterEntries(env));

  let topic: string;
  let templateKey: string | null;
  let subQueries: string[];
  if (input.templateKey) {
    const template = REPORT_TEMPLATES.find((t) => t.key === input.templateKey);
    if (!template) throw new UnknownTemplateError(input.templateKey);
    topic = template.label;
    templateKey = template.key;
    subQueries = template.subQueries;
  } else {
    topic = input.topic ?? '';
    templateKey = null;
    subQueries = await planSubQueries(env, pseud, topic);
  }

  const perQuery = await Promise.all(subQueries.map((q) => retrieve(env, q)));
  const pooled = poolChunks(perQuery);
  if (pooled.length === 0) throw new NoRelevantDocumentsError();
  const { sources, contextText } = await buildExcerptContext(
    env,
    pooled,
    pseud,
  );
  if (sources.length === 0 || contextText.trim() === '')
    throw new NoRelevantDocumentsError();

  const userText =
    `Document excerpts:\n\n${contextText}\n\n` +
    `Report topic: ${pseud.anonymize(topic)}`;

  const client = getAnthropic(env);
  // Same ceiling rationale as chat: adaptive thinking spends from max_tokens,
  // and a report is a much longer visible output than a chat answer.
  const stream = client.messages.stream({
    model: REPORT_MODEL,
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: REPORT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userText }],
  }) as unknown as ClaudeStream;

  const textStream = claudeTextStream(stream).pipeThrough(
    pseud.deanonymizeStream(),
  );
  return { topic, templateKey, sources, textStream };
}
