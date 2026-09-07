'use strict';
// Relay worker (relay/src/worker.js) driven directly under Node with an in-memory KV, plus one
// end-to-end run: createPhoneSync → worker → decryptEnvelope reproduces the payload.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const worker = require('../relay/src/worker.js').default;
const { createPhoneSync, deriveSlot, encryptPayload, decryptEnvelope } = require('../src/main/sync');

const T0 = 1_788_700_000_000;
const ORIGIN = 'https://relay.test';
const SLOT_TTL = 7 * 24 * 60 * 60;
const K = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const D = deriveSlot(K);
const OTHER = deriveSlot(Buffer.alloc(32, 0xaa));
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function kvMock() {
  const map = new Map();
  const puts = [];
  return {
    map,
    puts,
    async get(key, type) {
      const v = map.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value, opts) {
      puts.push({ key, opts: opts || {} });
      map.set(key, value);
    },
    async delete(key) { map.delete(key); },
  };
}

function envelope(overrides = {}) {
  const base = encryptPayload(D.encKey, D.slotId, { v: 1, generatedAt: T0, hello: 'phone' }, { iv: Buffer.alloc(12, 3), ts: T0 });
  return { ...base, ...overrides };
}

function call(kv, method, path, { body, headers = {} } = {}) {
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return worker.fetch(new Request(ORIGIN + path, init), { SLOTS: kv });
}

const writeHeaders = (d = D) => ({ Authorization: `Bearer ${d.writeToken}`, 'X-Read-Token': d.readToken, 'Content-Type': 'application/json' });
const readHeaders = (d = D) => ({ Authorization: `Bearer ${d.readToken}` });

async function put(kv, env = envelope(), headers = writeHeaders()) {
  return call(kv, 'PUT', `/v1/slots/${D.slotId}`, { body: env, headers });
}

test('health: 200 {ok,v} with Cache-Control no-store; wrong method 405', async () => {
  const kv = kvMock();
  const res = await call(kv, 'GET', '/v1/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, v: 1 });
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.match(res.headers.get('Content-Type'), /application\/json/);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null, 'no CORS');
  assert.equal((await call(kv, 'GET', '/v1/health/')).status, 200, 'trailing slash tolerated');
  const post = await call(kv, 'POST', '/v1/health');
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('Allow'), 'GET, HEAD');
  assert.equal(post.headers.get('Cache-Control'), 'no-store');
});

test('first write claims the slot: 204, record stores token hashes + envelope with a 7-day TTL', async () => {
  const kv = kvMock();
  const env = envelope();
  const res = await put(kv, env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(await res.text(), '');
  const record = JSON.parse(kv.map.get(D.slotId));
  assert.equal(record.wh, sha(D.writeToken));
  assert.equal(record.rh, sha(D.readToken));
  assert.deepEqual(record.env, env);
  assert.equal(typeof record.updatedAt, 'number');
  assert.deepEqual(kv.puts[0].opts, { expirationTtl: SLOT_TTL });
  assert.ok(!kv.map.get(D.slotId).includes(D.writeToken), 'tokens are stored hashed only');
  assert.ok(!kv.map.get(D.slotId).includes(D.readToken));
});

test('a later PUT with a different write token is 401 and leaves the record alone', async () => {
  const kv = kvMock();
  await put(kv);
  const before = kv.map.get(D.slotId);
  const res = await put(kv, envelope({ ts: T0 + 1 }), writeHeaders(OTHER));
  assert.equal(res.status, 401);
  assert.equal(kv.map.get(D.slotId), before);
  assert.equal(kv.puts.length, 1);
});

test('GET: right read token → envelope, wrong/malformed → 401, before any push → 404', async () => {
  const kv = kvMock();
  const missing = await call(kv, 'GET', `/v1/slots/${D.slotId}`, { headers: readHeaders() });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('Cache-Control'), 'no-store');

  const env = envelope();
  await put(kv, env);
  const ok = await call(kv, 'GET', `/v1/slots/${D.slotId}`, { headers: readHeaders() });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), env);
  assert.equal(ok.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(decryptEnvelope(D.encKey, D.slotId, env), { v: 1, generatedAt: T0, hello: 'phone' });

  assert.equal((await call(kv, 'GET', `/v1/slots/${D.slotId}`, { headers: readHeaders(OTHER) })).status, 401);
  assert.equal((await call(kv, 'GET', `/v1/slots/${D.slotId}`, { headers: { Authorization: `Bearer ${D.writeToken}` } })).status, 401, 'write token cannot read');
  assert.equal((await call(kv, 'GET', `/v1/slots/${D.slotId}`)).status, 401, 'no token');
  assert.equal((await call(kv, 'GET', `/v1/slots/${D.slotId}`, { headers: { Authorization: 'Bearer short' } })).status, 401);
  assert.equal((await call(kv, 'GET', `/v1/slots/${D.slotId}`, { headers: { Authorization: `Basic ${D.readToken}` } })).status, 401);
  assert.equal((await call(kv, 'GET', `/v1/slots/${D.slotId}`, { headers: { Authorization: `Bearer ${D.readToken.toUpperCase()}` } })).status, 401, 'lowercase hex only');
});

test('PUT: 413 over 256 KB, 400 bad id / body / envelope, 401 missing tokens', async () => {
  const kv = kvMock();
  const big = envelope({ ct: Buffer.alloc(200 * 1024).toString('base64') }); // > 256 KB once base64-encoded
  assert.equal((await put(kv, big)).status, 413);
  assert.equal(kv.puts.length, 0);

  assert.equal((await call(kv, 'PUT', '/v1/slots/not-a-slot', { body: envelope(), headers: writeHeaders() })).status, 400);
  assert.equal((await call(kv, 'PUT', `/v1/slots/${D.slotId.toUpperCase()}`, { body: envelope(), headers: writeHeaders() })).status, 400, 'lowercase hex only');
  assert.equal((await call(kv, 'PUT', `/v1/slots/${D.slotId}0`, { body: envelope(), headers: writeHeaders() })).status, 400, '33 chars');
  assert.equal((await call(kv, 'GET', '/v1/slots/xyz', { headers: readHeaders() })).status, 400);

  assert.equal((await put(kv, '{not json')).status, 400);
  assert.equal((await put(kv, '[]')).status, 400);
  assert.equal((await put(kv, 'null')).status, 400);
  assert.equal((await put(kv, envelope({ v: 2 }))).status, 400);
  assert.equal((await put(kv, envelope({ iv: Buffer.alloc(11).toString('base64') }))).status, 400, 'iv must be 12 bytes');
  assert.equal((await put(kv, envelope({ iv: 'not base64!!' }))).status, 400);
  assert.equal((await put(kv, envelope({ ct: Buffer.alloc(15).toString('base64') }))).status, 400, 'ct shorter than a tag');
  assert.equal((await put(kv, envelope({ ts: 'now' }))).status, 400);
  assert.equal((await put(kv, envelope({ ts: undefined }))).status, 400);
  assert.equal((await put(kv, envelope({ ct: 7 }))).status, 400);

  const noRead = { Authorization: `Bearer ${D.writeToken}` };
  assert.equal((await put(kv, envelope(), noRead)).status, 401, 'X-Read-Token required');
  assert.equal((await put(kv, envelope(), { 'X-Read-Token': D.readToken })).status, 401, 'Authorization required');
  assert.equal((await put(kv, envelope(), { Authorization: 'Bearer nope', 'X-Read-Token': D.readToken })).status, 401);
  assert.equal((await put(kv, envelope(), { Authorization: `Bearer ${D.writeToken}`, 'X-Read-Token': 'zz' })).status, 401);
  assert.equal(kv.puts.length, 0, 'nothing stored by any rejected request');

  // Extra fields on a valid envelope are dropped, not stored.
  assert.equal((await put(kv, envelope({ extra: 'x' }))).status, 204);
  assert.deepEqual(Object.keys(JSON.parse(kv.map.get(D.slotId)).env).sort(), ['ct', 'iv', 'ts', 'v']);
});

test('DELETE: owner → 204 and the record is gone; absent → 204; wrong token → 401', async () => {
  const kv = kvMock();
  assert.equal((await call(kv, 'DELETE', `/v1/slots/${D.slotId}`, { headers: { Authorization: `Bearer ${D.writeToken}` } })).status, 204, 'absent slot');
  await put(kv);
  assert.equal((await call(kv, 'DELETE', `/v1/slots/${D.slotId}`, { headers: { Authorization: `Bearer ${OTHER.writeToken}` } })).status, 401);
  assert.equal((await call(kv, 'DELETE', `/v1/slots/${D.slotId}`, { headers: { Authorization: `Bearer ${D.readToken}` } })).status, 401, 'read token cannot delete');
  assert.equal((await call(kv, 'DELETE', `/v1/slots/${D.slotId}`)).status, 401);
  assert.ok(kv.map.has(D.slotId));
  const res = await call(kv, 'DELETE', `/v1/slots/${D.slotId}`, { headers: { Authorization: `Bearer ${D.writeToken}` } });
  assert.equal(res.status, 204);
  assert.equal(kv.map.has(D.slotId), false);
  assert.equal((await call(kv, 'GET', `/v1/slots/${D.slotId}`, { headers: readHeaders() })).status, 404);
  // Freed slot can be claimed by a new key (re-pairing).
  assert.equal((await put(kv, envelope(), writeHeaders(OTHER))).status, 204);
});

test('every write refreshes the TTL and updates the read-token hash', async () => {
  const kv = kvMock();
  await put(kv);
  const rotatedRead = deriveSlot(Buffer.alloc(32, 0x5c)).readToken;
  const res = await put(kv, envelope({ ts: T0 + 1000 }), { ...writeHeaders(), 'X-Read-Token': rotatedRead });
  assert.equal(res.status, 204);
  assert.equal(kv.puts.length, 2);
  assert.deepEqual(kv.puts.map((p) => p.opts.expirationTtl), [SLOT_TTL, SLOT_TTL]);
  const record = JSON.parse(kv.map.get(D.slotId));
  assert.equal(record.rh, sha(rotatedRead), 'rh follows the latest write');
  assert.equal(record.env.ts, T0 + 1000);
  assert.equal((await call(kv, 'GET', `/v1/slots/${D.slotId}`, { headers: readHeaders() })).status, 401, 'old read token no longer works');
  assert.equal((await call(kv, 'GET', `/v1/slots/${D.slotId}`, { headers: { Authorization: `Bearer ${rotatedRead}` } })).status, 200);
});

test('routing: 405 for wrong methods on slots, 404 for unknown paths, 500 without the KV binding', async () => {
  const kv = kvMock();
  const post = await call(kv, 'POST', `/v1/slots/${D.slotId}`, { body: envelope(), headers: writeHeaders() });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('Allow'), 'GET, PUT, DELETE');
  assert.equal((await call(kv, 'PATCH', `/v1/slots/${D.slotId}`)).status, 405);
  for (const path of ['/', '/v1', '/v1/slots', `/v1/slots/${D.slotId}/extra`, '/v2/health', '/health', '/favicon.ico']) {
    const res = await call(kv, 'GET', path);
    assert.equal(res.status, 404, path);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  }
  const unbound = await worker.fetch(new Request(`${ORIGIN}/v1/slots/${D.slotId}`, { headers: readHeaders() }), {});
  assert.equal(unbound.status, 500);
  // A KV that throws never leaks a stack: 500 JSON.
  const broken = { get() { throw new Error('kv down'); }, put() {}, delete() {} };
  const res = await worker.fetch(new Request(`${ORIGIN}/v1/slots/${D.slotId}`, { headers: readHeaders() }), { SLOTS: broken });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'internal error' });
});

test('end to end: desktop push through the worker, phone-side decrypt reproduces the payload; re-pair moves slots', async () => {
  const kv = kvMock();
  let nowMs = T0;
  let seed = 0;
  let stored = null;
  const settings = { phoneSyncEnabled: true, phoneRelayUrl: `${ORIGIN}/`, warnThreshold: 75, dangerThreshold: 90, timeFormat: '24h' };
  const sync = createPhoneSync({
    getSettings: () => settings,
    loadKey: () => stored,
    saveKey: (k) => { stored = Buffer.from(k); return true; },
    clearKey: () => { stored = null; },
    fetch: (url, init) => worker.fetch(new Request(url, init), { SLOTS: kv }),
    now: () => nowMs,
    log: { info() {}, warn() {}, debug() {} },
    appVersion: '0.2.0', platform: 'win32', hostname: 'AIDAN-PC',
    qr: { toDataURL: async () => 'data:image/png;base64,QR' },
    random: (n) => Buffer.alloc(n, (seed += 1)),
  });
  sync.load();
  await sync.settingsChanged({ phoneSyncEnabled: false }, settings);

  const snapshot = {
    fetchedAt: T0,
    providers: {
      claude: {
        id: 'claude', name: 'Claude', status: 'ok', error: null, source: 'claude_code', plan: 'Max 20x', account: 'aidan@example.com', updatedAt: T0,
        windows: [{ key: 'session', label: 'Current Session', kind: 'session', percent: 42.4, resetsAt: '2026-09-07T13:59:00.000Z', windowSeconds: 18000, severity: 'normal', isActive: false, color: 'purple', scope: null, note: null }],
        extra: { enabled: true, currency: 'USD', exponent: 2, usedMinor: 7519, limitMinor: null, percent: null, balanceMinor: 17500, promoMinor: 0, paidMinor: 17500, nextExpiresAt: null, nextExpiryMinor: null, disabledReason: null },
        credits: null, raw: { five_hour: { utilization: 42.4 }, account: { email: 'aidan@example.com' } },
      },
      codex: null,
    },
  };
  const hist = {
    samples: [{ t: T0 - 60 * 60 * 1000, v: { 'claude.session': 12 } }, { t: T0 - 1000, v: { 'claude.session': 42 } }],
    series: [{ key: 'claude.session', label: 'Claude · Current Session', color: 'purple' }],
  };
  await sync.onSnapshot(snapshot, hist);
  const status = sync.getStatus();
  assert.equal(status.lastError, null);
  assert.equal(status.lastPushAt, T0);
  assert.equal(kv.map.size, 1);

  // Phone side: GET with the read token derived from the pairing string, then decrypt with encKey + slotId as AAD.
  const pairing = await sync.getPairing();
  const { key } = require('../src/main/sync').parsePairString(pairing.pairString);
  const phone = deriveSlot(key);
  assert.equal(phone.slotId, status.slotId);
  const res = await call(kv, 'GET', `/v1/slots/${phone.slotId}`, { headers: { Authorization: `Bearer ${phone.readToken}` } });
  assert.equal(res.status, 200);
  const env = await res.json();
  assert.equal(env.ts, T0);
  const payload = decryptEnvelope(phone.encKey, phone.slotId, env);
  assert.equal(payload.v, 1);
  assert.equal(payload.generatedAt, T0);
  assert.deepEqual(payload.source, { app: 'ai-usage-widget', version: '0.2.0', platform: 'win32', host: 'AIDAN-PC' });
  assert.deepEqual(payload.settings, { warnThreshold: 75, dangerThreshold: 90, timeFormat: '24h', dateFormat: 'date' });
  const expected = JSON.parse(JSON.stringify(snapshot));
  delete expected.providers.claude.raw;
  assert.deepEqual(payload.snapshot, expected);
  assert.deepEqual(payload.history, { days: 7, samples: hist.samples, series: hist.series });
  assert.ok(!JSON.stringify(payload).includes('five_hour'));

  // Re-pair: old slot deleted, new slot filled, old read token useless.
  nowMs += 2 * 60 * 1000;
  const second = await sync.repair();
  await sync.pending(); // the first fill of the new slot runs through the worker asynchronously
  assert.notEqual(second.slotId, phone.slotId);
  assert.equal((await call(kv, 'GET', `/v1/slots/${phone.slotId}`, { headers: { Authorization: `Bearer ${phone.readToken}` } })).status, 404);
  const fresh = deriveSlot(stored);
  const res2 = await call(kv, 'GET', `/v1/slots/${fresh.slotId}`, { headers: { Authorization: `Bearer ${fresh.readToken}` } });
  assert.equal(res2.status, 200);
  assert.equal(decryptEnvelope(fresh.encKey, fresh.slotId, await res2.json()).snapshot.providers.claude.windows[0].percent, 42.4);

  // Unpair empties the relay.
  nowMs += 2 * 60 * 1000;
  await sync.unpair();
  assert.equal(kv.map.size, 0);
});
