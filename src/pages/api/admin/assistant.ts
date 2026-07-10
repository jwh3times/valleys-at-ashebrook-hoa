import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { INPUT_LIMITS } from '../../../lib/types';
import { answer, type Turn } from '../../../server/ai/assistant';
import { AiSearchUnavailableError } from '../../../server/ai/search';
import { AssistantNotConfiguredError } from '../../../server/ai/anthropic';

export const prerender = false;

function sseFrame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

function parseHistory(body: unknown): Turn[] {
  const raw = (body as { history?: unknown } | null)?.history;
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(-10)
    .map((t) => {
      const role = (t as { role?: unknown })?.role;
      const content = (t as { content?: unknown })?.content;
      if (
        (role === 'user' || role === 'assistant') &&
        typeof content === 'string'
      ) {
        return {
          role,
          content: content.slice(0, INPUT_LIMITS.assistantQuestion),
        };
      }
      return null;
    })
    .filter((t): t is Turn => t !== null);
}

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;

  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const question = stringField(parsed.value, 'question');
  if (!question) return new Response('question is required', { status: 400 });
  if (question.length > INPUT_LIMITS.assistantQuestion) {
    return new Response('question is too long', { status: 400 });
  }
  const history = parseHistory(parsed.value);

  let result;
  try {
    result = await answer(env, { question, history });
  } catch (err) {
    if (err instanceof AssistantNotConfiguredError) {
      return new Response("The assistant isn't configured", { status: 500 });
    }
    if (err instanceof AiSearchUnavailableError) {
      return new Response('Document search is temporarily unavailable', {
        status: 503,
      });
    }
    throw err;
  }

  const { sources, textStream } = result;
  let reader: ReadableStreamDefaultReader<string> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(sseFrame('sources', sources));
      reader = textStream.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(sseFrame('token', { text: value }));
        }
        controller.enqueue(sseFrame('done', {}));
      } catch {
        controller.enqueue(
          sseFrame('error', {
            message: 'The assistant hit an error. Please try again.',
          }),
        );
      } finally {
        controller.close();
      }
    },
    cancel() {
      void reader?.cancel();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
};
