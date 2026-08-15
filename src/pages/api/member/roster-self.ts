import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requireMemberApi } from '../../../server/authz/member-guards';
import { fetchMemberRosterSelf } from '../../../server/roster/reads';
import { associationDateIso } from '../../../lib/format';

// ADR 0022 phase 3b (#218): a member's read of their OWN roster identity —
// their Person record, Contact Methods (including values — #205's privacy
// ceiling is about another party's contact data, never the caller's own),
// Ownerships, Representations, and open correction requests. Never the audit
// ledger, and never another party's data; see `fetchMemberRosterSelf`
// (src/server/roster/reads.ts) for the privacy boundaries that live in the
// read itself.

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const gate = await requireMemberApi(locals, request, env);
  if (!gate.ok) return gate.res;
  // The one deliberate exception to the masked-404 convention (#205): an
  // authenticated caller with no linked Person cannot fix that by signing in
  // again, so the response points them at verification instead of pretending
  // the resource is simply missing. Under `cutover_mode = legacy` every caller
  // hits this — legacy has no Person concept at all — which is by design until
  // the flip; `personId` only becomes non-null once `derived` is serving.
  if (!gate.ctx.personId)
    return new Response(
      'Your account is not linked to a resident record — complete verification first.',
      { status: 403 },
    );
  const self = await fetchMemberRosterSelf(
    env,
    gate.ctx.personId,
    associationDateIso(),
  );
  // Defensive only: personId always names a real people row (person_links and
  // access derivation both resolve through a live FK), so this should be
  // unreachable. Fail closed rather than throw if it ever isn't.
  if (!self) return new Response('Not found', { status: 404 });
  return Response.json(self);
};
