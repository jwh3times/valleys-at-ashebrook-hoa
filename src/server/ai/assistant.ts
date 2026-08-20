import { getDb } from '../db/client';
import { owners, properties } from '../db/schema';
import { contactMethods, people } from '../db/roster-schema';
import { retrieve } from './search';
import { type Source } from './sources';
import { buildExcerptContext } from './context';
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
 * Load the roster into PII entries (names, phones, emails, and Lot addresses).
 * This feeds ONLY the pseudonymization dictionary, so it is deliberately not
 * filtered by status, interval, void, or consolidation — a former owner, an
 * ended contact method, a voided row, and a consolidated duplicate must all
 * still be masked if their values appear in document excerpts. Masking more
 * than necessary degrades an excerpt's readability; masking less leaks
 * resident PII to Anthropic, so every ambiguous case resolves toward masking.
 *
 * Both roster models are read and unioned. Since the ADR 0022 phase 3f flip
 * the PARTY roster is the live one — `/api/admin/roster-parties` and
 * `/api/admin/roster-contact-methods` write `people`/`contact_methods` with no
 * legacy mirror, so reading `owners` alone silently misses every Person
 * recorded after the flip (#233). The legacy tables are still read because
 * they still hold rows the backfill left in place; ADR 0022 phase 4 (#212)
 * drops them, and that is the change that makes the party-roster read the only
 * source rather than the primary one.
 *
 * Redacted values need no special handling: Roster Redaction nulls the value
 * and stamps its marker in the same mutation (`people_name_redaction_paired`,
 * `contact_methods_value_redaction_paired`), so a redacted row arrives here as
 * a NULL and is skipped — the dictionary must not resurrect a name the roster
 * has erased.
 *
 * ORGANIZATION NAMES ARE DELIBERATELY EXCLUDED, and this is the one place the
 * "resolve toward masking" rule is overridden. `buildPseudonymizer` tokenizes
 * every `name` entry into per-word matchers, so an Organization recorded as
 * "The Valleys at Ashebrook HOA" would register `Valleys` and `Ashebrook` as
 * name matchers and rewrite the neighborhood's own name into a surrogate
 * PERSON throughout every excerpt — corrupting the corpus rather than
 * protecting anyone. Organization CONTACT METHODS are still masked above:
 * an email or phone is matched literally, never tokenized, and an
 * organization's contact is often a resident's personal address in practice.
 * The residual gap is an Organization whose legal name embeds a person's name
 * ("The Smith Family Trust"), which needs a non-tokenized name entry type to
 * fix properly. See #233.
 */
export async function loadRosterEntries(env: Env): Promise<PiiEntry[]> {
  const db = getDb(env);
  const [ownerRows, propRows, personRows, contactRows] = await Promise.all([
    db
      .select({
        fullName: owners.fullName,
        phone: owners.phone,
        email: owners.email,
      })
      .from(owners),
    db.select({ address: properties.address }).from(properties),
    db.select({ fullName: people.fullName }).from(people),
    db
      .select({ channel: contactMethods.channel, value: contactMethods.value })
      .from(contactMethods),
  ]);

  const entries: PiiEntry[] = [];
  const seen = new Set<string>();
  const add = (type: PiiEntry['type'], value: string | null): void => {
    if (!value) return;
    // The same person appears in both models after the backfill; a duplicate
    // dictionary entry is harmless but pointless work at every surrogate tier.
    const key = `${type}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ type, value });
  };

  for (const o of ownerRows) {
    add('name', o.fullName);
    add('phone', o.phone);
    add('email', o.email);
  }
  for (const p of propRows) add('address', p.address);
  for (const p of personRows) add('name', p.fullName);
  for (const c of contactRows)
    add(c.channel === 'email' ? 'email' : 'phone', c.value);

  return entries;
}

interface DeltaEvent {
  type: string;
  delta?: { type: string; text?: string };
}
export interface ClaudeStream extends AsyncIterable<DeltaEvent> {
  finalMessage(): Promise<{ stop_reason: string | null }>;
}

export function claudeTextStream(stream: ClaudeStream): ReadableStream<string> {
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
  const pseud = buildPseudonymizer(await loadRosterEntries(env));
  const { sources, contextText, documentsFound } = await buildExcerptContext(
    env,
    chunks,
    pseud,
  );

  const history = (input.history ?? []).map((t) => ({
    role: t.role,
    // Anonymize the FULL turn, then cap the already-masked text — never cap raw
    // resident content (that could shear a value mid-string and leak a fragment).
    content: pseud
      .anonymize(t.content)
      .slice(0, INPUT_LIMITS.assistantQuestion),
  }));
  const userText =
    `Document excerpts:\n\n${contextText || '(no relevant excerpts found)'}\n\n` +
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
