import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { getDb } from '../../../server/db/client';
import { settings } from '../../../server/db/schema';
import { normalizeDuesSettings } from '../../../lib/types';
import { getDuesSettings } from '../../../server/content/settings';
import { readJson } from '../../../server/http';

export const prerender = false;

// The dues blob's READ lives here rather than under /api/content, because the
// board's Dues panel is its only caller: `/dues` reads `getDuesSettings`
// server-side in its own frontmatter and never touches an endpoint (#364).
// Beside the PUT it mirrors, the pair is symmetric — both `requireBoard` —
// and the route is covered by the middleware backstop and enumerated by the
// all-gated and permission-matrix suites without anyone registering it.
//
// Deliberately NOT gated on `officialMode`, matching the PUT: the board
// prepares dues content BEFORE official adoption (#361), so a flag-gated read
// would leave them able to save settings they cannot load back.
export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  return Response.json(await getDuesSettings(env));
};

export const PUT: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const value = JSON.stringify(normalizeDuesSettings(parsed.value));
  const now = new Date();
  await getDb(env)
    .insert(settings)
    .values({ key: 'dues', value, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: now },
    });
  return new Response(null, { status: 204 });
};
