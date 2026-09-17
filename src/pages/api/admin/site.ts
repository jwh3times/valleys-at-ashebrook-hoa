import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  requireBoard,
  resolveAuthContext,
} from '../../../server/authz/api-guards';
import { readJson, stringField } from '../../../server/http';
import {
  DEFAULT_SITE_SETTINGS,
  normalizeSiteSettings,
  SITE_GATE_KEYS,
  type SiteGateKey,
  type SiteSettings,
} from '../../../lib/types';

export const prerender = false;

/**
 * The `json_set` fragment that, inside an `ON CONFLICT DO UPDATE`, rewrites
 * every gate key back to whatever is CURRENTLY stored on the conflicting
 * row — see the `PUT` handler below for why this has to happen inside the
 * SQL rather than by reading, then writing, the old value from a prior
 * SELECT.
 *
 * `json_extract`'s "best representation" of a JSON boolean is the SQL
 * integer 0/1 (SQLite has no boolean type), so copying it with
 * `json_extract(...)` would silently rewrite a gate as a JSON NUMBER; every
 * later read compares it with `json_type(value, '$.key') = 'true'`
 * (`voting-state.ts`'s `LIVE_VOTING_ENABLED_SQL`, and every homeowner-write
 * gate that follows its shape), so that rewrite would read as permanently
 * off. `json_type` names the type without coercing the value, and
 * `json('true' | 'false')` re-parses that literal back into an actual JSON
 * boolean — `json(...)`'s return value carries SQLite's JSON subtype, so
 * `json_set` inserts it as JSON `true`/`false` rather than the JSON STRING
 * `"true"`. `json_valid` fails closed to `'false'` if the stored row is
 * somehow not valid JSON, matching `getSiteSettings`'s own fail-closed
 * default.
 *
 * Built from `SITE_GATE_KEYS` — the interpolated `path` values are this
 * module's own constant, compile-time union, never request input — so a
 * future gate (ADR 0024/0025) needs to be added only to that one list.
 */
function preserveGatesOnConflict(): string {
  return SITE_GATE_KEYS.map((key) => {
    const path = `$.${key}`;
    return (
      `'${path}', json(CASE WHEN json_valid(settings.value) ` +
      `AND json_type(settings.value, '${path}') = 'true' ` +
      `THEN 'true' ELSE 'false' END)`
    );
  }).join(',\n      ');
}

/**
 * `PUT` replaces the presentation fields (name, tagline, welcome copy, the
 * disclaimer, the about body) but PRESERVES the stored value of every gate
 * key, ignoring whatever the body sends for it. #363: a stale Site Settings
 * tab saving only the tagline used to silently re-send the `officialMode`/
 * `liveVotingEnabled` values it loaded with, reverting either flag out from
 * under a since-changed value. The preserve happens inside the UPSERT's own
 * `ON CONFLICT DO UPDATE SET`, reading the gate keys off the row AS IT IS
 * AT WRITE TIME, so a gate transition (`setSiteGate` below) landing between
 * this request's read and write cannot be clobbered — there is no
 * read-then-write window for it to land in.
 *
 * On a genuinely first-ever save (no stored row exists to preserve), the
 * inserted row carries the gate DEFAULTS regardless of what the body sent —
 * a gate cannot be switched on through this route even once.
 *
 * This route does not carry an `updatedAt` precondition on the presentation
 * fields (see #363's "ideally with an updatedAt precondition" suggestion).
 * Adding one means threading `updatedAt` through `GET /api/content/site`,
 * the `SiteManager` form's state, and this body, and deciding a `409`
 * conflict UI for free-text fields (tagline, welcome copy) that is out of
 * scope for the gate-auditing bug this route exists to fix. The lost-update
 * hazard the issue actually reports — the two boolean gates — is fully
 * closed by the preserve above and by `setSiteGate`'s compare-and-swap,
 * independently of whether the presentation fields ever gain one.
 */
export const PUT: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const normalized = normalizeSiteSettings(parsed.value);
  const forInsert: SiteSettings = { ...normalized };
  for (const key of SITE_GATE_KEYS) forInsert[key] = DEFAULT_SITE_SETTINGS[key];
  const value = JSON.stringify(forInsert);
  const nowSeconds = Math.floor(Date.now() / 1000);

  await env.DATABASE.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ('site', ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = json_set(
         excluded.value,
         ${preserveGatesOnConflict()}
       ),
       updated_at = excluded.updated_at`,
  )
    .bind(value, nowSeconds)
    .run();

  return new Response(null, { status: 204 });
};

/**
 * The audited compare-and-swap for one gate key — ADR 0024's mechanism
 * ("Two flags, both required, both fail-closed"), built here for the two
 * gates that already exist so ADR 0024/0025 can add `lotRecordsEnabled`/
 * `onlinePaymentsEnabled` to `SITE_GATE_KEYS` and get this path for free.
 *
 * One D1 batch, three statements, so a lost race or a stale `expected`
 * leaves ZERO rows anywhere:
 *
 *  1. An idempotent `ON CONFLICT DO NOTHING` seed. Without it, a gate
 *     transition attempted before the `settings` row has ever been written
 *     (a brand-new site) would compare `expected` against nothing and
 *     always lose the race, even for the correct default. The seed makes
 *     the row's real starting values the recorded defaults before the CAS
 *     below reads them, atomically, in the same batch.
 *  2. The CAS `UPDATE`, gated on the CURRENT stored boolean at
 *     `'$.<key>'` matching `expected` — the same `changes() = 1`
 *     compare-and-swap convention `motions.ts`/`elections.ts` already use
 *     at a mutation boundary.
 *  3. A `setting_changes` insert gated on `changes() = 1` from the
 *     immediately preceding statement (D1 executes one batch as one
 *     transaction, so `changes()` here reads statement 2's row count, not
 *     statement 1's) — the same guarded-insert idiom
 *     `setMemberVotes`/`setBallots` use to gate one set-based `INSERT` on a
 *     preceding CAS.
 *
 * A gate key ABSENT from the stored blob reads as `false`, not as a
 * mismatch: `json_type` returns NULL for a missing path, so without the
 * `COALESCE` the CAS would match no row for EITHER `expected` and answer
 * 409 forever, with no way out but saving the presentation form. Today's
 * row carries both keys, but a gate added later (ADR 0024's
 * `lotRecordsEnabled`, ADR 0025's `onlinePaymentsEnabled`) is absent from
 * every row written before it existed, and absent-means-false is the same
 * fail-closed reading `normalizeSiteSettings` and `LIVE_VOTING_ENABLED_SQL`
 * already give it.
 *
 * `expected === value` is refused before any statement runs: a "swap" to
 * the value already requested as `expected` writes nothing, and a boolean
 * has no third state to distinguish "no-op" from "conflict" after the fact
 * — see the note above `preserveGatesOnConflict` for why a boolean's
 * final stored state can't be used to infer which request caused it. #363
 * asks this to be picked and documented: this route answers `409`, the same
 * code a genuine lost race answers, rather than a silent no-op `204`.
 */
async function setSiteGate(
  body: unknown,
  actorAccountId: string,
): Promise<Response> {
  const key = stringField(body, 'key');
  if (!(SITE_GATE_KEYS as readonly string[]).includes(key))
    return new Response(
      `Unknown setting key — expected one of: ${SITE_GATE_KEYS.join(', ')}`,
      { status: 400 },
    );
  const gateKey = key as SiteGateKey;

  const record = body as Record<string, unknown> | null;
  const expected = record?.expected;
  const value = record?.value;
  if (typeof expected !== 'boolean' || typeof value !== 'boolean')
    return new Response('expected and value must both be booleans', {
      status: 400,
    });
  if (expected === value)
    return new Response(
      `${gateKey} is already ${value ? 'on' : 'off'} — nothing to swap`,
      { status: 409 },
    );

  const path = `$.${gateKey}`;
  const expectedType = expected ? 'true' : 'false';
  const newType = value ? 'true' : 'false';
  const nowSeconds = Math.floor(Date.now() / 1000);
  const recordedAtMs = Date.now();
  const changeId = crypto.randomUUID();

  const seed = env.DATABASE.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ('site', ?, ?)
     ON CONFLICT(key) DO NOTHING`,
  ).bind(JSON.stringify(DEFAULT_SITE_SETTINGS), nowSeconds);

  const primary = env.DATABASE.prepare(
    `UPDATE settings
     SET value = json_set(value, ?, json(?)), updated_at = ?
     WHERE key = 'site'
       AND json_valid(value)
       AND COALESCE(json_type(value, ?), 'false') = ?`,
  ).bind(path, newType, nowSeconds, path, expectedType);

  const insertChange = env.DATABASE.prepare(
    `INSERT INTO setting_changes
       (id, key, old_value, new_value, acting_account_id, recorded_at)
     SELECT ?, ?, ?, ?, ?, ?
     WHERE changes() = 1`,
  ).bind(
    changeId,
    gateKey,
    expectedType,
    newType,
    actorAccountId,
    recordedAtMs,
  );

  const [, primaryResult, insertResult] = await env.DATABASE.batch([
    seed,
    primary,
    insertChange,
  ]);

  if (primaryResult.meta.changes !== 1)
    return new Response(
      `${gateKey} was changed by someone else — reload and try again`,
      { status: 409 },
    );
  if (insertResult.meta.changes !== 1)
    return new Response(
      `${gateKey} was changed, but its audit record was not — contact an administrator`,
      { status: 500 },
    );
  return new Response(null, { status: 204 });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await requireBoard(locals, request, env);
  if (denied) return denied;
  const parsed = await readJson(request);
  if (!parsed.ok) return new Response('Malformed JSON body', { status: 400 });
  const ctx = await resolveAuthContext(locals, request, env);
  if (!ctx) return new Response('Unauthorized', { status: 401 });
  const action = stringField(parsed.value, 'action');

  switch (action) {
    case 'setGate':
      return setSiteGate(parsed.value, ctx.userId);
    default:
      return new Response('Unknown action', { status: 400 });
  }
};
