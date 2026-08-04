import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireMemberApi } from '../../../server/authz/member-guards';
import { requirePropertyAccess, Forbidden } from '../../../server/authz/guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import {
  proxies,
  meetings,
  elections,
  owners,
} from '../../../server/db/schema';
import {
  duplicateProxyExists,
  proxyUseLabels,
} from '../../../server/content/proxy-guards';
import { getActiveOwnersForProperty } from '../../../server/roster/lookup';
import { fetchMemberProxies } from '../../../server/content/reads';
import { visibleTiers } from '../../../server/content/visibility';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const gate = await requireMemberApi(locals, request, env);
  if (!gate.ok) return gate.res;
  return Response.json(await fetchMemberProxies(env, gate.ctx.propertyIds));
};

export const POST: APIRoute = async ({ request, locals }) => {
  const gate = await requireMemberApi(locals, request, env);
  if (!gate.ok) return gate.res;
  const ctx = gate.ctx;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const propertyId = stringField(parsed.value, 'propertyId');
  const grantorOwnerId = stringField(parsed.value, 'grantorOwnerId');
  const holderOwnerId = stringField(parsed.value, 'holderOwnerId');
  const meetingIdRaw = stringField(parsed.value, 'meetingId');
  const electionIdRaw = stringField(parsed.value, 'electionId');
  const meetingId = meetingIdRaw === '' ? null : meetingIdRaw;
  const electionId = electionIdRaw === '' ? null : electionIdRaw;
  if (!propertyId || !grantorOwnerId || !holderOwnerId)
    return new Response(
      'propertyId, grantorOwnerId, and holderOwnerId are required',
      { status: 400 },
    );
  if ((meetingId === null) === (electionId === null))
    return new Response('Exactly one of meetingId or electionId is required', {
      status: 400,
    });

  // Lot scoping: the fail-closed primitive, not a hand-rolled includes().
  // 403 for a lot outside ctx.propertyIds — whether or not it exists, since
  // "not yours" and "not real" must be indistinguishable here.
  try {
    requirePropertyAccess(ctx, propertyId);
  } catch (e) {
    if (e instanceof Forbidden)
      return new Response('Forbidden', { status: 403 });
    throw e;
  }

  const db = getDb(env);
  // Grantor: self-selected identity, but only among the lot's ACTIVE owners
  // (ADR 0019's lot-scoped trust model — control of the lot is proven,
  // identity within it is asserted).
  const lotOwners = await getActiveOwnersForProperty(db, propertyId);
  if (!lotOwners.some((o) => o.id === grantorOwnerId))
    return new Response('grantorOwnerId is not an active owner of this lot', {
      status: 400,
    });

  // Occasion: must exist AND sit inside the caller's visibility tiers —
  // failing either is the same 404, never confirming a board-only occasion
  // exists. Grantable = member-body + not yet past (meetings), non-terminal
  // + not yet past (elections). ISO dates compare lexically.
  const today = new Date().toISOString().slice(0, 10);
  const tiers = visibleTiers(ctx.role);
  if (meetingId !== null) {
    const [m] = await db
      .select({
        body: meetings.body,
        date: meetings.date,
        visibility: meetings.visibility,
      })
      .from(meetings)
      .where(eq(meetings.id, meetingId))
      .limit(1);
    if (!m || !tiers.includes(m.visibility))
      return new Response('Occasion not found', { status: 404 });
    if (m.body !== 'member')
      return new Response(
        'Proxies apply to member meetings — this is a board meeting',
        { status: 409 },
      );
    if (m.date < today)
      return new Response('This occasion has already passed', { status: 409 });
  } else {
    const [e] = await db
      .select({
        status: elections.status,
        date: elections.electionDate,
        visibility: elections.visibility,
      })
      .from(elections)
      .where(eq(elections.id, electionId!))
      .limit(1);
    if (!e || !tiers.includes(e.visibility))
      return new Response('Occasion not found', { status: 404 });
    if (
      e.status === 'closed' ||
      e.status === 'certified' ||
      e.status === 'void'
    )
      return new Response('This election is no longer accepting proxies', {
        status: 409,
      });
    if (e.date < today)
      return new Response('This occasion has already passed', { status: 409 });
  }

  // Holder: must resolve to an ACTIVE owner (an online grant always carries
  // holder_owner_id so the holder can act at /vote in PR 7c), and never the
  // grantor themselves.
  const holderRows = await db
    .select({ id: owners.id, fullName: owners.fullName })
    .from(owners)
    .where(and(eq(owners.id, holderOwnerId), eq(owners.status, 'active')))
    .limit(1);
  if (holderRows.length === 0)
    return new Response('Holder owner not found', { status: 404 });
  if (holderOwnerId === grantorOwnerId)
    return new Response(
      'grantorOwnerId and holderOwnerId cannot be the same owner',
      { status: 400 },
    );

  if (await duplicateProxyExists(db, propertyId, meetingId, electionId))
    return new Response('This lot already has a proxy for this occasion', {
      status: 409,
    });

  const nowDate = new Date();
  const id = crypto.randomUUID();
  await db.insert(proxies).values({
    id,
    propertyId,
    grantorOwnerId,
    holderName: holderRows[0].fullName,
    holderOwnerId,
    meetingId,
    electionId,
    createdBy: ctx.userId,
    createdAt: nowDate,
    updatedAt: nowDate,
  });
  return Response.json({ id }, { status: 201 });
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const gate = await requireMemberApi(locals, request, env);
  if (!gate.ok) return gate.res;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const id = stringField(parsed.value, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  const db = getDb(env);
  const rows = await db
    .select({ propertyId: proxies.propertyId })
    .from(proxies)
    .where(eq(proxies.id, id))
    .limit(1);
  // Unknown id and someone else's proxy answer identically — a caller must
  // not be able to probe which proxy ids exist.
  if (rows.length === 0 || !gate.ctx.propertyIds.includes(rows[0].propertyId))
    return new Response('Proxy not found', { status: 404 });
  const labels = await proxyUseLabels(db, id);
  if (labels.length > 0)
    return new Response(
      `Proxy is in use (${labels.join(', ')}) — remove those records first`,
      { status: 409 },
    );
  await db.delete(proxies).where(eq(proxies.id, id));
  return new Response(null, { status: 204 });
};
