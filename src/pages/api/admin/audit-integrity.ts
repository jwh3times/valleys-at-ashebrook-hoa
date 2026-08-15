import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requireApiCapability } from '../../../server/authz/api-guards';

export const prerender = false;

// Audit integrity views (#205, #217): the System-Administrator-only surface
// over the two operator-run integrity checks migration 0023/0025 define —
// structural violations of the ledger's own rules
// (audit_integrity_violations_v) and Board Terms whose qualifying basis has
// disappeared (board_eligibility_violations_v). Both are query shapes, never
// authorization boundaries: live access reads current domain rows and must
// never grant because a reconstruction succeeded or deny because one failed.
// A non-empty result here is an anomaly to investigate, not an input to any
// permission decision.
export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireApiCapability(
    locals,
    request,
    env,
    'auditIntegrityViews',
  );
  if (denied) return denied;
  const [auditViolations, boardEligibilityViolations] = await Promise.all([
    env.DATABASE.prepare('SELECT * FROM audit_integrity_violations_v').all(),
    env.DATABASE.prepare('SELECT * FROM board_eligibility_violations_v').all(),
  ]);
  return Response.json({
    auditViolations: auditViolations.results,
    boardEligibilityViolations: boardEligibilityViolations.results,
  });
};
