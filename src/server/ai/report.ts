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

export const PLANNER_MODEL = 'claude-haiku-4-5';
export const REPORT_CONTEXT_CHUNK_CAP = 30;

const PLANNER_PROMPT = [
  'You expand a homeowners-association research topic into retrieval search queries.',
  'Return ONLY a JSON array of 3 to 6 short search queries covering the distinct angles of the topic as it would appear in HOA governing documents (CC&Rs, bylaws, articles, amendments, rules).',
  'No prose, no code fences — just the JSON array.',
].join('\n');

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
    const res = (await client.messages.create({
      model: PLANNER_MODEL,
      max_tokens: 500,
      system: PLANNER_PROMPT,
      messages: [{ role: 'user', content: `Topic: ${pseud.anonymize(topic)}` }],
    })) as { content: { type: string; text?: string }[] };
    const text =
      res.content.find((b) => b.type === 'text' && typeof b.text === 'string')
        ?.text ?? '';
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end <= start) return [topic];
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [topic];
    const queries = parsed
      .filter((q): q is string => typeof q === 'string' && q.trim() !== '')
      .slice(0, 6)
      .map((q) => pseud.deanonymize(q.trim()));
    return queries.length >= 1 ? queries : [topic];
  } catch {
    return [topic];
  }
}

const REPORT_MODEL = 'claude-opus-4-8';

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
  'If no relevant excerpts were found, say so plainly in the Summary and keep the other sections brief.',
  'Respond with the report only — no preamble.',
].join('\n');

export class UnknownTemplateError extends Error {
  constructor(key: string) {
    super(`Unknown report template: ${key}`);
    this.name = 'UnknownTemplateError';
  }
}

export interface ReportGeneration {
  topic: string; // template label, or the freeform topic as entered
  templateKey: string | null;
  sources: Source[]; // real titles; board-facing; NOT sent to Anthropic
  textStream: ReadableStream<string>; // de-anonymized markdown
}

/** Pool chunks across sub-queries: dedupe by (folder, content), best-score first, capped. */
function poolChunks(perQuery: AiSearchChunk[][]): AiSearchChunk[] {
  const seen = new Set<string>();
  const pooled: AiSearchChunk[] = [];
  for (const c of perQuery.flat()) {
    const key = `${c.metadata.folder} ${c.content}`;
    if (!seen.has(key)) {
      seen.add(key);
      pooled.push(c);
    }
  }
  pooled.sort((a, b) => b.score - a.score);
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
  const { sources, contextText } = await buildExcerptContext(
    env,
    pooled,
    pseud,
  );

  const userText =
    `Document excerpts:\n\n${contextText || '(no relevant excerpts found)'}\n\n` +
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
