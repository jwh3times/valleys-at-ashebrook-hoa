import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { owners, properties } from '../db/schema';
import { retrieve } from './search';
import { toSources, type Source } from './sources';
import { buildPseudonymizer, type PiiEntry } from './pii';
import { getAnthropic } from './anthropic';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}
export interface AnswerResult {
  sources: Source[];
  textStream: ReadableStream<string>;
}

const MODEL = 'claude-opus-4-8';

const SYSTEM_PROMPT = [
  "You are an assistant for the neighborhood board. Answer the board member's",
  'question using ONLY the numbered document excerpts provided.',
  'Cite the excerpts you used by their [Source N] label. If the answer is not in',
  'the excerpts, say you could not find it in the documents. Do not invent facts.',
  'Names, addresses, phone numbers, and emails in the excerpts are placeholders —',
  'use them exactly as written; never alter, abbreviate, or reformat them.',
  'Respond with the answer only — no preamble or meta-commentary.',
].join(' ');

/** Load the roster into PII entries (active owners' names/phones/emails + property addresses). */
export async function loadRosterEntries(env: Env): Promise<PiiEntry[]> {
  const db = getDb(env);
  const [ownerRows, propRows] = await Promise.all([
    db
      .select({
        fullName: owners.fullName,
        phone: owners.phone,
        email: owners.email,
      })
      .from(owners)
      .where(eq(owners.status, 'active')),
    db
      .select({ address: properties.address })
      .from(properties)
      .where(eq(properties.status, 'active')),
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
  const sources = await toSources(env, chunks);
  const pseud = buildPseudonymizer(await loadRosterEntries(env));

  const context = chunks
    .map((c, i) => `[Source ${i + 1}]\n${pseud.anonymize(c.content)}`)
    .join('\n\n');
  const history = (input.history ?? []).map((t) => ({
    role: t.role,
    content: pseud.anonymize(t.content),
  }));
  const userText =
    `Document excerpts:\n\n${context || '(no relevant excerpts found)'}\n\n` +
    `Question: ${pseud.anonymize(input.question)}`;

  const client = getAnthropic(env);
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    messages: [...history, { role: 'user', content: userText }],
  }) as unknown as ClaudeStream;

  const textStream = claudeTextStream(stream).pipeThrough(
    pseud.deanonymizeStream(),
  );
  return { sources, textStream };
}
