import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { normalizeVoteAction } from '../../lib/types';
import { requireVotingApi } from '../../server/authz/voting-guards';
import {
  castElectionBallot,
  castMotionVote,
} from '../../server/content/voting';
import { readJson } from '../../server/http';

export const POST: APIRoute = async ({ request, locals }) => {
  const gate = await requireVotingApi(locals, request, env);
  if (!gate.ok) return gate.res;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const action = normalizeVoteAction(parsed.value);
  if (!action.ok) return new Response(action.error, { status: 400 });
  const result =
    action.value.action === 'castBallot'
      ? await castElectionBallot(env, gate.ctx, action.value)
      : await castMotionVote(env, gate.ctx, action.value);
  return result.ok
    ? new Response(null, { status: 204 })
    : new Response(result.message, { status: result.status });
};
