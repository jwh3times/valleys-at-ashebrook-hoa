import type { APIRoute } from 'astro';
import { desc, eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import { reports } from '../../../server/db/schema';
import { INPUT_LIMITS } from '../../../lib/types';
import {
  generateReport,
  UnknownTemplateError,
} from '../../../server/ai/report';
import { AiSearchUnavailableError } from '../../../server/ai/search';
import { AssistantNotConfiguredError } from '../../../server/ai/anthropic';

export const prerender = false;

function sseFrame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const ctx = await resolveAuthContext(locals, request, env);

  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const template = stringField(parsed.value, 'template');
  const topic = stringField(parsed.value, 'topic');
  if ((template === '') === (topic === '')) {
    return new Response('Provide exactly one of template or topic', {
      status: 400,
    });
  }
  if (topic.length > INPUT_LIMITS.reportTopic) {
    return new Response('topic is too long', { status: 400 });
  }

  let generation;
  try {
    generation = await generateReport(
      env,
      template ? { templateKey: template } : { topic },
    );
  } catch (err) {
    if (err instanceof UnknownTemplateError) {
      return new Response('Unknown report template', { status: 400 });
    }
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

  const { sources, textStream } = generation;
  let reader: ReadableStreamDefaultReader<string> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(sseFrame('sources', sources));
      reader = textStream.getReader();
      let contentMd = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            contentMd += value;
            controller.enqueue(sseFrame('token', { text: value }));
          }
        }
        // Save BEFORE emitting done — a failed insert must not report success.
        const id = crypto.randomUUID();
        await getDb(env)
          .insert(reports)
          .values({
            id,
            topic: generation.topic,
            templateKey: generation.templateKey,
            contentMd,
            sourcesJson: JSON.stringify(
              sources.map((s) => ({
                id: s.id,
                title: s.title,
                category: s.category,
              })),
            ),
            createdAt: new Date(),
            createdBy: ctx?.userId ?? 'unknown',
          });
        controller.enqueue(sseFrame('done', { id }));
      } catch {
        controller.enqueue(
          sseFrame('error', {
            message: 'Report generation failed. Please try again.',
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

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const db = getDb(env);
  const id = new URL(request.url).searchParams.get('id');

  if (id) {
    const rows = await db.select().from(reports).where(eq(reports.id, id));
    if (rows.length === 0) return new Response('Not found', { status: 404 });
    const r = rows[0];
    return Response.json({
      id: r.id,
      topic: r.topic,
      templateKey: r.templateKey,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdBy,
      contentMd: r.contentMd,
      sources: JSON.parse(r.sourcesJson),
    });
  }

  const rows = await db
    .select({
      id: reports.id,
      topic: reports.topic,
      templateKey: reports.templateKey,
      createdAt: reports.createdAt,
      createdBy: reports.createdBy,
    })
    .from(reports)
    .orderBy(desc(reports.createdAt));
  return Response.json(
    rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
  );
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const id = stringField(parsed.value, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  const db = getDb(env);
  const rows = await db
    .select({ id: reports.id })
    .from(reports)
    .where(eq(reports.id, id));
  if (rows.length === 0) return new Response('Not found', { status: 404 });
  await db.delete(reports).where(eq(reports.id, id));
  return new Response(null, { status: 204 });
};
