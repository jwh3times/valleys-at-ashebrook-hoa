import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../src/server/db/client';
import { announcements } from '../../src/server/db/schema';
import { fetchAnnouncementsFor } from '../../src/server/content/reads';

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  await getDb(env).delete(announcements);
});

describe('announcement content reads', () => {
  it('applies the optional limit in the read helper', async () => {
    const db = getDb(env);
    await db.insert(announcements).values([
      {
        id: 'a1',
        title: 'First',
        body: 'First body',
        date: '2026-07-08',
        pinned: false,
        visibility: 'public',
      },
      {
        id: 'a2',
        title: 'Second',
        body: 'Second body',
        date: '2026-07-07',
        pinned: false,
        visibility: 'public',
      },
      {
        id: 'a3',
        title: 'Third',
        body: 'Third body',
        date: '2026-07-06',
        pinned: false,
        visibility: 'public',
      },
      {
        id: 'a4',
        title: 'Fourth',
        body: 'Fourth body',
        date: '2026-07-05',
        pinned: false,
        visibility: 'public',
      },
      {
        id: 'a5',
        title: 'Fifth',
        body: 'Fifth body',
        date: '2026-07-04',
        pinned: false,
        visibility: 'public',
      },
    ]);

    const limited = await fetchAnnouncementsFor(env, 'visitor', 4);
    const unlimited = await fetchAnnouncementsFor(env, 'visitor');

    expect(limited.map((a) => a.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(unlimited.map((a) => a.id)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
  });
});
