import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireMemberApi } from '../../../server/authz/member-guards';
import { requirePropertyAccess, Forbidden } from '../../../server/authz/guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import { proxies, meetings, elections } from '../../../server/db/schema';
import {
  duplicateProxyExists,
  proxyUseLabels,
} from '../../../server/content/proxy-guards';
import {
  fetchLotAuthority,
  fetchPersonAuthority,
} from '../../../server/roster/authority';
import { fetchMemberProxies } from '../../../server/content/reads';
import { visibleTiers } from '../../../server/content/visibility';
import { associationDateIso } from '../../../lib/format';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals }) => {
  const gate = await requireMemberApi(locals, request, env);
  if (!gate.ok) return gate.res;
  return Response.json(
    await fetchMemberProxies(env, gate.ctx.role, gate.ctx.propertyIds),
  );
};

export const POST: APIRoute = async ({ request, locals }) => {
  const gate = await requireMemberApi(locals, request, env);
  if (!gate.ok) return gate.res;
  const ctx = gate.ctx;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const propertyId = stringField(parsed.value, 'propertyId');
  const grantorPersonId = stringField(parsed.value, 'grantorPersonId');
  const holderPersonId = stringField(parsed.value, 'holderPersonId');
  const meetingIdRaw = stringField(parsed.value, 'meetingId');
  const electionIdRaw = stringField(parsed.value, 'electionId');
  const meetingId = meetingIdRaw === '' ? null : meetingIdRaw;
  const electionId = electionIdRaw === '' ? null : electionIdRaw;
  if (!propertyId || !grantorPersonId || !holderPersonId)
    return new Response(
      'propertyId, grantorPersonId, and holderPersonId are required',
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
  const today = associationDateIso();
  // Grantor: self-selected identity, but only among the Persons who currently
  // hold Lot Authority here (ADR 0019's lot-scoped trust model — control of
  // the lot is proven, identity within it is asserted). #248 part 2 moved this
  // from the lot's ACTIVE owners to the roster's answer, which also lets an
  // Organization's Representative sign for the entity's lot.
  const lotPersons = await fetchLotAuthority(db, [propertyId], today);
  if (!lotPersons.some((p) => p.personId === grantorPersonId))
    return new Response(
      'grantorPersonId does not hold authority for this lot',
      { status: 400 },
    );

  // Occasion: must exist AND sit inside the caller's visibility tiers —
  // failing either is the same 404, never confirming a board-only occasion
  // exists. Grantable = member-body + not yet past (meetings), non-terminal
  // + not yet past (elections). ISO dates compare lexically.
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

  // Holder: must be a Person who currently holds Lot Authority somewhere (an
  // online grant always carries holder_person_id so the holder can act at
  // /vote), and never the grantor themselves. The lot they hold authority over
  // is deliberately not required to be this one — delegating to a neighbour is
  // the ordinary case.
  const [holder] = await fetchPersonAuthority(db, holderPersonId, today);
  if (!holder) return new Response('Holder person not found', { status: 404 });
  if (holderPersonId === grantorPersonId)
    return new Response(
      'grantorPersonId and holderPersonId cannot be the same person',
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
    grantorPersonId,
    holderName: holder.fullName,
    holderPersonId,
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
    .select({
      propertyId: proxies.propertyId,
      meetingId: proxies.meetingId,
      electionId: proxies.electionId,
    })
    .from(proxies)
    .where(eq(proxies.id, id))
    .limit(1);
  // Unknown id and someone else's proxy answer identically — a caller must
  // not be able to probe which proxy ids exist.
  if (rows.length === 0 || !gate.ctx.propertyIds.includes(rows[0].propertyId))
    return new Response('Proxy not found', { status: 404 });

  // Revocation only has meaning before the occasion: a proxy for a meeting or
  // election that has already happened stays part of the record, homeowner
  // side, and can no longer be self-revoked here — only the board's admin
  // DELETE (unchanged) can remove a past proxy. Mirrors POST's past-occasion
  // rule. CASCADE makes a missing occasion row impossible; skip rather than
  // 500 if it somehow happens.
  const proxy = rows[0];
  const today = associationDateIso();
  if (proxy.meetingId !== null) {
    const [m] = await db
      .select({ date: meetings.date })
      .from(meetings)
      .where(eq(meetings.id, proxy.meetingId))
      .limit(1);
    if (m && m.date < today)
      return new Response('This occasion has already passed', {
        status: 409,
      });
  } else if (proxy.electionId !== null) {
    const [e] = await db
      .select({ date: elections.electionDate })
      .from(elections)
      .where(eq(elections.id, proxy.electionId))
      .limit(1);
    if (e && e.date < today)
      return new Response('This occasion has already passed', {
        status: 409,
      });
  }

  const labels = await proxyUseLabels(db, id);
  if (labels.length > 0)
    return new Response(
      `Proxy is in use (${labels.join(', ')}) — remove those records first`,
      { status: 409 },
    );
  await db.delete(proxies).where(eq(proxies.id, id));
  return new Response(null, { status: 204 });
};
