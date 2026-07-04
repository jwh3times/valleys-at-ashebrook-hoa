import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { resolveAuthContext } from '../../../server/authz/api-guards';
import { tierAllows } from '../../../server/content/visibility';
import { getDb } from '../../../server/db/client';
import { documents } from '../../../server/db/schema';

export const prerender = false;

export const GET: APIRoute = async ({ params, request, locals }) => {
  const id = params.id!;
  const [doc] = await getDb(env)
    .select()
    .from(documents)
    .where(eq(documents.id, id));
  if (!doc) return new Response('Not Found', { status: 404 });

  if (doc.visibility !== 'public') {
    const ctx = await resolveAuthContext(locals, request, env);
    const role = ctx?.role ?? 'visitor';
    if (!tierAllows(role, doc.visibility))
      return new Response('Forbidden', { status: 403 });
  }

  const object = await env.DOCS.get(doc.r2Key);
  if (!object) return new Response('Not Found', { status: 404 });

  const headers = new Headers();
  headers.set('content-type', doc.contentType);
  headers.set('x-content-type-options', 'nosniff');
  // Strip control chars and quotes/backslashes so the filename can't break the
  // header or inject a second directive.
  const safeName = [...doc.filename]
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch !== '"' && ch !== '\\')
    .join('');
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
