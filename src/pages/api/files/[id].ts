import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { resolveAuthContext } from '../../../server/authz/api-guards';
import { documentVisibleTo } from '../../../server/content/visibility';
import { getDb } from '../../../server/db/client';
import { documents } from '../../../server/db/schema';

export const prerender = false;

export const GET: APIRoute = async ({ params, request, locals }) => {
  const id = params.id!;
  // Read only what a download needs. A bare select() names every column in
  // schema.ts, so a column added by a migration that has not reached
  // production yet (code deploys on merge; migrations are applied separately)
  // would otherwise be requested by every download.
  const [doc] = await getDb(env)
    .select({
      visibility: documents.visibility,
      r2Key: documents.r2Key,
      contentType: documents.contentType,
      filename: documents.filename,
    })
    .from(documents)
    .where(eq(documents.id, id));
  if (!doc) return new Response('Not Found', { status: 404 });

  if (doc.visibility !== 'public') {
    const ctx = await resolveAuthContext(locals, request, env);
    // The same predicate the document list uses (#294), so a download is
    // allowed exactly when the list shows the document. A hidden record
    // renders 404, never 403 — the same answer as an unknown id, so the
    // response never confirms the document exists.
    const [visible] = await getDb(env)
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, id), documentVisibleTo(ctx)));
    if (!visible) return new Response('Not Found', { status: 404 });
  }

  const object = await env.DOCS.get(doc.r2Key);
  if (!object) return new Response('Not Found', { status: 404 });

  const headers = new Headers();
  headers.set('content-type', doc.contentType);
  headers.set('x-content-type-options', 'nosniff');
  // Strip control chars and quotes/backslashes so the filename can't break the
  // header or inject a second directive.
  let safeName = '';
  for (const ch of doc.filename) {
    if (ch.charCodeAt(0) >= 0x20 && ch !== '"' && ch !== '\\') safeName += ch;
  }
  const disposition =
    doc.contentType === 'application/pdf' ? 'inline' : 'attachment';
  headers.set('content-disposition', `${disposition}; filename="${safeName}"`);
  headers.set(
    'cache-control',
    doc.visibility === 'public' ? 'public, max-age=3600' : 'private, no-store',
  );
  return new Response(object.body as unknown as ReadableStream<Uint8Array>, {
    headers,
  });
};
