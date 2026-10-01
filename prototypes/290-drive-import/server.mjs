// PROTOTYPE — throwaway code for #290. Not app code; never merge, never deploy.
// Answers three questions against a test Google account (see README.md):
//   Q1  can the server export a Picker-selected file (drive.file) with a stored refresh token?
//   Q2  does the Picker work when the browser is also signed into another Google account?
//   Q3  do repeat exports of an unchanged Doc/Sheet/Slides differ byte for byte?
// All state is in memory. Tokens are never printed, logged, or rendered.

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = 8790;
const ORIGIN = `http://localhost:${PORT}`;
const REDIRECT_URI = `${ORIGIN}/oauth/callback`;
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'];
const DRIVE = 'https://www.googleapis.com/drive/v3';

function need(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Start with: npm run prototype:drive (see prototypes/290-drive-import/README.md)`);
    process.exit(1);
  }
  return value;
}
const CLIENT_ID = need('DRIVE_CLIENT_ID');
const CLIENT_SECRET = need('DRIVE_CLIENT_SECRET');
const API_KEY = need('DRIVE_PICKER_API_KEY');
const PROJECT_NUMBER = need('DRIVE_PROJECT_NUMBER');

const EXPORTS = {
  'application/vnd.google-apps.document': { mime: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.presentation': { mime: 'application/pdf', ext: 'pdf' },
  'application/vnd.google-apps.spreadsheet': {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: 'xlsx',
  },
};
const DOWNLOAD_EXTS = ['pdf', 'txt', 'md', 'csv', 'doc', 'docx', 'xls', 'xlsx'];

const state = {
  connection: null, // { refreshToken, sub, email, scope, connectedAt }
  connections: 0,
  oauthState: null,
  tokensMinted: 0,
  log: [],
  pickerEvents: [],
  picked: [], // { id, name, mimeType, run, at }
  probes: [],
  exports: [],
  determinism: [],
  bytes: new Map(),
};

const now = () => new Date().toISOString();
function log(step, ok, detail = '') {
  state.log.push({ at: now(), step, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${step}${detail ? ' — ' + detail : ''}`);
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function mintAccessToken(purpose) {
  if (!state.connection) throw new Error('not connected');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: state.connection.refreshToken,
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    log(`mint token (${purpose})`, false, `${res.status} ${json.error ?? ''} ${json.error_description ?? ''}`);
    throw new Error(`token refresh failed: ${json.error}`);
  }
  state.tokensMinted += 1;
  log(`mint token #${state.tokensMinted} (${purpose})`, true, `scope=${json.scope}`);
  return json.access_token;
}

async function drive(token, path) {
  const started = Date.now();
  const res = await fetch(`${DRIVE}/${path}`, { headers: { authorization: `Bearer ${token}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  let error = null;
  if (!res.ok) {
    try {
      const j = JSON.parse(buf.toString('utf8'));
      error = { reason: j.error?.errors?.[0]?.reason ?? j.error?.status, message: j.error?.message };
    } catch {
      error = { reason: 'non-json', message: buf.subarray(0, 200).toString('utf8') };
    }
  }
  return { status: res.status, ok: res.ok, buf, error, ms: Date.now() - started, type: res.headers.get('content-type') };
}

const META = 'id,name,mimeType,modifiedTime,size,md5Checksum,headRevisionId,shortcutDetails,capabilities/canDownload';
async function getMeta(token, id) {
  const r = await drive(token, `files/${encodeURIComponent(id)}?fields=${META}&supportsAllDrives=true`);
  return { ...r, meta: r.ok ? JSON.parse(r.buf.toString('utf8')) : null };
}

function planFor(meta) {
  if (EXPORTS[meta.mimeType]) return { kind: 'export', ...EXPORTS[meta.mimeType] };
  if (meta.mimeType === 'application/vnd.google-apps.shortcut') return { kind: 'shortcut' };
  if (meta.mimeType.startsWith('application/vnd.google-apps.')) return { kind: 'refuse', why: 'unsupported Google type' };
  const ext = (meta.name.split('.').pop() ?? '').toLowerCase();
  if (DOWNLOAD_EXTS.includes(ext)) return { kind: 'download', ext };
  return { kind: 'refuse', why: `extension .${ext} not in the upload allowlist` };
}

async function fetchContent(token, meta, plan) {
  if (plan.kind === 'export') {
    return drive(token, `files/${encodeURIComponent(meta.id)}/export?mimeType=${encodeURIComponent(plan.mime)}`);
  }
  return drive(token, `files/${encodeURIComponent(meta.id)}?alt=media&supportsAllDrives=true`);
}

function latestPicked() {
  const byId = new Map();
  for (const p of state.picked) byId.set(p.id, p);
  return [...byId.values()];
}

async function runExports() {
  const token = await mintAccessToken('server export — NOT the Picker token');
  const results = [];
  for (const p of latestPicked()) {
    const r = { at: now(), run: p.run, name: p.name, pickerMime: p.mimeType, connection: state.connections };
    const m = await getMeta(token, p.id);
    r.metaStatus = m.status;
    if (!m.ok) {
      Object.assign(r, { outcome: 'metadata failed', error: m.error });
      results.push(r);
      continue;
    }
    r.mimeType = m.meta.mimeType;
    r.modifiedTime = m.meta.modifiedTime;
    r.driveSize = m.meta.size ?? null;
    const plan = planFor(m.meta);
    r.plan = plan.kind === 'export' ? `export → ${plan.ext}` : plan.kind;
    if (plan.kind === 'refuse') {
      Object.assign(r, { outcome: 'refused (by design)', error: { reason: plan.why } });
    } else if (plan.kind === 'shortcut') {
      const target = m.meta.shortcutDetails?.targetId;
      const t = target ? await getMeta(token, target) : null;
      Object.assign(r, {
        outcome: t?.ok ? 'shortcut target readable' : 'shortcut target NOT readable',
        targetStatus: t?.status ?? null,
        error: t?.error ?? null,
      });
    } else {
      const c = await fetchContent(token, m.meta, plan);
      Object.assign(r, { contentStatus: c.status, ms: c.ms, bytes: c.buf.length });
      if (c.ok) {
        const key = `x${state.bytes.size + 1}`;
        state.bytes.set(key, { buf: c.buf, type: c.type, name: `${p.name}.${plan.ext}` });
        Object.assign(r, { outcome: 'OK', sha256: sha256(c.buf).slice(0, 16), view: `/file/${key}` });
      } else {
        Object.assign(r, { outcome: 'content failed', error: c.error });
      }
    }
    results.push(r);
    log(`export ${p.name}`, r.outcome === 'OK' || r.outcome.startsWith('refused'), r.outcome);
  }
  state.exports.push(...results);
  return results;
}

function printable(buf) {
  return buf.toString('latin1').replace(/[^\x20-\x7e]/g, '·');
}
function diffDetail(a, b) {
  const len = Math.min(a.length, b.length);
  let first = -1;
  let count = 0;
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) {
      if (first < 0) first = i;
      count++;
    }
  }
  const lo = Math.max(0, first - 60);
  const markers = {};
  for (const key of ['/CreationDate', '/ModDate', '/ID', 'dcterms:created', 'dcterms:modified']) {
    const grab = (buf) => {
      const s = buf.toString('latin1');
      const i = s.indexOf(key);
      return i < 0 ? null : printable(Buffer.from(s.slice(i, i + 90), 'latin1'));
    };
    const va = grab(a);
    const vb = grab(b);
    if (va || vb) markers[key] = { same: va === vb, first: va, second: vb };
  }
  return {
    sizeA: a.length,
    sizeB: b.length,
    firstDiffAt: first,
    differingBytesInOverlap: count,
    contextA: first < 0 ? null : printable(a.subarray(lo, first + 60)),
    contextB: first < 0 ? null : printable(b.subarray(lo, first + 60)),
    markers,
    note: 'XLSX is a zip: compressed parts hide text, so markers may be absent; compare zip entry timestamps by eye',
  };
}

async function runDeterminism(repeat, gapMs) {
  const token = await mintAccessToken('determinism test');
  const results = [];
  for (const p of latestPicked()) {
    const m = await getMeta(token, p.id);
    if (!m.ok || !EXPORTS[m.meta.mimeType]) continue;
    const plan = EXPORTS[m.meta.mimeType];
    const runs = [];
    for (let i = 0; i < repeat; i++) {
      if (i) await new Promise((r) => setTimeout(r, gapMs));
      const c = await fetchContent(token, m.meta, { kind: 'export', ...plan });
      runs.push(c);
    }
    const after = await getMeta(token, p.id);
    const hashes = runs.map((c) => (c.ok ? sha256(c.buf).slice(0, 16) : `ERR ${c.status}`));
    const identical = runs.every((c) => c.ok) && new Set(hashes).size === 1;
    const r = {
      at: now(),
      name: p.name,
      as: plan.ext,
      modifiedTimeUnchanged: m.meta.modifiedTime === after.meta?.modifiedTime,
      hashes,
      identical,
    };
    if (!identical && runs[0].ok && runs[1]?.ok) r.diff = diffDetail(runs[0].buf, runs[1].buf);
    results.push(r);
    log(`determinism ${p.name} (${plan.ext} ×${repeat})`, true, identical ? 'byte-identical' : 'DIFFERENT');
  }
  state.determinism.push(...results);
  return results;
}

function publicState() {
  const c = state.connection;
  return {
    connection: c
      ? {
          email: c.email,
          sub: `${c.sub.slice(0, 4)}…`,
          scope: c.scope,
          connectedAt: c.connectedAt,
          hasRefreshToken: Boolean(c.refreshToken),
        }
      : null,
    connections: state.connections,
    tokensMinted: state.tokensMinted,
    picked: latestPicked().map(({ id, ...rest }) => ({ ...rest, id: `${id.slice(0, 6)}…` })),
    pickerEvents: state.pickerEvents,
    probes: state.probes,
    exports: state.exports,
    determinism: state.determinism,
    log: state.log.slice(-40),
  };
}

function report() {
  const label = (() => {
    const seen = new Map();
    return (name, mime) => {
      if (!seen.has(name)) seen.set(name, `${(mime ?? 'file').split('.').pop().split('/').pop()} #${seen.size + 1}`);
      return seen.get(name);
    };
  })();
  const lines = ['# #290 Drive import prototype — results', '', `Generated ${now()}. File names and IDs are replaced with labels.`, ''];
  lines.push('## Q1 — server export of Picker-selected files with a stored refresh token', '');
  for (const p of state.probes) lines.push(`- Negative control (file ID not picked): files.get → ${p.status} ${p.error?.reason ?? ''}`);
  for (const e of state.exports) {
    lines.push(`- [conn ${e.connection}, run ${e.run}] ${label(e.name, e.mimeType ?? e.pickerMime)} (${e.plan ?? '-'}): **${e.outcome}**` +
      `${e.bytes != null ? `, ${e.bytes} bytes` : ''}${e.error ? `, ${e.error.reason ?? ''} ${e.error.message ?? ''}` : ''}`);
  }
  lines.push('', '## Q2 — Picker with another Google account signed in', '');
  for (const ev of state.pickerEvents) lines.push(`- run ${ev.run}: ${ev.event}${ev.detail ? ` — ${ev.detail}` : ''}`);
  lines.push('', '## Q3 — repeat exports of unchanged files', '');
  for (const d of state.determinism) {
    lines.push(`- ${label(d.name)} as ${d.as}: **${d.identical ? 'byte-identical' : 'different'}** across ${d.hashes.length} exports; modifiedTime unchanged: ${d.modifiedTimeUnchanged}`);
    if (d.diff) {
      lines.push(`  - sizes ${d.diff.sizeA} / ${d.diff.sizeB}; first difference at byte ${d.diff.firstDiffAt}; ${d.diff.differingBytesInOverlap} differing bytes in overlap`);
      for (const [k, v] of Object.entries(d.diff.markers)) lines.push(`  - ${k}: ${v.same ? 'same' : 'differs'}`);
    }
  }
  lines.push('', `Connections made: ${state.connections}. Access tokens minted: ${state.tokensMinted}.`);
  return lines.join('\n');
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}
function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body, null, 2) : body);
}

async function handle(req, res) {
  const url = new URL(req.url, ORIGIN);
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/state') return send(res, 200, publicState());
    if (req.method === 'GET' && url.pathname === '/report') return send(res, 200, report(), 'text/markdown; charset=utf-8');

    if (req.method === 'GET' && url.pathname === '/connect') {
      state.oauthState = crypto.randomUUID();
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent select_account',
        state: state.oauthState,
      });
      res.writeHead(302, { location: auth.toString() });
      return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/oauth/callback') {
      if (url.searchParams.get('error')) {
        log('consent', false, url.searchParams.get('error'));
        return send(res, 400, `Consent failed: ${url.searchParams.get('error')}`, 'text/plain');
      }
      if (!state.oauthState || url.searchParams.get('state') !== state.oauthState) {
        return send(res, 400, 'state mismatch', 'text/plain');
      }
      state.oauthState = null;
      const tr = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code: url.searchParams.get('code'),
          grant_type: 'authorization_code',
          redirect_uri: REDIRECT_URI,
        }),
      });
      const tj = await tr.json();
      if (!tr.ok) {
        log('code exchange', false, `${tr.status} ${tj.error}`);
        return send(res, 400, `Code exchange failed: ${tj.error}`, 'text/plain');
      }
      // The id_token came straight from Google's token endpoint over TLS; a prototype may read it unverified.
      const claims = JSON.parse(Buffer.from(tj.id_token.split('.')[1], 'base64url').toString('utf8'));
      if (state.connection && state.connection.sub !== claims.sub) {
        log('connect', false, 'different Google account than the current connection — refused (same-account rule)');
        return send(res, 409, 'Refused: a different Google account. Disconnect first. <a href="/">back</a>', 'text/html');
      }
      if (!tj.refresh_token) log('connect', false, 'no refresh_token returned');
      state.connection = {
        refreshToken: tj.refresh_token,
        sub: claims.sub,
        email: claims.email,
        scope: tj.scope,
        connectedAt: now(),
      };
      state.connections += 1;
      log(`connect #${state.connections}`, Boolean(tj.refresh_token), `scope=${tj.scope}`);
      res.writeHead(302, { location: '/' });
      return res.end();
    }

    if (req.method === 'POST' && url.pathname === '/picker-token') {
      const accessToken = await mintAccessToken('Picker session in the browser');
      return send(res, 200, { accessToken, apiKey: API_KEY, appId: PROJECT_NUMBER });
    }
    if (req.method === 'POST' && url.pathname === '/picker-event') {
      const b = await readJson(req);
      state.pickerEvents.push({ at: now(), run: b.run, event: b.event, detail: b.detail ?? '' });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/picked') {
      const b = await readJson(req);
      for (const d of b.docs) state.picked.push({ ...d, run: b.run, at: now() });
      log(`picked ${b.docs.length} file(s)`, true, `run ${b.run}`);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/probe') {
      const b = await readJson(req);
      const token = await mintAccessToken('negative control');
      const m = await getMeta(token, String(b.fileId).trim());
      state.probes.push({ at: now(), status: m.status, error: m.error });
      log('negative control (unpicked file ID)', !m.ok, `${m.status} ${m.error?.reason ?? 'READABLE'}`);
      return send(res, 200, { status: m.status, error: m.error });
    }
    if (req.method === 'POST' && url.pathname === '/export') return send(res, 200, await runExports());
    if (req.method === 'POST' && url.pathname === '/determinism') {
      const b = await readJson(req);
      return send(res, 200, await runDeterminism(Math.max(2, Number(b.repeat ?? 3)), Number(b.gapMs ?? 5000))); // coercion-ok: prototype
    }
    if (req.method === 'POST' && url.pathname === '/disconnect') {
      if (state.connection) {
        const r = await fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: state.connection.refreshToken }),
        });
        log('disconnect (revoke at Google)', r.ok, `${r.status}`);
        state.connection = null; // picked list is kept on purpose: re-export after reconnect tests grant persistence
      }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/file/')) {
      const f = state.bytes.get(url.pathname.slice(6));
      if (!f) return send(res, 404, 'gone', 'text/plain');
      res.writeHead(200, { 'content-type': f.type ?? 'application/octet-stream', 'content-disposition': `inline; filename="${encodeURIComponent(f.name)}"` });
      return res.end(f.buf);
    }
    return send(res, 404, { error: 'not found' });
  } catch (err) {
    log(`${req.method} ${url.pathname}`, false, err.message);
    return send(res, 500, { error: err.message });
  }
}

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>PROTOTYPE — #290 Drive import</title>
<style>
  body{font:14px/1.45 system-ui,sans-serif;margin:16px;max-width:1100px;background:#fff;color:#111}
  .banner{background:#7a1f1f;color:#fff;padding:8px 12px;font-weight:600}
  section{border:1px solid #ccc;padding:10px 12px;margin:12px 0}
  h2{font-size:15px;margin:0 0 6px} button{margin:2px 6px 2px 0} pre{background:#f4f4f4;padding:8px;overflow:auto;max-height:420px}
  label{margin-right:12px} input[type=text]{width:340px}
</style></head><body>
<div class="banner">PROTOTYPE — throwaway (#290). Test Google account only. Not the real site.</div>

<section><h2>0. Connect (as the THROWAWAY test account)</h2>
  <a href="/connect"><button>Connect / reconnect</button></a>
  <button onclick="post('/disconnect').then(refresh)">Disconnect (revoke at Google)</button>
  <div id="conn"></div>
</section>

<section><h2>1. Negative control — a file ID you have NOT picked</h2>
  Copy a file ID from the test account's Drive URL (…/d/<b>FILE_ID</b>/edit) <i>before</i> picking it.
  <br><input type="text" id="probeId" placeholder="file ID"> <button onclick="probe()">files.get without picking</button>
  <span id="probeOut"></span>
</section>

<section><h2>2. Picker (Q2: repeat once per browser scenario)</h2>
  Scenario:
  <label><input type="radio" name="run" value="A" checked> A — browser signed into the test account only</label>
  <label><input type="radio" name="run" value="B"> B — also signed into your own Google account</label>
  <label><input type="radio" name="run" value="C"> C — signed into your own account only / private window</label>
  <br><button onclick="openPicker()">Open Picker</button>
  <br>What did the Picker show? <input type="text" id="note" placeholder="e.g. test account's files / my own files / error text">
  <button onclick="note()">Record note</button>
</section>

<section><h2>3. Server-side export of everything picked (Q1)</h2>
  <button onclick="post('/export').then(refresh)">Export picked files with a server-minted token</button>
</section>

<section><h2>4. Repeat-export comparison (Q3)</h2>
  <button onclick="post('/determinism',{repeat:3,gapMs:5000}).then(refresh)">Export each Google file 3× (5 s apart) and compare</button>
  Don't edit the files while this runs.
</section>

<section><h2>5. Optional — do picks survive disconnect + reconnect?</h2>
  Disconnect (section 0), reconnect as the same test account, then run section 3 again without re-picking.
</section>

<section><h2>Results</h2><a href="/report" target="_blank">Redacted Markdown report</a><pre id="state"></pre></section>

<script src="https://apis.google.com/js/api.js"></script>
<script>
const run = () => document.querySelector('input[name=run]:checked').value;
async function post(path, body) {
  const r = await fetch(path, {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body ?? {})});
  return r.json();
}
const event = (event, detail) => post('/picker-event', {run: run(), event, detail});
async function probe() {
  const out = await post('/probe', {fileId: document.getElementById('probeId').value});
  document.getElementById('probeOut').textContent = out.status + ' ' + (out.error ? (out.error.reason + ' — ' + out.error.message) : 'READABLE (unexpected under drive.file)');
  refresh();
}
function note() { event('operator note', document.getElementById('note').value); document.getElementById('note').value=''; refresh(); }
async function openPicker() {
  const t = await post('/picker-token');
  if (t.error) { alert(t.error); return; }
  await new Promise(r => gapi.load('picker', r));
  event('picker opening', navigator.userAgent.slice(0, 80));
  const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setIncludeFolders(false).setSelectFolderEnabled(false);
  const picker = new google.picker.PickerBuilder()
    .addView(view)
    .setOAuthToken(t.accessToken)
    .setDeveloperKey(t.apiKey)
    .setAppId(t.appId)
    .setOrigin(window.location.origin)
    .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
    .setMaxItems(10)
    .setCallback(async (data) => {
      const action = data[google.picker.Response.ACTION];
      if (action === google.picker.Action.LOADED) return event('picker loaded');
      if (action === google.picker.Action.CANCEL) return event('picker cancelled');
      if (action === google.picker.Action.PICKED) {
        const docs = data[google.picker.Response.DOCUMENTS].map(d => ({
          id: d[google.picker.Document.ID], name: d[google.picker.Document.NAME], mimeType: d[google.picker.Document.MIME_TYPE]}));
        await event('picked', docs.length + ' file(s)');
        await post('/picked', {run: run(), docs});
        refresh();
        return;
      }
      event('picker action ' + action);
    })
    .build();
  picker.setVisible(true);
}
window.addEventListener('error', e => event('page error', String(e.message)));
async function refresh() {
  const s = await (await fetch('/state')).json();
  document.getElementById('conn').textContent = s.connection
    ? 'Connected as ' + s.connection.email + ' — scope: ' + s.connection.scope + ' — refresh token held: ' + s.connection.hasRefreshToken
    : 'Not connected';
  document.getElementById('state').textContent = JSON.stringify(s, null, 2);
}
refresh(); setInterval(refresh, 3000);
</script></body></html>`;

// Bind loopback only, on both stacks, because browsers may resolve localhost to ::1 first.
for (const host of ['127.0.0.1', '::1']) {
  http
    .createServer(handle)
    .on('error', (e) => console.error(`listen ${host}: ${e.code}`))
    .listen(PORT, host);
}
console.log(`PROTOTYPE #290 — open ${ORIGIN}  (Ctrl+C to stop; all state is lost on exit)`);
