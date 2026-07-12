import { getDb } from '../db/client';
import { owners, properties } from '../db/schema';
import { retrieve } from './search';
import { toSources, docIdFromFolder, type Source } from './sources';
import { buildPseudonymizer, type PiiEntry } from './pii';
import { getAnthropic } from './anthropic';
import { INPUT_LIMITS } from '../../lib/types';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}
export interface AnswerResult {
  sources: Source[]; // real titles; board-facing; NOT sent to Anthropic
  textStream: ReadableStream<string>;
  documentsFound: boolean; // sources.length > 0
}

const MODEL = 'claude-opus-4-8';

// One logical instruction per array element (joined with newlines). Keep phrases
// like the general-knowledge label intact on a single element — don't split them
// across elements, or a mid-phrase newline creeps into the prompt.
const SYSTEM_PROMPT = [
  'You are an assistant for the neighborhood board. You have two sources to answer with: the numbered document excerpts provided below, and your own general knowledge.',
  '',
  'Prefer the document excerpts. When they are relevant, ground your answer in them and cite each one you use by its [Source N] label. You may also use general knowledge to add context, explain concepts, or answer questions the documents do not cover.',
  '',
  'Make it unambiguous which parts of your answer come from the documents and which are general knowledge not found in them:',
  '- Present facts drawn from the excerpts plainly and cite them with [Source N].',
  '- Clearly mark any statement that comes from general knowledge and is not supported by the excerpts — for example, prefix it with "General knowledge (not from the documents):" — and never present such information as if it came from the HOA’s documents.',
  '- If the documents and general knowledge disagree, defer to the documents and note the difference.',
  '- If you can answer from neither, say so.',
  '',
  'Do not fabricate document contents or [Source N] citations for claims the excerpts do not support. Names, addresses, phone numbers, and emails in the excerpts are placeholders — use them exactly as written; never alter, abbreviate, or reformat them. Respond with the answer only — no preamble or meta-commentary.',
].join('\n');

/**
 * Load the roster into PII entries (owners' names/phones/emails + property
 * addresses). This feeds ONLY the pseudonymization dictionary, so it is not
 * filtered to active status — former owners and inactive properties must
 * still be masked if their names or addresses appear in document excerpts.
 */
export async function loadRosterEntries(env: Env): Promise<PiiEntry[]> {
  const db = getDb(env);
  const [ownerRows, propRows] = await Promise.all([
    db
      .select({
        fullName: owners.fullName,
        phone: owners.phone,
        email: owners.email,
      })
      .from(owners),
    db.select({ address: properties.address }).from(properties),
  ]);
  const entries: PiiEntry[] = [];
  for (const o of ownerRows) {
    if (o.fullName) entries.push({ type: 'name', value: o.fullName });
    if (o.phone) entries.push({ type: 'phone', value: o.phone });
    if (o.email) entries.push({ type: 'email', value: o.email });
  }
  for (const p of propRows)
    if (p.address) entries.push({ type: 'address', value: p.address });
  return entries;
}

interface DeltaEvent {
  type: string;
  delta?: { type: string; text?: string };
}
interface ClaudeStream extends AsyncIterable<DeltaEvent> {
  finalMessage(): Promise<{ stop_reason: string | null }>;
}

function claudeTextStream(stream: ClaudeStream): ReadableStream<string> {
  return new ReadableStream<string>({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (
            event.type === 'content_block_delta' &&
            event.delta?.type === 'text_delta' &&
            event.delta.text
          ) {
            controller.enqueue(event.delta.text);
          }
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === 'refusal') {
          controller.enqueue(
            '\n\n[The assistant declined to answer this request.]',
          );
        } else if (final.stop_reason === 'max_tokens') {
          controller.enqueue(
            '\n\n[This answer was cut off by the length limit. Ask a follow-up to continue.]',
          );
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

export async function answer(
  env: Env,
  input: { question: string; history?: Turn[] },
): Promise<AnswerResult> {
  const chunks = await retrieve(env, input.question);
  const allSources = await toSources(env, chunks);
  const pseud = buildPseudonymizer(await loadRosterEntries(env));

  // Keep only chunks that resolve to a real document (drop orphan-vector chunks
  // whose uuid has no D1 row — ADR 0009 — and any empty-content chunk). Orphan
  // text must never reach the model, and never render as a bare [Source].
  const bySourceId = new Map(allSources.map((s) => [s.id, s]));
  const resolvedChunks = chunks.filter((c) => {
    const id = docIdFromFolder(c.metadata.folder);
    return !!id && bySourceId.has(id) && c.content.trim() !== '';
  });

  // Sources = only documents that contributed a resolved chunk, first-seen order.
  const resolvedIds: string[] = [];
  const seen = new Set<string>();
  for (const c of resolvedChunks) {
    const id = docIdFromFolder(c.metadata.folder)!;
    if (!seen.has(id)) {
      seen.add(id);
      resolvedIds.push(id);
    }
  }
  const sources = resolvedIds.map((id) => bySourceId.get(id)!);
  const documentsFound = sources.length > 0;

  // Number excerpts per-document (matching `sources` order). Each label carries
  // the category (PII-free) and the pseudonymized title so the model can ground
  // and name its citations without ever seeing a real title.
  const indexByDocId = new Map(sources.map((s, i) => [s.id, i + 1]));
  const context = resolvedChunks
    .map((c) => {
      const id = docIdFromFolder(c.metadata.folder)!;
      const src = bySourceId.get(id)!;
      const idx = indexByDocId.get(id)!;
      const label = `[Source ${idx}] ${src.category} — "${pseud.anonymize(src.title)}"`;
      return `${label}\n${pseud.anonymize(c.content)}`;
    })
    .join('\n\n');

  const history = (input.history ?? []).map((t) => ({
    role: t.role,
    // Anonymize the FULL turn, then cap the already-masked text — never cap raw
    // resident content (that could shear a value mid-string and leak a fragment).
    content: pseud
      .anonymize(t.content)
      .slice(0, INPUT_LIMITS.assistantQuestion),
  }));
  const userText =
    `Document excerpts:\n\n${context || '(no relevant excerpts found)'}\n\n` +
    `Question: ${pseud.anonymize(input.question)}`;

  const client = getAnthropic(env);
  // max_tokens is a ceiling, not a spend — only generated tokens are billed.
  // Adaptive thinking draws from this same budget, so keep it well above
  // chat-answer size or thinking can consume it and truncate the answer.
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: SYSTEM_PROMPT,
    messages: [...history, { role: 'user', content: userText }],
  }) as unknown as ClaudeStream;

  const textStream = claudeTextStream(stream).pipeThrough(
    pseud.deanonymizeStream(),
  );
  return { sources, textStream, documentsFound };
}
