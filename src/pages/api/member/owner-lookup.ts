import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requireMemberApi } from '../../../server/authz/member-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import { findActivePropertyByAddress } from '../../../server/roster/lookup';
import { fetchLotAuthority } from '../../../server/roster/authority';
import { associationDateIso } from '../../../lib/format';
import { INPUT_LIMITS } from '../../../lib/types';

export const prerender = false;

/**
 * Resolve ONE typed street address to the names + ids of the Persons who may
 * act for that lot, so a grantor can name a holder the /vote flow can later
 * authenticate (holder_person_id). Deliberate disclosure decision (ADR 0019):
 * one lot per explicit address query, names only — never phone or email — to a
 * caller who is already a verified homeowner behind the officialMode gate. The
 * roster as a browsable list stays board-only.
 *
 * #248 part 2 moved the answer from the lot's active `owners` rows to the
 * roster's Lot Authority, so an Organization's Representative is now nameable
 * where the legacy shape could only offer the entity itself — which could not
 * have been authenticated at /vote at all.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const gate = await requireMemberApi(locals, request, env);
  if (!gate.ok) return gate.res;
  // Capability question, asked on the capability axis: board may look up any
  // lot's owners; anyone else needs at least one lot of their own. Identical
  // under legacy synthesis (board carries `board`, a linked homeowner's
  // lotIds are their propertyIds); under derived, a board member who owns no
  // Lot still passes on the `board` capability, which is the intent.
  if (!gate.ctx.capabilities.has('board') && gate.ctx.lotIds.length === 0)
    return new Response('Forbidden', { status: 403 });
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const address = stringField(parsed.value, 'address');
  if (!address) return new Response('address is required', { status: 400 });
  if (address.length > INPUT_LIMITS.address)
    return new Response('address is too long', { status: 400 });
  const db = getDb(env);
  const property = await findActivePropertyByAddress(db, address);
  if (!property) return new Response('No matching property', { status: 404 });
  const holders = await fetchLotAuthority(
    db,
    [property.id],
    associationDateIso(),
  );
  return Response.json({
    propertyId: property.id,
    address: property.address,
    persons: holders.map((h) => ({ id: h.personId, fullName: h.fullName })),
  });
};
