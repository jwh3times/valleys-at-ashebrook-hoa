import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { GET as listDocuments } from '../../src/pages/api/content/documents';
import { GET as download } from '../../src/pages/api/files/[id]';
import {
  GET as adminList,
  PATCH as adminEdit,
} from '../../src/pages/api/admin/documents';
import { getDb } from '../../src/server/db/client';
import type { AuthContext } from '../../src/server/authz/guards';
import { callerContext } from './caller-context';

// #294 slice 1 (spec 2026-10-20, decision 6): the board marks homeowner-tier
// documents Tenant-Visible, and a caller holding `tenant` sees them beside the
// public ones, in the list and as downloads, only while both gates are on.

/** A tenant who owns nothing: `contentTier` stays `visitor` (ADR 0028). */
const tenant: AuthContext = {
  ...callerContext('tenant-1', 'visitor', []),
  capabilities: new Set(['tenant']),
};
const homeowner = callerContext('owner-1', 'homeowner', ['lot-1']);
const board = callerContext('board-1', 'board', []);

const DOCS = [
  { id: 'doc-pub', visibility: 'public', tenantVisible: 0 },
  { id: 'doc-marked', visibility: 'homeowner', tenantVisible: 1 },
  { id: 'doc-hoa', visibility: 'homeowner', tenantVisible: 0 },
  { id: 'doc-brd', visibility: 'board', tenantVisible: 0 },
] as const;

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  const db = getDb(env);
  await db.run(sql.raw('DELETE FROM settings'));
  await db.run(sql.raw('DELETE FROM documents'));
  const now = Date.now();
  for (const d of DOCS) {
    const key = `documents/${d.id}/${d.id}.txt`;
    await env.DOCS.put(key, `${d.id}-bytes`);
    await db.run(sql`
      INSERT INTO documents (id, title, category, visibility, tenant_visible,
        r2_key, filename, size_bytes, content_type, uploaded_at, updated_at)
      VALUES (${d.id}, ${d.id}, 'Other', ${d.visibility}, ${d.tenantVisible},
        ${key}, ${`${d.id}.txt`}, 10, 'text/plain', ${now}, ${now})`);
  }
});

async function setGates(officialMode: boolean, tenantAccessEnabled: boolean) {
  await getDb(env).run(sql`
    INSERT INTO settings (key, value, updated_at)
    VALUES ('site', ${JSON.stringify({ officialMode, tenantAccessEnabled })}, ${Date.now()})
    ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
}

async function listed(caller: AuthContext | null): Promise<string[]> {
  const res = await listDocuments({
    request: new Request('http://localhost/api/content/documents'),
    locals: { authContext: caller },
  } as never);
  const docs = (await res.json()) as { id: string }[];
  return docs.map((d) => d.id).sort();
}

async function downloadStatus(
  caller: AuthContext | null,
  id: string,
): Promise<number> {
  const res = await download({
    params: { id },
    request: new Request(`http://localhost/api/files/${id}`),
    locals: { authContext: caller },
  } as never);
  return res.status;
}

describe('a tenant reading documents', () => {
  it('sees public and Tenant-Visible documents, in the list and as downloads', async () => {
    await setGates(true, true);
    expect(await listed(tenant)).toEqual(['doc-marked', 'doc-pub']);
    expect(await downloadStatus(tenant, 'doc-marked')).toBe(200);
    expect(await downloadStatus(tenant, 'doc-pub')).toBe(200);
  });

  it('never sees an unmarked homeowner document or a board document', async () => {
    await setGates(true, true);
    expect(await downloadStatus(tenant, 'doc-hoa')).toBe(404);
    expect(await downloadStatus(tenant, 'doc-brd')).toBe(404);
  });

  it('sees only public documents while official mode is off', async () => {
    await setGates(false, true);
    expect(await listed(tenant)).toEqual(['doc-pub']);
    expect(await downloadStatus(tenant, 'doc-marked')).toBe(404);
  });

  it('sees only public documents while tenant access is off', async () => {
    await setGates(true, false);
    expect(await listed(tenant)).toEqual(['doc-pub']);
    expect(await downloadStatus(tenant, 'doc-marked')).toBe(404);
  });

  it('sees only public documents when no settings row exists', async () => {
    expect(await listed(tenant)).toEqual(['doc-pub']);
    expect(await downloadStatus(tenant, 'doc-marked')).toBe(404);
  });
});

describe('the mark reaches no one but tenants', () => {
  it('shows a visitor only the public document, with the gates on', async () => {
    await setGates(true, true);
    expect(await listed(null)).toEqual(['doc-pub']);
    expect(await downloadStatus(null, 'doc-marked')).toBe(404);
  });

  it('shows a homeowner every homeowner document, marked or not', async () => {
    await setGates(false, false);
    expect(await listed(homeowner)).toEqual([
      'doc-hoa',
      'doc-marked',
      'doc-pub',
    ]);
    expect(await downloadStatus(homeowner, 'doc-hoa')).toBe(200);
  });
});

async function edit(body: Record<string, unknown>): Promise<Response> {
  return adminEdit({
    request: new Request('http://localhost/api/admin/documents', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    locals: { authContext: board },
  } as never);
}

async function marked(id: string): Promise<boolean> {
  const res = await adminList({
    request: new Request('http://localhost/api/admin/documents'),
    locals: { authContext: board },
  } as never);
  const docs = (await res.json()) as { id: string; tenantVisible: boolean }[];
  return docs.find((d) => d.id === id)!.tenantVisible;
}

describe('the board marking a document Tenant-Visible', () => {
  it('marks a homeowner document, and the admin list shows it', async () => {
    const res = await edit({ id: 'doc-hoa', tenantVisible: true });
    expect(res.status).toBe(204);
    expect(await marked('doc-hoa')).toBe(true);
  });

  it('unmarks a document', async () => {
    const res = await edit({ id: 'doc-marked', tenantVisible: false });
    expect(res.status).toBe(204);
    expect(await marked('doc-marked')).toBe(false);
  });

  it('refuses to mark a public or a board document', async () => {
    expect((await edit({ id: 'doc-pub', tenantVisible: true })).status).toBe(
      400,
    );
    expect((await edit({ id: 'doc-brd', tenantVisible: true })).status).toBe(
      400,
    );
    expect(await marked('doc-pub')).toBe(false);
    expect(await marked('doc-brd')).toBe(false);
  });

  it('refuses to mark a document in the same edit that moves it off the homeowner tier', async () => {
    const res = await edit({
      id: 'doc-hoa',
      visibility: 'public',
      tenantVisible: true,
    });
    expect(res.status).toBe(400);
    expect(await marked('doc-hoa')).toBe(false);
  });

  it('marks a document in the same edit that moves it onto the homeowner tier', async () => {
    const res = await edit({
      id: 'doc-brd',
      visibility: 'homeowner',
      tenantVisible: true,
    });
    expect(res.status).toBe(204);
    expect(await marked('doc-brd')).toBe(true);
  });

  it('refuses a mark that is not a boolean', async () => {
    const res = await edit({ id: 'doc-hoa', tenantVisible: 'true' });
    expect(res.status).toBe(400);
    expect(await marked('doc-hoa')).toBe(false);
  });

  it('answers 404 for a document that does not exist', async () => {
    const res = await edit({ id: 'no-such-doc', tenantVisible: true });
    expect(res.status).toBe(404);
  });

  it('clears the mark when the document leaves the homeowner tier', async () => {
    const res = await edit({ id: 'doc-marked', visibility: 'board' });
    expect(res.status).toBe(204);
    expect(await marked('doc-marked')).toBe(false);
  });

  it('keeps the mark when homeowner visibility is sent again unchanged', async () => {
    const res = await edit({ id: 'doc-marked', visibility: 'homeowner' });
    expect(res.status).toBe(204);
    expect(await marked('doc-marked')).toBe(true);
  });
});

describe('the database', () => {
  it('refuses a mark on a document that is not homeowner-tier', async () => {
    for (const id of ['doc-pub', 'doc-brd'])
      await expect(
        env.DATABASE.prepare(
          `UPDATE documents SET tenant_visible = 1 WHERE id = ?`,
        )
          .bind(id)
          .run(),
      ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      env.DATABASE.prepare(
        `UPDATE documents SET visibility = 'public' WHERE id = 'doc-marked'`,
      ).run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('starts every existing and new document unmarked', async () => {
    const now = Date.now();
    await getDb(env).run(sql`
      INSERT INTO documents (id, title, category, visibility, r2_key, filename,
        size_bytes, content_type, uploaded_at, updated_at)
      VALUES ('doc-new', 'New', 'Other', 'homeowner', 'documents/new/n.txt',
        'n.txt', 1, 'text/plain', ${now}, ${now})`);
    const row = await env.DATABASE.prepare(
      `SELECT tenant_visible FROM documents WHERE id = 'doc-new'`,
    ).first<{ tenant_visible: number }>();
    expect(row?.tenant_visible).toBe(0);
  });
});
