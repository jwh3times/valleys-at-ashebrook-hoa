import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import { runScheduledJobs } from '../../src/server/scheduled';

beforeAll(async () => {
  const migrations = env.MIGRATIONS!;
  await applyD1Migrations(env.DATABASE, migrations.slice(0, -1));
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      "INSERT INTO users (id,name,email,email_verified,role,created_at,updated_at) VALUES ('account','Synthetic Resident','resident@example.test',0,'board',1,1)",
    ),
    env.DATABASE.prepare(
      "INSERT INTO properties (id,address,address_normalized,created_at,updated_at) VALUES ('lot','1 Example Way','1 example way',1,1)",
    ),
    env.DATABASE.prepare(
      "INSERT INTO parties (id,kind,created_at,updated_at) VALUES ('person','person',1,1)",
    ),
    env.DATABASE.prepare(
      "INSERT INTO people (party_id,full_name,name_normalized,updated_at) VALUES ('person','Synthetic Resident','synthetic resident',1)",
    ),
    env.DATABASE.prepare(
      "INSERT INTO ownerships (id,owner_party_id,lot_id,created_at,updated_at) VALUES ('ownership','person','lot',1,1)",
    ),
    env.DATABASE.prepare(
      "INSERT INTO board_service_terms (id,person_id,qualifying_lot_id,start_day,scheduled_end_day,created_at,updated_at) VALUES ('term','person','lot','2020-01-01','2021-01-01',1,1)",
    ),
    env.DATABASE.prepare(
      "INSERT INTO board_office_assignments (id,board_term_id,person_id,office,start_day,end_day,created_at,updated_at) VALUES ('office','term','person','president','2020-01-01','2021-01-01',1,1)",
    ),
    env.DATABASE.prepare(
      "INSERT INTO cutover_settings (key,value,updated_at) VALUES ('cutover_mode','derived',1),('write_freeze','on',1)",
    ),
  ]);
  await applyD1Migrations(env.DATABASE, migrations);
});

it('leaves only the permanent roster schema and runs every scheduled job', async () => {
  const tables = await env.DATABASE.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all<{ name: string }>();
  const names = tables.results.map((row) => row.name);
  expect(names).toContain('lots');
  for (const removed of [
    'properties',
    'owners',
    'board_people',
    'board_service_terms',
    'user_property_links',
    'property_verifications',
    'manual_approval_queue',
    'cutover_shadow_mismatches',
  ]) {
    expect(names).not.toContain(removed);
  }
  expect(
    (await env.DATABASE.prepare('PRAGMA foreign_key_check').all()).results,
  ).toEqual([]);
  await expect(runScheduledJobs(env)).resolves.toBeUndefined();
});

it('preserves roster history, renamed foreign keys, and the operator freeze', async () => {
  expect(
    await env.DATABASE.prepare(
      "SELECT lot_id FROM ownerships WHERE id='ownership'",
    ).first(),
  ).toEqual({ lot_id: 'lot' });
  expect(
    await env.DATABASE.prepare(
      "SELECT qualifying_lot_id FROM board_terms WHERE id='term'",
    ).first(),
  ).toEqual({ qualifying_lot_id: 'lot' });
  expect(
    await env.DATABASE.prepare(
      "SELECT board_term_id,person_id FROM board_office_assignments WHERE id='office'",
    ).first(),
  ).toEqual({ board_term_id: 'term', person_id: 'person' });
  expect(
    await env.DATABASE.prepare(
      "SELECT role FROM users WHERE id='account'",
    ).first(),
  ).toEqual({ role: 'visitor' });
  expect(
    (await env.DATABASE.prepare('SELECT key,value FROM cutover_settings').all())
      .results,
  ).toEqual([{ key: 'write_freeze', value: 'on' }]);
  await expect(
    env.DATABASE.prepare("DELETE FROM lots WHERE id='lot'").run(),
  ).rejects.toThrow();
  await expect(
    env.DATABASE.prepare("DELETE FROM board_terms WHERE id='term'").run(),
  ).rejects.toThrow();
});
