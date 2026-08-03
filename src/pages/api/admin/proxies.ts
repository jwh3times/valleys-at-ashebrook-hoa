import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import type { Db } from '../../../server/db/client';
import {
  proxies,
  properties,
  owners,
  meetings,
  elections,
  memberAttendance,
  memberVotes,
  ballots,
} from '../../../server/db/schema';
import { normalizeProxyInput } from '../../../lib/types';
import { fetchAdminProxies } from '../../../server/content/reads';

export const prerender = false;

/** 404 Response if the referenced row is missing, else null. */
async function checkExists(
  db: Db,
  table: typeof properties | typeof meetings | typeof elections,
  id: string | null | undefined,
  label: string,
): Promise<Response | null> {
  if (!id) return null;
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  if (rows.length === 0)
    return new Response(`${label} not found`, { status: 404 });
  return null;
}

/**
 * 404 if holderOwnerId is present but does not exist. holderOwnerId is
 * optional — a holder need not be an owner at all — so absence is not
 * checked here.
 */
async function checkHolderOwnerExists(
  db: Db,
  holderOwnerId: string | null | undefined,
): Promise<Response | null> {
  if (holderOwnerId == null) return null;
  const rows = await db
    .select({ id: owners.id })
    .from(owners)
    .where(eq(owners.id, holderOwnerId))
    .limit(1);
  if (rows.length === 0)
    return new Response('Holder owner not found', { status: 404 });
  return null;
}

/**
 * 400/404 unless grantorOwnerId exists and belongs to the given property.
 * Owners belong to exactly one lot (owners.property_id), and a proxy is
 * granted BY an owner FOR their lot — a grantor from another lot is a
 * data-entry error, caught here rather than surfacing as a coherent-looking
 * but wrong record.
 */
async function checkGrantorBelongs(
  db: Db,
  grantorOwnerId: string,
  propertyId: string,
): Promise<Response | null> {
  const rows = await db
    .select({ id: owners.id, propertyId: owners.propertyId })
    .from(owners)
    .where(eq(owners.id, grantorOwnerId))
    .limit(1);
  if (rows.length === 0)
    return new Response('Owner not found', { status: 404 });
  if (rows[0].propertyId !== propertyId)
    return new Response('grantorOwnerId does not belong to this property', {
      status: 400,
    });
  return null;
}

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  return Response.json(await fetchAdminProxies(env));
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const result = normalizeProxyInput(parsed.value, 'create');
  if (!result.ok) return new Response(result.error, { status: 400 });
  const input = result.value;
  const db = getDb(env);

  // Every FK this route can write gets a readable failure — propertyId,
  // grantorOwnerId, holderOwnerId, meetingId, electionId. Checked in this
  // order so each unknown id gets its own message rather than one FK check
  // masking its neighbour.
  const propertyMissing = await checkExists(
    db,
    properties,
    input.propertyId,
    'Property',
  );
  if (propertyMissing) return propertyMissing;
  const grantorProblem = await checkGrantorBelongs(
    db,
    input.grantorOwnerId!,
    input.propertyId!,
  );
  if (grantorProblem) return grantorProblem;
  const holderMissing = await checkHolderOwnerExists(db, input.holderOwnerId);
  if (holderMissing) return holderMissing;
  const meetingMissing = await checkExists(
    db,
    meetings,
    input.meetingId,
    'Meeting',
  );
  if (meetingMissing) return meetingMissing;
  const electionMissing = await checkExists(
    db,
    elections,
    input.electionId,
    'Election',
  );
  if (electionMissing) return electionMissing;

  // Pre-checked so the unique index (proxies_property_meeting_unq /
  // proxies_property_election_unq) surfaces as a readable 409 instead of a
  // raw D1 error.
  const duplicate = await db
    .select({ id: proxies.id })
    .from(proxies)
    .where(
      and(
        eq(proxies.propertyId, input.propertyId!),
        input.meetingId != null
          ? eq(proxies.meetingId, input.meetingId)
          : eq(proxies.electionId, input.electionId!),
      ),
    )
    .limit(1);
  if (duplicate.length > 0)
    return new Response('This lot already has a proxy for this occasion', {
      status: 409,
    });

  const ctx = await resolveAuthContext(locals, request, env);
  const now = new Date();
  const id = crypto.randomUUID();
  await db.insert(proxies).values({
    id,
    propertyId: input.propertyId!,
    grantorOwnerId: input.grantorOwnerId!,
    holderName: input.holderName!,
    holderOwnerId: input.holderOwnerId ?? null,
    meetingId: input.meetingId ?? null,
    electionId: input.electionId ?? null,
    createdBy: ctx?.userId ?? 'unknown',
    createdAt: now,
    updatedAt: now,
  });
  return Response.json({ id }, { status: 201 });
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const id = stringField(parsed.value, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  // The normalizer rejects scope and propertyId on key presence — moving a
  // proxy to another occasion or lot is a different proxy, not an edit.
  const result = normalizeProxyInput(parsed.value, 'patch');
  if (!result.ok) return new Response(result.error, { status: 400 });
  const input = result.value;
  if (Object.keys(input).length === 0)
    return new Response('No fields to update', { status: 400 });
  const db = getDb(env);
  const existing = await db
    .select()
    .from(proxies)
    .where(eq(proxies.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Proxy not found', { status: 404 });
  const current = existing[0];

  if (input.grantorOwnerId !== undefined) {
    const grantorProblem = await checkGrantorBelongs(
      db,
      input.grantorOwnerId,
      current.propertyId,
    );
    if (grantorProblem) return grantorProblem;
  }
  if (input.holderOwnerId !== undefined) {
    const holderMissing = await checkHolderOwnerExists(db, input.holderOwnerId);
    if (holderMissing) return holderMissing;
  }
  // Re-check grantor !== holder against the EFFECTIVE values — the
  // normalizer can only compare keys present in the same payload, so a patch
  // that carries only holderOwnerId (equal to the stored grantor) or only
  // grantorOwnerId (equal to the stored holder) would otherwise slip through.
  const effectiveGrantor = input.grantorOwnerId ?? current.grantorOwnerId;
  const effectiveHolder =
    input.holderOwnerId !== undefined
      ? input.holderOwnerId
      : current.holderOwnerId;
  if (effectiveHolder != null && effectiveGrantor === effectiveHolder)
    return new Response(
      'grantorOwnerId and holderOwnerId cannot be the same owner',
      { status: 400 },
    );

  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.holderName !== undefined) set.holderName = input.holderName;
  if (input.holderOwnerId !== undefined)
    set.holderOwnerId = input.holderOwnerId;
  if (input.grantorOwnerId !== undefined)
    set.grantorOwnerId = input.grantorOwnerId;
  await db.update(proxies).set(set).where(eq(proxies.id, id));
  return new Response(null, { status: 204 });
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const id = stringField(parsed.value, 'id');
  if (!id) return new Response('id is required', { status: 400 });
  const db = getDb(env);
  const existing = await db
    .select({ id: proxies.id })
    .from(proxies)
    .where(eq(proxies.id, id))
    .limit(1);
  if (existing.length === 0)
    return new Response('Proxy not found', { status: 404 });

  // A used proxy is part of the record. proxy_id carries no ON DELETE action
  // (see schema.ts), so without this pre-check the delete would surface as a
  // raw D1 FK error; with it, the response is deterministic and names where
  // the proxy is used. An unused proxy is simply removed — that is the whole
  // revocation model (no revoked_at state; see ADR 0018).
  const [attRows, voteRows, ballotRows] = await Promise.all([
    db
      .select({ id: memberAttendance.id })
      .from(memberAttendance)
      .where(eq(memberAttendance.proxyId, id))
      .limit(1),
    db
      .select({ id: memberVotes.id })
      .from(memberVotes)
      .where(eq(memberVotes.proxyId, id))
      .limit(1),
    db
      .select({ id: ballots.id })
      .from(ballots)
      .where(eq(ballots.proxyId, id))
      .limit(1),
  ]);
  const labels = [
    ...(attRows.length > 0 ? ['attendance'] : []),
    ...(voteRows.length > 0 ? ['votes'] : []),
    ...(ballotRows.length > 0 ? ['ballots'] : []),
  ];
  if (labels.length > 0)
    return new Response(
      `Proxy is in use (${labels.join(', ')}) — remove those records first`,
      { status: 409 },
    );
  await db.delete(proxies).where(eq(proxies.id, id));
  return new Response(null, { status: 204 });
};
