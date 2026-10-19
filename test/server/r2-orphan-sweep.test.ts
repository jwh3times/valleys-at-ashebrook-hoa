import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { sweepR2Orphans } from '../../src/server/documents/sweep';

// #442: the R2 orphan sweep. It removes document files and search twins that
// no documents row points at, older than a 7-day grace, and touches no other
// key. Deletion is off until R2_SWEEP_DELETE is "true"; until then it reports.

const DAY = 24 * 60 * 60 * 1000;
/** Eight days on: every object written by the test is past the grace. */
const later = () => Date.now() + 8 * DAY;
const mutableEnv = env as unknown as Record<string, unknown>;

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

async function emptyBucket() {
  const listed = await env.DOCS.list();
  if (listed.objects.length > 0)
    await env.DOCS.delete(listed.objects.map((o) => o.key));
}

beforeEach(emptyBucket);
afterEach(async () => {
  delete mutableEnv.R2_SWEEP_DELETE;
  await env.DATABASE.exec('DELETE FROM documents');
  await env.DATABASE.exec(
    "DELETE FROM cutover_settings WHERE key = 'write_freeze'",
  );
  await emptyBucket();
});

async function put(...objectKeys: string[]) {
  for (const key of objectKeys) await env.DOCS.put(key, 'bytes');
}

async function row(id: string, r2Key: string) {
  await env.DATABASE.prepare(
    `INSERT INTO documents (id, title, category, visibility, r2_key, filename, size_bytes, content_type, uploaded_at, updated_at)
     VALUES (?, 'A document', 'Governing Documents', 'board', ?, 'a.pdf', 5, 'application/pdf', 1, 1)`,
  )
    .bind(id, r2Key)
    .run();
}

async function keys(): Promise<string[]> {
  return (await env.DOCS.list()).objects.map((o) => o.key).sort();
}

async function freeze() {
  await env.DATABASE.exec(
    "INSERT INTO cutover_settings (key, value, updated_at) VALUES ('write_freeze', 'on', 1)",
  );
}

/** `env` whose bucket listing runs `during` once, after the first page. */
function listingWith(during: () => Promise<void>, limit?: number): Env {
  let ran = false;
  return {
    ...env,
    DOCS: {
      list: async (options?: R2ListOptions) => {
        const page = await env.DOCS.list({ ...options, limit });
        if (!ran) {
          ran = true;
          await during();
        }
        return page;
      },
      delete: (key: string | string[]) => env.DOCS.delete(key),
    },
  } as unknown as Env;
}

const deleting = () => {
  mutableEnv.R2_SWEEP_DELETE = 'true';
};

describe('the R2 orphan sweep', () => {
  it('reports a document file and a twin that no row points at, and deletes nothing', async () => {
    await put('documents/gone/a.pdf', 'rag/gone.md');
    const result = await sweepR2Orphans(env, { now: later() });
    expect(result).toMatchObject({
      mode: 'report-only',
      documents: ['gone'],
      twins: ['gone'],
      deleted: 0,
    });
    expect(await keys()).toEqual(['documents/gone/a.pdf', 'rag/gone.md']);
  });

  it('leaves an object alone until it is more than 7 days old', async () => {
    await put('documents/new/a.pdf', 'rag/new.md');
    expect(
      await sweepR2Orphans(env, { now: Date.now() + 6 * DAY }),
    ).toMatchObject({ documents: [], twins: [] });
  });

  it('matches a document file to its row by the exact key, never the id alone', async () => {
    await row('kept', 'documents/kept/Bylaws.pdf');
    await put(
      'documents/kept/Bylaws.pdf',
      'rag/kept.md',
      // The same id with another name: an earlier write the row no longer
      // points at. The import scripts and the upload route sanitize names
      // differently, so the key is never rebuilt from the filename.
      'documents/kept/Bylaws (1).pdf',
    );
    expect(await sweepR2Orphans(env, { now: later() })).toMatchObject({
      documents: ['kept'],
      twins: [],
    });
  });

  it('never reports a key outside the two document shapes', async () => {
    await put(
      'lots/lot-1/survey.pdf',
      'documents/loose.pdf',
      'rag/nested/twin.md',
      'rag/notes.txt',
      'reports/r-1.json',
    );
    expect(await sweepR2Orphans(env, { now: later() })).toMatchObject({
      documents: [],
      twins: [],
    });
  });

  it.each(['false', 'TRUE', '1'])(
    'deletes nothing while R2_SWEEP_DELETE is %s',
    async (value) => {
      mutableEnv.R2_SWEEP_DELETE = value;
      await put('documents/gone/a.pdf');
      expect(await sweepR2Orphans(env, { now: later() })).toMatchObject({
        mode: 'report-only',
        deleted: 0,
      });
      expect(await keys()).toEqual(['documents/gone/a.pdf']);
    },
  );

  it('deletes orphans, and only orphans, once deletion is on', async () => {
    deleting();
    await row('kept', 'documents/kept/a.pdf');
    await put(
      'documents/kept/a.pdf',
      'rag/kept.md',
      'documents/gone/a.pdf',
      'rag/gone.md',
      'reports/r-1.json',
    );
    expect(await sweepR2Orphans(env, { now: later() })).toMatchObject({
      mode: 'deleted',
      deleted: 2,
    });
    expect(await keys()).toEqual([
      'documents/kept/a.pdf',
      'rag/kept.md',
      'reports/r-1.json',
    ]);
  });

  it('reports but deletes nothing while the write freeze is on', async () => {
    deleting();
    await freeze();
    await put('documents/gone/a.pdf');
    expect(await sweepR2Orphans(env, { now: later() })).toMatchObject({
      mode: 'frozen',
      documents: ['gone'],
      deleted: 0,
    });
    expect(await keys()).toEqual(['documents/gone/a.pdf']);
  });

  it('respects a row that appears while the bucket is listed', async () => {
    deleting();
    await put('documents/late/a.pdf', 'documents/gone/a.pdf');
    const racing = listingWith(() => row('late', 'documents/late/a.pdf'));
    expect(await sweepR2Orphans(racing, { now: later() })).toMatchObject({
      documents: ['gone'],
      deleted: 1,
    });
    expect(await keys()).toEqual(['documents/late/a.pdf']);
  });

  it('respects a freeze that starts while the bucket is listed', async () => {
    deleting();
    await put('documents/gone/a.pdf');
    const racing = listingWith(freeze);
    expect(await sweepR2Orphans(racing, { now: later() })).toMatchObject({
      mode: 'frozen',
      deleted: 0,
    });
    expect(await keys()).toEqual(['documents/gone/a.pdf']);
  });

  it('deletes at most the per-run cap', async () => {
    deleting();
    await put('rag/a.md', 'rag/b.md', 'rag/c.md');
    expect(
      await sweepR2Orphans(env, { now: later(), maxDeletes: 2 }),
    ).toMatchObject({ twins: ['a', 'b', 'c'], deleted: 2 });
    expect(await keys()).toEqual(['rag/c.md']);
  });

  it('deletes nothing and fails when the orphan count passes the sanity threshold', async () => {
    deleting();
    await put('rag/a.md', 'rag/b.md', 'documents/c/c.pdf');
    await expect(
      sweepR2Orphans(env, { now: later(), threshold: 2 }),
    ).rejects.toThrow(/3 orphans exceed the sanity threshold of 2/);
    expect(await keys()).toHaveLength(3);
  });

  it('reports past the threshold without failing while deletion is off', async () => {
    await put('rag/a.md', 'rag/b.md', 'documents/c/c.pdf');
    expect(
      await sweepR2Orphans(env, { now: later(), threshold: 2 }),
    ).toMatchObject({ mode: 'report-only', twins: ['a', 'b'] });
  });

  it('fails, deleting nothing, when the bucket lists more pages than a sane library has', async () => {
    deleting();
    await put('rag/a.md', 'rag/b.md', 'rag/c.md');
    const paged = listingWith(async () => {}, 1);
    await expect(
      sweepR2Orphans(paged, { now: later(), maxPages: 2 }),
    ).rejects.toThrow(/more than 2 pages/);
    expect(await keys()).toHaveLength(3);
  });
});
