import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
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
  meetings,
  elections,
} from '../../../server/db/schema';
import { people } from '../../../server/db/roster-schema';
import {
  authorityKey,
  fetchLotAuthorityKeys,
} from '../../../server/roster/authority';
import { associationDateIso } from '../../../lib/format';
import { normalizeProxyInput } from '../../../lib/types';
import { fetchAdminProxies } from '../../../server/content/reads';
import {
  duplicateProxyExists,
  proxyUseLabels,
} from '../../../server/content/proxy-guards';

export const prerender = false;

/** 404 Response if the referenced row is missing, else null. */
async function checkExists(
  db: Db,
  table: typeof properties | typeof elections,
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
 * 404 if holderPersonId is present but names no roster Person. The link is
 * optional — a holder need not hold authority anywhere, or be on the roster at
 * all — so absence is not checked here.
 */
async function checkHolderPersonExists(
  db: Db,
  holderPersonId: string | null | undefined,
): Promise<Response | null> {
  if (holderPersonId == null) return null;
  const rows = await db
    .select({ id: people.partyId })
    .from(people)
    .where(eq(people.partyId, holderPersonId))
    .limit(1);
  if (rows.length === 0)
    return new Response('Holder person not found', { status: 404 });
  return null;
}

/**
 * 400/404 unless grantorPersonId names a roster Person who holds Lot Authority
 * over the given lot. A proxy is granted BY someone entitled to act for the
 * lot FOR that lot — a grantor with no authority there is a data-entry error,
 * caught here rather than surfacing as a coherent-looking but wrong record.
 *
 * Before #248 part 2 this compared `owners.property_id`; it now asks the
 * shared Lot Authority rule (roster/authority.ts), so an Organization's
 * Representative may sign for the entity's lot — which the legacy shape could
 * not express at all.
 */
async function checkGrantorHoldsAuthority(
  db: Db,
  grantorPersonId: string,
  propertyId: string,
): Promise<Response | null> {
  const rows = await db
    .select({ id: people.partyId })
    .from(people)
    .where(eq(people.partyId, grantorPersonId))
    .limit(1);
  if (rows.length === 0)
    return new Response('Person not found', { status: 404 });
  const authority = await fetchLotAuthorityKeys(
    db,
    [propertyId],
    associationDateIso(),
  );
  if (!authority.has(authorityKey(grantorPersonId, propertyId)))
    return new Response(
      'grantorPersonId does not hold authority for this property',
      { status: 400 },
    );
  return null;
}

/**
 * 404 if the meeting is missing, 409 if it is a board-body meeting. Member
 * votes, member attendance, and ballots are the only rows that can cite a
 * proxy, and all three belong to member occasions — a proxy recorded against
 * a board meeting could never be cited by anything, so it is refused rather
 * than stored as an inert row (PR 6 review follow-up).
 */
async function checkMeetingIsMember(
  db: Db,
  meetingId: string | null | undefined,
): Promise<Response | null> {
  if (!meetingId) return null;
  const rows = await db
    .select({ body: meetings.body })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);
  if (rows.length === 0)
    return new Response('Meeting not found', { status: 404 });
  if (rows[0].body !== 'member')
    return new Response(
      'Proxies apply to member meetings — this is a board meeting',
      { status: 409 },
    );
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
  // grantorPersonId, holderPersonId, meetingId, electionId. Checked in this
  // order so each unknown id gets its own message rather than one FK check
  // masking its neighbour.
  const propertyMissing = await checkExists(
    db,
    properties,
    input.propertyId,
    'Property',
  );
  if (propertyMissing) return propertyMissing;
  const grantorProblem = await checkGrantorHoldsAuthority(
    db,
    input.grantorPersonId!,
    input.propertyId!,
  );
  if (grantorProblem) return grantorProblem;
  const holderMissing = await checkHolderPersonExists(db, input.holderPersonId);
  if (holderMissing) return holderMissing;
  const meetingProblem = await checkMeetingIsMember(db, input.meetingId);
  if (meetingProblem) return meetingProblem;
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
  if (
    await duplicateProxyExists(
      db,
      input.propertyId!,
      input.meetingId ?? null,
      input.electionId ?? null,
    )
  )
    return new Response('This lot already has a proxy for this occasion', {
      status: 409,
    });

  const ctx = await resolveAuthContext(locals, request, env);
  const now = new Date();
  const id = crypto.randomUUID();
  await db.insert(proxies).values({
    id,
    propertyId: input.propertyId!,
    grantorPersonId: input.grantorPersonId!,
    holderName: input.holderName!,
    holderPersonId: input.holderPersonId ?? null,
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

  if (input.grantorPersonId !== undefined) {
    const grantorProblem = await checkGrantorHoldsAuthority(
      db,
      input.grantorPersonId,
      current.propertyId,
    );
    if (grantorProblem) return grantorProblem;
  }
  if (input.holderPersonId !== undefined) {
    const holderMissing = await checkHolderPersonExists(
      db,
      input.holderPersonId,
    );
    if (holderMissing) return holderMissing;
  }
  // Re-check grantor !== holder against the EFFECTIVE values — the
  // normalizer can only compare keys present in the same payload, so a patch
  // that carries only holderPersonId (equal to the stored grantor) or only
  // grantorPersonId (equal to the stored holder) would otherwise slip through.
  const effectiveGrantor = input.grantorPersonId ?? current.grantorPersonId;
  const effectiveHolder =
    input.holderPersonId !== undefined
      ? input.holderPersonId
      : current.holderPersonId;
  if (effectiveHolder != null && effectiveGrantor === effectiveHolder)
    return new Response(
      'grantorPersonId and holderPersonId cannot be the same person',
      { status: 400 },
    );

  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.holderName !== undefined) set.holderName = input.holderName;
  if (input.holderPersonId !== undefined)
    set.holderPersonId = input.holderPersonId;
  if (input.grantorPersonId !== undefined)
    set.grantorPersonId = input.grantorPersonId;
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
  const labels = await proxyUseLabels(db, id);
  if (labels.length > 0)
    return new Response(
      `Proxy is in use (${labels.join(', ')}) — remove those records first`,
      { status: 409 },
    );
  await db.delete(proxies).where(eq(proxies.id, id));
  return new Response(null, { status: 204 });
};
