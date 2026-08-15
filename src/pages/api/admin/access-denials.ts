import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requireApiCapability } from '../../../server/authz/api-guards';

export const prerender = false;

// Access-denial detail (#205, #217): the System-Administrator-only view of
// every DENIED privileged access attempt the ledger recorded — grants,
// revocations, bootstrap, roster export, and the write-path's own
// grant-precondition re-validation refusals (src/server/authz/revalidation-event.ts).
// Ordinary 401/403 traffic never reaches this table; see access_events'
// schema comment for what does and does not belong here.
export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireApiCapability(
    locals,
    request,
    env,
    'accessDenialDetail',
  );
  if (denied) return denied;
  const { results } = await env.DATABASE.prepare(
    `SELECT e.id, e.recorded_at, e.actor_account_id, e.event_kind,
            a.access_grant_id, a.target_account_id, a.grant_type,
            a.requested_action, a.reason_code
       FROM access_events a
       JOIN audit_events e ON e.id = a.event_id
      WHERE a.outcome = 'denied'
      ORDER BY e.recorded_at DESC`,
  ).all();
  return Response.json(results);
};
