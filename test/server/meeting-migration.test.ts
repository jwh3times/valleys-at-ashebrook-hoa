import { env, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

const migrations = env.MIGRATIONS!;
const approvalProvenanceMigration = migrations.find((entry) =>
  entry.name.startsWith('0018'),
);

beforeAll(async () => {
  await applyD1Migrations(
    env.DATABASE,
    migrations.filter((entry) => !entry.name.startsWith('0018')),
  );
});

describe('meeting approval provenance migration', () => {
  it('upgrades populated data without cascading away motions or votes', async () => {
    expect(approvalProvenanceMigration).toBeDefined();
    const timestamp = Math.floor(Date.now() / 1000);
    const meetingInsert = `INSERT INTO meetings
      (id, body, kind, date, title, status, visibility,
       approved_by_motion_id, created_by, created_at, updated_at)
      VALUES (?, 'board', 'regular', ?, ?, 'draft', 'board', ?, 'u1', ?, ?)`;

    await env.DATABASE.batch([
      env.DATABASE.prepare(meetingInsert).bind(
        'minutes-meeting',
        '2026-01-01',
        'January meeting',
        null,
        timestamp,
        timestamp,
      ),
      env.DATABASE.prepare(meetingInsert).bind(
        'approving-meeting',
        '2026-02-01',
        'February meeting',
        null,
        timestamp,
        timestamp,
      ),
      env.DATABASE.prepare(meetingInsert).bind(
        'dangling-meeting',
        '2026-03-01',
        'March meeting',
        'missing-motion',
        timestamp,
        timestamp,
      ),
      env.DATABASE.prepare(
        `INSERT INTO board_people
          (id, full_name, created_at, updated_at)
         VALUES ('person-1', 'A. Reyes', ?, ?)`,
      ).bind(timestamp, timestamp),
    ]);
    await env.DATABASE.prepare(
      `INSERT INTO motions
        (id, meeting_id, sequence, text, voting_state, voting_revision,
         outcome, created_by, created_at, updated_at)
       VALUES ('approval-motion', 'approving-meeting', 1,
         'Approve the prior minutes', 'none', 0, 'passed', 'u1', ?, ?)`,
    )
      .bind(timestamp, timestamp)
      .run();
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        `UPDATE meetings
         SET approved_by_motion_id = 'approval-motion'
         WHERE id = 'minutes-meeting'`,
      ),
      env.DATABASE.prepare(
        `INSERT INTO board_votes (id, motion_id, person_id, choice)
         VALUES ('vote-1', 'approval-motion', 'person-1', 'yes')`,
      ),
    ]);

    await applyD1Migrations(env.DATABASE, [approvalProvenanceMigration!]);

    const meetingRows = await env.DATABASE.prepare(
      `SELECT id, approved_by_motion_id AS approvedByMotionId
       FROM meetings ORDER BY id`,
    ).all<{ id: string; approvedByMotionId: string | null }>();
    expect(meetingRows.results).toEqual([
      { id: 'approving-meeting', approvedByMotionId: null },
      { id: 'dangling-meeting', approvedByMotionId: null },
      { id: 'minutes-meeting', approvedByMotionId: 'approval-motion' },
    ]);
    expect(
      (await env.DATABASE.prepare('SELECT id FROM motions').all()).results,
    ).toEqual([{ id: 'approval-motion' }]);
    expect(
      (await env.DATABASE.prepare('SELECT id FROM board_votes').all()).results,
    ).toEqual([{ id: 'vote-1' }]);
  });
});
