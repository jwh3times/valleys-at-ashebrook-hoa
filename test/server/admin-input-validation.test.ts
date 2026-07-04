import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../src/server/authz/context', () => ({
  getAuthContext: async () => ({ userId: 'b', role: 'board', propertyIds: [] }),
}));

import { POST as announcementsPost } from '../../src/pages/api/admin/announcements';
import { POST as propertiesPost } from '../../src/pages/api/admin/properties';
import { POST as ownersPost } from '../../src/pages/api/admin/owners';
import { POST as documentsPost } from '../../src/pages/api/admin/documents';
import { POST as membersPost } from '../../src/pages/api/admin/members';
import { GET as announcementsGet } from '../../src/pages/api/content/announcements';
import { getDb } from '../../src/server/db/client';
import {
  announcements,
  manualApprovalQueue,
  owners,
  properties,
} from '../../src/server/db/schema';
import { eq } from 'drizzle-orm';
import { INPUT_LIMITS } from '../../src/lib/types';

const jsonPost = (url: string, body: unknown) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
  const db = getDb(env);
  const now = new Date();
  await db.insert(properties).values([
    {
      id: 'prop-active',
      address: 'Active',
      addressNormalized: 'active',
      unit: null,
      status: 'active',
      notes: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'prop-inactive',
      address: 'Inactive',
      addressNormalized: 'inactive',
      unit: null,
      status: 'inactive',
      notes: null,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(manualApprovalQueue).values({
    id: 'q1',
    userId: 'u-approve',
    claimedAddress: 'Somewhere',
    reason: 'manual',
    status: 'pending',
    createdAt: now,
  });
  await db.insert(announcements).values([
    {
      id: 'an1',
      title: 'A1',
      body: 'b',
      date: '2026-01-01',
      visibility: 'public',
    },
    {
      id: 'an2',
      title: 'A2',
      body: 'b',
      date: '2026-01-02',
      visibility: 'public',
    },
    {
      id: 'an3',
      title: 'A3',
      body: 'b',
      date: '2026-01-03',
      visibility: 'public',
    },
  ]);
});

describe('announcements write validation', () => {
  it('rejects a malformed JSON body with 400', async () => {
    const res = await announcementsPost({
      request: new Request('http://localhost/api/admin/announcements', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not valid json',
      }),
    } as never);
    expect(res.status).toBe(400);
  });

  it('rejects a whitespace-only title with 400', async () => {
    const res = await announcementsPost({
      request: jsonPost('http://localhost/api/admin/announcements', {
        title: '   ',
        body: 'ok',
        date: '2026-02-02',
      }),
    } as never);
    expect(res.status).toBe(400);
  });

  it('rejects an over-length body with 400', async () => {
    const res = await announcementsPost({
      request: jsonPost('http://localhost/api/admin/announcements', {
        title: 'T',
        body: 'x'.repeat(INPUT_LIMITS.body + 1),
        date: '2026-02-02',
      }),
    } as never);
    expect(res.status).toBe(400);
  });

  it('rejects a malformed date with 400', async () => {
    const res = await announcementsPost({
      request: jsonPost('http://localhost/api/admin/announcements', {
        title: 'T',
        body: 'B',
        date: '02/02/2026',
      }),
    } as never);
    expect(res.status).toBe(400);
  });

  it('trims a valid announcement before storing', async () => {
    const res = await announcementsPost({
      request: jsonPost('http://localhost/api/admin/announcements', {
        title: '  Trimmed Notice  ',
        body: '  hello  ',
        date: '2026-03-03',
        sneaky: 'ignored',
      }),
    } as never);
    expect(res.status).toBe(201);
    const [row] = await getDb(env)
      .select()
      .from(announcements)
      .where(eq(announcements.title, 'Trimmed Notice'));
    expect(row).toBeTruthy();
    expect(row.body).toBe('hello');
  });
});

describe('properties write validation', () => {
  it('rejects a missing address with 400', async () => {
    const res = await propertiesPost({
      request: jsonPost('http://localhost/api/admin/properties', { unit: 'A' }),
    } as never);
    expect(res.status).toBe(400);
  });

  it('rejects an over-length address with 400', async () => {
    const res = await propertiesPost({
      request: jsonPost('http://localhost/api/admin/properties', {
        address: 'x'.repeat(INPUT_LIMITS.address + 1),
      }),
    } as never);
    expect(res.status).toBe(400);
  });
});

describe('owners write validation', () => {
  it('rejects missing required fields with 400', async () => {
    const res = await ownersPost({
      request: jsonPost('http://localhost/api/admin/owners', {
        fullName: 'Jane',
      }),
    } as never);
    expect(res.status).toBe(400);
  });

  it('trims and maps an empty email to null', async () => {
    const res = await ownersPost({
      request: jsonPost('http://localhost/api/admin/owners', {
        propertyId: 'prop-active',
        fullName: '  Jane Doe  ',
        email: '',
      }),
    } as never);
    expect(res.status).toBe(201);
    const [row] = await getDb(env)
      .select()
      .from(owners)
      .where(eq(owners.fullName, 'Jane Doe'));
    expect(row).toBeTruthy();
    expect(row.email).toBeNull();
  });
});

describe('documents write validation', () => {
  const upload = (fields: Record<string, string>) => {
    const form = new FormData();
    form.set('file', new File(['x'], 'doc.pdf', { type: 'application/pdf' }));
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return {
      request: new Request('http://localhost/api/admin/documents', {
        method: 'POST',
        body: form,
      }),
    } as never;
  };

  it('rejects an unknown category with 400', async () => {
    const res = await documentsPost(
      upload({ title: 'X', category: 'Bogus', visibility: 'public' }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects an over-length title with 400', async () => {
    const res = await documentsPost(
      upload({
        title: 'x'.repeat(INPUT_LIMITS.title + 1),
        category: 'Other',
        visibility: 'public',
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('members approve — property validation', () => {
  it('404 when the propertyId does not exist', async () => {
    const res = await membersPost({
      request: jsonPost('http://localhost/api/admin/members', {
        action: 'approve',
        queueId: 'q1',
        propertyId: 'nope',
      }),
    } as never);
    expect(res.status).toBe(404);
  });

  it('409 when the property is inactive', async () => {
    const res = await membersPost({
      request: jsonPost('http://localhost/api/admin/members', {
        action: 'approve',
        queueId: 'q1',
        propertyId: 'prop-inactive',
      }),
    } as never);
    expect(res.status).toBe(409);
  });
});

describe('public announcements limit clamp', () => {
  it('a negative limit does not drop items off the end', async () => {
    const all = (await (
      await announcementsGet({
        request: new Request('http://localhost/api/content/announcements'),
      } as never)
    ).json()) as unknown[];
    const negative = (await (
      await announcementsGet({
        request: new Request(
          'http://localhost/api/content/announcements?limit=-1',
        ),
      } as never)
    ).json()) as unknown[];
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(negative.length).toBe(all.length);
  });
});
