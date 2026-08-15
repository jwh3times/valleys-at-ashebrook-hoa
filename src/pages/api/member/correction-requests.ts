import type { APIRoute } from 'astro';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireMemberApi } from '../../../server/authz/member-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import { correctionRequests, contactMethods } from '../../../server/db/roster-schema';

// ADR 0022 phase 3b (#218): members submit correction REQUESTS, never facts
// (#205's resolution). This route only ever writes `correction_requests` —
// free text here (`proposedValue`/`note`) NEVER reaches the audit ledger.
// Acceptance is an ordinary board Roster Change made through
// `/api/admin/correction-requests`, which cites this row's id as opaque
// evidence; declining or withdrawing leaves no ledger trace at all.

export const prerender = false;

const VERIFICATION_MESSAGE =
  'Your account is not linked to a resident record — complete verification first.';

const PROPOSED_VALUE_MAX = 200;
const NOTE_MAX = 500;

export const GET: APIRoute = async ({ request, locals }) => {
  const gate = await requireMemberApi(locals, request, env);
  if (!gate.ok) return gate.res;
  if (!gate.ctx.personId)
    return new Response(VERIFICATION_MESSAGE, { status: 403 });
  const db = getDb(env);
  const rows = await db
    .select()
    .from(correctionRequests)
    .where(eq(correctionRequests.personId, gate.ctx.personId))
    .orderBy(desc(correctionRequests.createdAt));
  return Response.json(
    rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      contactMethodId: r.contactMethodId,
      channel: r.channel,
      proposedValue: r.proposedValue,
      note: r.note,
      status: r.status,
      createdAt: r.createdAt.getTime(),
      decidedAt: r.decidedAt ? r.decidedAt.getTime() : null,
    })),
  );
};

export const POST: APIRoute = async ({ request, locals }) => {
  const gate = await requireMemberApi(locals, request, env);
  if (!gate.ok) return gate.res;
  const ctx = gate.ctx;
  if (!ctx.personId)
    return new Response(VERIFICATION_MESSAGE, { status: 403 });
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });

  const kind = stringField(parsed.value, 'kind');
  if (kind !== 'name' && kind !== 'contact_method')
    return new Response("kind must be 'name' or 'contact_method'", {
      status: 400,
    });

  const proposedValue = stringField(parsed.value, 'proposedValue');
  if (proposedValue === '')
    return new Response('proposedValue is required', { status: 400 });
  if (proposedValue.length > PROPOSED_VALUE_MAX)
    return new Response(
      `proposedValue must be ${PROPOSED_VALUE_MAX} characters or fewer`,
      { status: 400 },
    );

  const noteRaw = stringField(parsed.value, 'note');
  if (noteRaw.length > NOTE_MAX)
    return new Response(`note must be ${NOTE_MAX} characters or fewer`, {
      status: 400,
    });
  const note = noteRaw === '' ? null : noteRaw;

  const contactMethodIdRaw = stringField(parsed.value, 'contactMethodId');
  const channelRaw = stringField(parsed.value, 'channel');

  let contactMethodId: string | null = null;
  let channel: 'email' | 'sms' | null = null;

  if (kind === 'name') {
    // Own name or own Contact Methods only — never Ownership, Representation,
    // Lots, or anyone else's data (#205). A `name` request naming a Contact
    // Method is a malformed request, not a different kind of correction.
    if (contactMethodIdRaw !== '' || channelRaw !== '')
      return new Response(
        'kind "name" cannot include contactMethodId or channel',
        { status: 400 },
      );
  } else {
    if (contactMethodIdRaw !== '' && channelRaw !== '')
      return new Response(
        'Provide either contactMethodId or channel, not both',
        { status: 400 },
      );
    if (contactMethodIdRaw === '' && channelRaw === '')
      return new Response(
        'Provide either contactMethodId (correcting an existing method) or channel (proposing a new one)',
        { status: 400 },
      );
    if (contactMethodIdRaw !== '') {
      contactMethodId = contactMethodIdRaw;
    } else if (channelRaw === 'email' || channelRaw === 'sms') {
      channel = channelRaw;
    } else {
      return new Response("channel must be 'email' or 'sms'", {
        status: 400,
      });
    }
  }

  const db = getDb(env);

  if (contactMethodId !== null) {
    const [target] = await db
      .select({
        id: contactMethods.id,
        partyId: contactMethods.partyId,
        voidedAt: contactMethods.voidedAt,
      })
      .from(contactMethods)
      .where(eq(contactMethods.id, contactMethodId))
      .limit(1);
    // Masked: an out-of-scope id (someone else's Contact Method) must be
    // indistinguishable from one that does not exist at all — never a 403,
    // which would confirm the id names a real row.
    if (!target || target.partyId !== ctx.personId || target.voidedAt !== null)
      return new Response('Not found', { status: 404 });
  }

  // One open request per (kind, contactMethodId) — null-equal, so a caller
  // with one open "propose a new method" request cannot queue a second before
  // the board decides the first.
  const dupe = await db
    .select({ id: correctionRequests.id })
    .from(correctionRequests)
    .where(
      and(
        eq(correctionRequests.personId, ctx.personId),
        eq(correctionRequests.status, 'open'),
        eq(correctionRequests.kind, kind),
        contactMethodId === null
          ? isNull(correctionRequests.contactMethodId)
          : eq(correctionRequests.contactMethodId, contactMethodId),
      ),
    )
    .limit(1);
  if (dupe.length > 0)
    return new Response('You already have an open request for this', {
      status: 409,
    });

  const id = crypto.randomUUID();
  await db.insert(correctionRequests).values({
    id,
    accountId: ctx.userId,
    personId: ctx.personId,
    kind,
    contactMethodId,
    channel,
    proposedValue,
    note,
    status: 'open',
    createdAt: new Date(),
  });
  return Response.json({ id }, { status: 201 });
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const gate = await requireMemberApi(locals, request, env);
  if (!gate.ok) return gate.res;
  const ctx = gate.ctx;
  if (!ctx.personId)
    return new Response(VERIFICATION_MESSAGE, { status: 403 });
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const id = stringField(parsed.value, 'id');
  if (!id) return new Response('id is required', { status: 400 });

  const nowMs = Date.now();
  // One statement: existence, ownership, and open-status are all folded into
  // the WHERE, so "not yours", "already decided", and "does not exist" are
  // indistinguishable — the same masked 404 every other homeowner surface
  // uses for an out-of-scope id.
  const result = await env.DATABASE.prepare(
    `UPDATE correction_requests SET status = 'withdrawn', decided_at = ?, decided_by_account_id = ?
     WHERE id = ? AND person_id = ? AND status = 'open'`,
  )
    .bind(nowMs, ctx.userId, id, ctx.personId)
    .run();
  if (result.meta.changes !== 1)
    return new Response('Not found', { status: 404 });
  return new Response(null, { status: 204 });
};
