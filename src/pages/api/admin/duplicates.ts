import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { requireBoard } from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import { getDb } from '../../../server/db/client';
import { documents } from '../../../server/db/schema';
import {
  sha256Hex,
  groupExact,
  groupNear,
  autoResolvableExact,
  type DocLike,
  type DupeGroup,
} from '../../../server/content/dedupe';

export const prerender = false;

const BACKFILL_ATTEMPT_CAP = 5;
const BACKFILL_BYTE_CAP = 8 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function validContentHash(value: string | null): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

function serialize(group: DupeGroup, matchKind: 'exact' | 'near') {
  const visibilityTiers = new Set(group.members.map((m) => m.visibility));
  const auto = matchKind === 'exact' ? autoResolvableExact(group) : null;
  const sameTier = visibilityTiers.size === 1;
  const contentHash =
    matchKind === 'exact' ? (group.members[0].contentHash ?? null) : null;
  return {
    matchKind,
    suggestedKeepId: group.suggestedKeepId,
    reason: group.reason,
    contentHash,
    sameTier,
    autoResolvable: auto !== null,
    deleteIds: auto?.deleteIds ?? [],
    recommendation:
      matchKind === 'exact'
        ? auto
          ? 'Same-tier exact duplicate: keep the suggested file and delete the byte-identical copies.'
          : 'Exact duplicate across visibility tiers: bytes match, but choose the surviving visibility intentionally.'
        : 'Near duplicate: metadata is similar, but bytes differ or are not yet proven identical. Review manually before deleting.',
    members: group.members.map((m) => ({
      id: m.id,
      title: m.title,
      filename: m.filename,
      category: m.category,
      visibility: m.visibility,
      sizeBytes: m.sizeBytes,
      contentHash: m.contentHash ?? null,
      uploadedAt:
        m.uploadedAt instanceof Date
          ? m.uploadedAt.toISOString()
          : new Date((m.uploadedAt ?? 0) as number).toISOString(),
    })),
  };
}

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const db = getDb(env);

  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      filename: documents.filename,
      category: documents.category,
      visibility: documents.visibility,
      sizeBytes: documents.sizeBytes,
      contentType: documents.contentType,
      contentHash: documents.contentHash,
      r2Key: documents.r2Key,
      uploadedAt: documents.uploadedAt,
    })
    .from(documents);

  let attempted = 0;
  let attemptedBytes = 0;
  let remaining = 0;
  for (const row of rows) {
    if (validContentHash(row.contentHash)) continue;
    row.contentHash = null;
    const rowBytes = Math.max(0, row.sizeBytes);
    if (
      attempted >= BACKFILL_ATTEMPT_CAP ||
      (attempted > 0 && attemptedBytes + rowBytes > BACKFILL_BYTE_CAP)
    ) {
      remaining++;
      continue;
    }
    attempted++;
    attemptedBytes += rowBytes;
    try {
      const obj = await env.DOCS.get(row.r2Key);
      if (!obj) {
        remaining++;
        continue;
      }
      const hash = await sha256Hex(await obj.arrayBuffer());
      await db
        .update(documents)
        .set({ contentHash: hash })
        .where(eq(documents.id, row.id));
      row.contentHash = hash;
    } catch (error) {
      remaining++;
      console.warn('Duplicate hash backfill failed', {
        id: row.id,
        r2Key: row.r2Key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const docs: DocLike[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    filename: r.filename,
    sizeBytes: r.sizeBytes,
    contentType: r.contentType,
    visibility: r.visibility,
    category: r.category,
    uploadedAt: r.uploadedAt ?? undefined,
    contentHash: r.contentHash,
  }));

  return Response.json({
    exact: groupExact(docs).map((g) => serialize(g, 'exact')),
    near: groupNear(docs).map((g) => serialize(g, 'near')),
    remaining,
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const body =
    parsed.value && typeof parsed.value === 'object'
      ? (parsed.value as Record<string, unknown>)
      : {};
  if (body.action !== 'resolve')
    return new Response('Bad action', { status: 400 });
  const keepId = stringField(body, 'keepId');
  if (!keepId) return new Response('keepId is required', { status: 400 });
  const deleteIds = Array.isArray(body.deleteIds)
    ? body.deleteIds.filter((x): x is string => typeof x === 'string')
    : [];
  if (deleteIds.length === 0)
    return new Response('deleteIds is required', { status: 400 });
  if (deleteIds.includes(keepId))
    return new Response('keepId cannot be in deleteIds', { status: 400 });

  const db = getDb(env);
  for (const id of deleteIds) {
    const [doc] = await db.select().from(documents).where(eq(documents.id, id));
    if (!doc) continue;
    await env.DOCS.delete(doc.r2Key);
    await db.delete(documents).where(eq(documents.id, id));
  }
  return new Response(null, { status: 204 });
};
