import { getAnthropic } from './anthropic';
import type { Pseudonymizer } from './pii';

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
