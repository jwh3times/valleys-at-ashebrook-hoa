import { eq, ne, inArray } from 'drizzle-orm';
import { DOCUMENT_TYPES } from '../../lib/document-types';
import type { CitingRecordKind } from '../../lib/document-citations';
import type { Visibility } from '../../lib/types';
import { generateTwin } from '../ai/twin';
import { getDb } from '../db/client';
import { chunkedIn, D1_MAX_BOUND_PARAMS } from '../db/chunked';
import { documents } from '../db/schema';
import {
  sha256Hex,
  nearScore,
  NEAR_THRESHOLD,
  type DocLike,
} from '../content/dedupe';

// The one place a document is stored (#290 slice 1). The upload route uses it
// today, and the Drive import route will (spec 2026-10-18, decision 5), so an
// imported document goes through exactly the checks, R2 layout, twin and row
// shape an uploaded one does.

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

export interface StoreInput {
  bytes: ArrayBuffer;
  filename: string;
  title: string;
  category: string;
  visibility: Visibility;
  /** The acting Account, recorded as `uploaded_by`. */
  uploadedBy: string | null;
  /** Store despite near-duplicates, and reopen their duplicate group. */
  confirmDuplicate: boolean;
}

interface DocumentRef {
  id: string;
  title: string;
  category: string;
  visibility: Visibility;
}

export type StoreResult =
  | { kind: 'stored'; id: string }
  | { kind: 'too-large' }
  | { kind: 'unsupported-type' }
  | { kind: 'exact-duplicate'; existing: DocumentRef }
  | {
      kind: 'near-duplicate';
      similar: (DocumentRef & { filename: string })[];
    };

/** The existing documents `candidate` is a near-duplicate of (ADR 0007). */
async function nearMatches(env: Env, candidate: DocLike) {
  const existing = await getDb(env)
    .select({
      id: documents.id,
      title: documents.title,
      filename: documents.filename,
      sizeBytes: documents.sizeBytes,
      contentType: documents.contentType,
      category: documents.category,
      visibility: documents.visibility,
    })
    .from(documents)
    .where(ne(documents.id, candidate.id));
  return existing.filter(
    (e) => nearScore(candidate, e as DocLike) >= NEAR_THRESHOLD,
  );
}

export async function storeDocument(
  env: Env,
  input: StoreInput,
): Promise<StoreResult> {
  const { bytes, filename, title, category, visibility } = input;
  const sizeBytes = bytes.byteLength;
  if (sizeBytes > MAX_DOCUMENT_BYTES) return { kind: 'too-large' };
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const contentType = DOCUMENT_TYPES[ext];
  if (!contentType) return { kind: 'unsupported-type' };

  const contentHash = await sha256Hex(bytes);
  const db = getDb(env);

  const [exact] = await db
    .select({
      id: documents.id,
      title: documents.title,
      category: documents.category,
      visibility: documents.visibility,
    })
    .from(documents)
    .where(eq(documents.contentHash, contentHash));
  if (exact) return { kind: 'exact-duplicate', existing: exact };

  const candidate = (id: string): DocLike => ({
    id,
    title,
    filename,
    sizeBytes,
    contentType,
    visibility,
  });

  if (!input.confirmDuplicate) {
    const similar = (await nearMatches(env, candidate('new'))).map((e) => ({
      id: e.id,
      title: e.title,
      filename: e.filename,
      category: e.category,
      visibility: e.visibility,
    }));
    if (similar.length > 0) return { kind: 'near-duplicate', similar };
  }

  const id = crypto.randomUUID();
  const r2Key = `documents/${id}/${filename.replace(/[^\w.-]/g, '_')}`;
  const ragKey = `rag/${id}.md`;
  const written: string[] = [];
  await env.DOCS.put(r2Key, bytes, { httpMetadata: { contentType } });
  written.push(r2Key);

  // Best-effort RAG twin (ADR 0009 §1). Never fatal to the store: generateTwin
  // does not throw, and a twin-write failure only downgrades searchability.
  let ragStatus: 'ok' | 'unsupported' = 'unsupported';
  try {
    const twin = await generateTwin(env, { filename, contentType, bytes });
    ragStatus = twin.status;
    if (twin.markdown) {
      await env.DOCS.put(ragKey, twin.markdown, {
        httpMetadata: { contentType: 'text/markdown' },
      });
      written.push(ragKey);
    }
  } catch {
    ragStatus = 'unsupported';
  }

  const now = new Date();
  try {
    await db.insert(documents).values({
      id,
      title,
      category,
      visibility,
      r2Key,
      filename,
      sizeBytes,
      contentType,
      contentHash,
      ragStatus,
      uploadedBy: input.uploadedBy,
      uploadedAt: now,
      updatedAt: now,
    });
  } catch (err) {
    // R2 was written first, so a refused insert would otherwise leave objects
    // no row points at (#442). Remove them, then let the caller see the error.
    // An object that still won't delete is logged by key for the orphan sweep.
    for (const key of written) await deleteObject(env, key);
    throw err;
  }

  // A confirmed near-duplicate is the only path that stores a file with
  // existing near-matches (a clean store has none; an exact match is blocked
  // above). When it happens, the board's earlier "keep" decisions on those
  // matches are stale — clear them so the group resurfaces for re-review.
  if (input.confirmDuplicate) {
    const matchedIds = (await nearMatches(env, candidate(id))).map((e) => e.id);
    for (let i = 0; i < matchedIds.length; i += D1_MAX_BOUND_PARAMS) {
      await db
        .update(documents)
        .set({ keepVerifiedAt: null, keepVerifiedBy: null })
        .where(
          inArray(documents.id, matchedIds.slice(i, i + D1_MAX_BOUND_PARAMS)),
        );
    }
  }

  return { kind: 'stored', id };
}

// The audit records that may cite a document as evidence, all with
// ON DELETE RESTRICT (audit-schema.ts). A cited document cannot be deleted.
const CITING_TABLES: readonly { table: string; kind: CitingRecordKind }[] = [
  { table: 'roster_changes', kind: 'roster_change' },
  { table: 'board_service_changes', kind: 'board_service_change' },
  { table: 'identity_events', kind: 'identity_event' },
];

export type DeleteResult =
  | { kind: 'deleted' }
  | { kind: 'cited'; citedBy: CitingRecordKind[]; documentIds: string[] };

async function citationsOf(
  env: Env,
  ids: string[],
): Promise<{ citedBy: CitingRecordKind[]; documentIds: string[] }> {
  const citedBy: CitingRecordKind[] = [];
  const documentIds = new Set<string>();
  for (const { table, kind } of CITING_TABLES) {
    const results = await chunkedIn(ids, async (chunk) => {
      const { results: rows } = await env.DATABASE.prepare(
        `SELECT DISTINCT evidence_document_id AS id FROM ${table} WHERE evidence_document_id IN (${chunk.map(() => '?').join(',')})`,
      )
        .bind(...chunk)
        .all<{ id: string }>();
      return rows;
    });
    if (results.length > 0 && !citedBy.includes(kind)) citedBy.push(kind);
    for (const r of results) documentIds.add(r.id);
  }
  return { citedBy, documentIds: [...documentIds] };
}

async function deleteObject(env: Env, key: string): Promise<void> {
  try {
    await env.DOCS.delete(key);
  } catch {
    try {
      await env.DOCS.delete(key);
    } catch (err) {
      // No row points at the object any more, so it is unreachable; it stays
      // until the orphan sweep removes it (#442).
      console.error('[documents] R2 delete failed twice; orphaned', key, err);
    }
  }
}

/**
 * Delete documents rows first, in one D1 batch, then their R2 objects (#442).
 * `alsoInBatch` statements run in the same batch, so a caller's own write
 * (the duplicates panel's keep-verified update) lands only if every delete
 * does. A document cited as evidence is refused without touching anything.
 */
export async function deleteDocuments(
  env: Env,
  ids: string[],
  alsoInBatch: D1PreparedStatement[] = [],
): Promise<DeleteResult> {
  const unique = [...new Set(ids)];
  const rows = await chunkedIn(unique, (chunk) =>
    getDb(env)
      .select({ id: documents.id, r2Key: documents.r2Key })
      .from(documents)
      .where(inArray(documents.id, chunk)),
  );

  const precheck = await citationsOf(env, unique);
  if (precheck.citedBy.length > 0) return { kind: 'cited', ...precheck };

  const statements = [
    ...rows.map((r) =>
      env.DATABASE.prepare('DELETE FROM documents WHERE id = ?').bind(r.id),
    ),
    ...alsoInBatch,
  ];
  if (statements.length > 0) {
    try {
      await env.DATABASE.batch(statements);
    } catch (err) {
      // A citation recorded after the precheck: the RESTRICT FK refuses the
      // whole batch, and nothing has been deleted from R2 yet.
      if (!/FOREIGN KEY constraint failed/.test(String(err))) throw err;
      const raced = await citationsOf(env, unique);
      if (raced.citedBy.length === 0) throw err;
      return { kind: 'cited', ...raced };
    }
  }

  for (const r of rows) {
    await deleteObject(env, r.r2Key);
    await deleteObject(env, `rag/${r.id}.md`); // the AI-index twin (ADR 0009 §1)
  }
  return { kind: 'deleted' };
}
