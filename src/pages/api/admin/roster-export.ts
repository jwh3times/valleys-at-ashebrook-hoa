import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import {
  AuditCorrelation,
  ALWAYS,
  operationKey,
} from '../../../server/roster/audit';
import { fetchAdminRoster } from '../../../server/roster/reads';
import { associationDateIso } from '../../../lib/format';

export const prerender = false;

// ADR 0022 phase 3b (#218), #205's bulk roster export: the complete roster,
// assembled on demand and NEVER persisted server-side — there is no export
// cache, no generated file, nothing at rest for a later request to read.
//
// POST is deliberately the verb, not GET: this is the one read in the system
// that is ALSO a recorded act (#197), and POST is what keeps it inside the
// operator write freeze rather than living in the read-only half of the
// admin surface that stays live during a freeze.
//
// The Access Event is written and its batch committed BEFORE any roster row
// is assembled. If the ledger write fails for any reason, the export is
// withheld entirely — fail-closed: a board member must never walk away with
// roster data the ledger cannot prove was ever requested.
export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const ctx = await resolveAuthContext(locals, request, env);
  // requireBoard already required a resolvable, board-capable context; a null
  // result here means the gate and this lookup disagree, which is a deeper
  // problem than an ordinary anonymous request.
  if (!ctx) return new Response('Unauthorized', { status: 401 });

  const nowMs = Date.now();
  const correlation = new AuditCorrelation(env.DATABASE, {
    operationKey: operationKey('roster-export', 'export'),
    actorAccountId: ctx.userId,
    nowMs,
  });
  correlation.event({
    kind: 'roster_export',
    guard: ALWAYS,
    detail: {
      family: 'access',
      requestedAction: 'roster_export',
      outcome: 'allowed',
      reason: null,
    },
  });

  try {
    await env.DATABASE.batch(correlation.statements);
  } catch {
    return new Response('Export could not be recorded', { status: 500 });
  }

  const associationDay = associationDateIso();
  const roster = await fetchAdminRoster(env, associationDay);
  return Response.json({ generatedAt: nowMs, roster });
};
