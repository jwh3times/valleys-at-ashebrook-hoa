import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET } from '../../src/pages/api/admin/reports';
import { legacyAuthContext } from '../../src/server/authz/context';
import { getDb } from '../../src/server/db/client';
import { reports } from '../../src/server/db/schema';
import { runScheduledJobs } from '../../src/server/scheduled';

const DAY_MS = 24 * 60 * 60 * 1000;
const boardLocals = {
  authContext: legacyAuthContext('board-1', 'board', []),
};

beforeAll(async () => {
  await applyD1Migrations(env.DATABASE, env.MIGRATIONS!);
});

beforeEach(async () => {
  await getDb(env).delete(reports);
});

async function detail(id: string) {
  const response = await GET({
    locals: boardLocals,
    request: new Request(`http://localhost/api/admin/reports?id=${id}`),
  } as never);
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    topic: string;
    contentMd: string;
    sources: unknown[];
  }>;
}

describe('saved report retention', () => {
  it('removes report text older than 90 days while retaining recent content', async () => {
    const now = Date.now();
    await getDb(env)
      .insert(reports)
      .values([
        {
          id: 'expired-report',
          topic: 'Jane Resident complaint history',
          templateKey: null,
          contentMd: 'Jane Resident submitted a complaint.',
          sourcesJson: JSON.stringify([
            { id: 'doc-1', title: 'Jane Resident letter', category: 'Other' },
          ]),
          createdAt: new Date(now - 91 * DAY_MS),
          createdBy: 'board-1',
        },
        {
          id: 'recent-report',
          topic: 'Recent report',
          templateKey: null,
          contentMd: 'Still retained.',
          sourcesJson: '[]',
          createdAt: new Date(now - 89 * DAY_MS),
          createdBy: 'board-1',
        },
      ]);

    await runScheduledJobs(env);

    expect(await detail('expired-report')).toMatchObject({
      topic: 'Report content removed',
      contentMd:
        '## Report content removed\n\nThe saved report text was removed under the 90-day retention policy.',
      sources: [],
    });
    expect((await detail('recent-report')).contentMd).toBe('Still retained.');
  });
});
