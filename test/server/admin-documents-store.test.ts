import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { GET, POST, DELETE } from '../../src/pages/api/admin/documents';
import { POST as resolveDuplicates } from '../../src/pages/api/admin/duplicates';
import { getDb } from '../../src/server/db/client';
import { documents } from '../../src/server/db/schema';
import { users } from '../../src/server/db/auth-schema';
import { fetchDocumentsFor } from '../../src/server/content/reads';
import { callerContext } from './caller-context';
import { pauseNextBatch } from './fixtures';

// #290 slice 1 and #442: the shared document store behind upload, delete and
// the duplicates panel — who uploaded a document, and that a store or delete
// that fails part-way never leaves R2 and D1 disagreeing.

const UPLOADER = 'uploader-1';
const board = (userId = UPLOADER) => ({
  authContext: callerContext(userId, 'board', []),
});

type AdminDoc = {
  id: string;
  title: string;
  uploadedBy: string | null;
  uploadedByName: string | null;
};

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  const now = new Date();
  await getDb(env).insert(users).values({
    id: UPLOADER,
    name: 'Uploader One',
    email: 'uploader-1@example.test',
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  });
});

async function upload(
  title: string,
  name: string,
  { userId = UPLOADER, visibility = 'board' } = {},
) {
  const form = new FormData();
  // Distinct bytes per upload so the exact-duplicate check never fires.
  form.set('file', new File([`content for ${title}`], name));
  form.set('title', title);
  form.set('category', 'Governing Documents');
  form.set('visibility', visibility);
  form.set('confirmDuplicate', 'true');
  return POST({
    request: new Request('http://localhost/api/admin/documents', {
      method: 'POST',
      body: form,
    }),
    locals: board(userId),
  } as never);
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function r2Keys(): Promise<string[]> {
  const listed = await env.DOCS.list();
  return listed.objects.map((o) => o.key).sort();
}

/** Make every D1 statement that writes `documents` fail when it executes,
 * whether run alone or inside a batch: the real statement is re-pointed at a
 * table that does not exist. */
function failDocumentWrites(verb: 'insert' | 'delete') {
  const originalPrepare = env.DATABASE.prepare.bind(env.DATABASE);
  const pattern = new RegExp(
    `^\\s*${verb}\\s+(into\\s+|from\\s+)?"documents"`,
    'i',
  );
  return vi
    .spyOn(env.DATABASE, 'prepare')
    .mockImplementation((query) =>
      originalPrepare(
        pattern.test(query)
          ? query.replace('"documents"', '"documents_unavailable"')
          : query,
      ),
    );
}

async function idOf(title: string): Promise<string> {
  const row = (await adminList()).find((d) => d.title === title);
  if (!row) throw new Error(`no document titled ${title}`);
  return row.id;
}

function del(id: string) {
  return DELETE({
    request: new Request('http://localhost/api/admin/documents', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    }),
    locals: board(),
  } as never);
}

let citationSeq = 0;
/** Record a roster change that cites `documentId` as its evidence. */
async function citeAsRosterEvidence(documentId: string) {
  const eventId = `evt-cite-${++citationSeq}`;
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO audit_events (id, family, event_kind, correlation_id, correlation_sequence, actor_kind, actor_account_id, operation_key, recorded_at)
       VALUES (?, 'roster_change', 'test_citation', ?, 0, 'account', ?, ?, ?)`,
    ).bind(eventId, eventId, UPLOADER, `op-${eventId}`, Date.now()),
    env.DATABASE.prepare(
      `INSERT INTO roster_changes (event_id, effective_day_basis, reason_code, evidence_kind, evidence_document_id)
       VALUES (?, 'not_applicable', 'test_citation', 'document', ?)`,
    ).bind(eventId, documentId),
  ]);
}

async function adminList(): Promise<AdminDoc[]> {
  const res = await GET({
    request: new Request('http://localhost/api/admin/documents'),
    locals: board(),
  } as never);
  expect(res.status).toBe(200);
  return res.json();
}

describe('uploader attribution', () => {
  it('records who uploaded a document and shows their name to the board', async () => {
    expect((await upload('Pool rules 2027', 'pool-rules.txt')).status).toBe(
      201,
    );
    const row = (await adminList()).find((d) => d.title === 'Pool rules 2027');
    expect(row?.uploadedBy).toBe(UPLOADER);
    expect(row?.uploadedByName).toBe('Uploader One');
  });

  it('never exposes the uploader through the tiered document read', async () => {
    await upload('Architectural guidelines', 'guidelines.txt', {
      visibility: 'public',
    });
    for (const role of ['visitor', 'homeowner', 'board'] as const) {
      const rows = await fetchDocumentsFor(env, role);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(Object.keys(r)).not.toContain('uploadedBy');
    }
  });
});

describe('a store that fails part-way (#442)', () => {
  it('leaves no R2 objects behind when the documents insert fails', async () => {
    const before = await r2Keys();
    failDocumentWrites('insert');
    const outcome = await upload('Budget draft', 'budget.txt').then(
      (res) => res.status,
      () => 'threw',
    );
    vi.restoreAllMocks();
    expect(outcome === 'threw' || outcome === 500).toBe(true);
    expect(await r2Keys()).toEqual(before);
    const rows = await getDb(env).select().from(documents);
    expect(rows.find((r) => r.title === 'Budget draft')).toBeUndefined();
  });
});

describe('deleting a document (#442)', () => {
  it('refuses to delete a document a recorded change cites, and keeps its files', async () => {
    await upload('Deed of sale', 'deed.txt');
    const id = await idOf('Deed of sale');
    await citeAsRosterEvidence(id);
    const before = await r2Keys();

    const res = await del(id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'document-cited',
      citedBy: ['roster_change'],
    });
    expect(await r2Keys()).toEqual(before);
    expect(before).toContain(`rag/${id}.md`);
    expect((await adminList()).map((d) => d.id)).toContain(id);
  });

  it('refuses the delete when a citation is recorded after its check', async () => {
    await upload('Easement agreement', 'easement.txt');
    const id = await idOf('Easement agreement');
    const before = await r2Keys();

    const paused = pauseNextBatch();
    const pending = del(id);
    await paused.reached;
    paused.restore();
    await citeAsRosterEvidence(id);
    paused.release();

    const res = await pending;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'document-cited',
      citedBy: ['roster_change'],
    });
    expect(await r2Keys()).toEqual(before);
  });
});

describe('R2 failures after a delete (#442)', () => {
  /** Fail the next `times` R2 deletes, then behave normally. */
  function failR2Deletes(times: number) {
    const original = env.DOCS.delete.bind(env.DOCS);
    let remaining = times;
    return vi.spyOn(env.DOCS, 'delete').mockImplementation(async (keys) => {
      if (remaining > 0) {
        remaining--;
        throw new Error('R2 unavailable');
      }
      return original(keys);
    });
  }

  it('retries a failed R2 delete, so a single failure leaves nothing behind', async () => {
    await upload('Insurance certificate', 'insurance.txt');
    const id = await idOf('Insurance certificate');
    failR2Deletes(1);

    expect((await del(id)).status).toBe(204);
    vi.restoreAllMocks();
    expect((await r2Keys()).filter((k) => k.includes(id))).toEqual([]);
    expect((await adminList()).map((d) => d.id)).not.toContain(id);
  });

  it('still removes the document when R2 keeps failing, and logs the orphaned key', async () => {
    await upload('Landscaping bid', 'landscaping.txt');
    const id = await idOf('Landscaping bid');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    failR2Deletes(Number.POSITIVE_INFINITY);

    expect((await del(id)).status).toBe(204);
    vi.restoreAllMocks();
    expect((await adminList()).map((d) => d.id)).not.toContain(id);
    const orphans = (await r2Keys()).filter((k) => k.includes(id));
    expect(orphans).toHaveLength(2);
    for (const key of orphans)
      expect(logged.mock.calls.some((call) => call.includes(key))).toBe(true);
  });
});

describe('resolving a duplicate group (#442)', () => {
  function resolve(keepIds: string[], deleteIds: string[]) {
    return resolveDuplicates({
      request: new Request('http://localhost/api/admin/duplicates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'resolve', keepIds, deleteIds }),
      }),
      locals: board(),
    } as never);
  }

  async function keptAt(id: string) {
    const [row] = await getDb(env)
      .select({ keptAt: documents.keepVerifiedAt })
      .from(documents)
      .where(eq(documents.id, id));
    return row?.keptAt ?? null;
  }

  it('deletes nothing and keeps nothing when one of the deletions is cited', async () => {
    await upload('Minutes March', 'minutes-march.txt');
    await upload('Minutes March copy', 'minutes-march-copy.txt');
    await upload('Minutes March final', 'minutes-march-final.txt');
    const keep = await idOf('Minutes March');
    const plain = await idOf('Minutes March copy');
    const cited = await idOf('Minutes March final');
    await citeAsRosterEvidence(cited);
    const before = await r2Keys();

    const res = await resolve([keep], [plain, cited]);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'document-cited',
      citedBy: ['roster_change'],
      documentIds: [cited],
    });
    const ids = (await adminList()).map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining([keep, plain, cited]));
    expect(await r2Keys()).toEqual(before);
    expect(await keptAt(keep)).toBeNull();
  });
});
