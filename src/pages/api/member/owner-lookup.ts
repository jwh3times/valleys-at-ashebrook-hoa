import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requireMemberApi } from '../../../server/authz/member-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import {
  findActivePropertyByAddress,
  getActiveOwnersForProperty,
} from '../../../server/roster/lookup';
import { INPUT_LIMITS } from '../../../lib/types';

export const prerender = false;

/**
 * Resolve ONE typed street address to that lot's active owner names + ids,
 * so a grantor can name a holder the /vote flow can later authenticate
 * (holder_owner_id). Deliberate disclosure decision (ADR 0019): one lot per
 * explicit address query, names only — never phone or email — to a caller
 * who is already a verified homeowner behind the officialMode gate. The
 * roster as a browsable list stays board-only.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const gate = await requireMemberApi(locals, request, env);
  if (!gate.ok) return gate.res;
  if (gate.ctx.role !== 'board' && gate.ctx.propertyIds.length === 0)
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
  const active = await getActiveOwnersForProperty(db, property.id);
  return Response.json({
    propertyId: property.id,
    address: property.address,
    owners: active.map((o) => ({ id: o.id, fullName: o.fullName })),
  });
};
