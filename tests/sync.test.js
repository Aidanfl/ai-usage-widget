'use strict';
// Phone sync (docs/PHONE-SYNC.md): derivations against pinned vectors, pair string, envelope crypto,
// payload building, the push policy and the createPhoneSync state machine with injected deps.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const sync = require('../src/main/sync');

const {
  createPhoneSync, deriveSlot, buildPairString, parsePairString, encryptPayload, decryptEnvelope,
  buildPhonePayload, downsampleHistory, validateRelayUrl, shouldPush, fingerprint,
  PUSH_INTERVAL_MS, PUSH_FLOOR_MS, BACKOFF_MIN_MS, BACKOFF_MAX_MS, HISTORY_BUCKET_MS, HISTORY_MAX_SAMPLES,
} = sync;

const MIN = 60 * 1000;
const T0 = 1_788_700_000_000;
const RELAY = 'https://aiusage-relay.example.workers.dev';

// K = bytes 0x00..0x1f. Vectors computed once with plain `crypto` (see docs/PHONE-SYNC.md derivation table).
const K = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const VECTORS = {
  kBase64url: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  slotId: 'c99b38a1696fd53885c484414e63a948',
  writeToken: 'a9174ba9391aeddf8573c8a9deae43fa9c4d171c3136833eff2addf34c41074b',
  readToken: '574947b680f8e3092f52be6a6018d6cf436b808499c3d50307fc836d01c23064',
  encKeyHex: 'acb2fcaa84e0cd2181c508e9077b0bc95f9b3b0200e38a9eaff20de983d64a99',
};

function win(key, percent, extra = {}) {
  return {
    key, label: extra.label || key, kind: extra.kind || 'other', percent,
    resetsAt: extra.resetsAt === undefined ? '2026-09-07T13:59:00.000Z' : extra.resetsAt,
    windowSeconds: extra.windowSeconds === undefined ? null : extra.windowSeconds,
    severity: null, isActive: null, color: extra.color || 'slate', scope: null, note: null,
  };
}

function provider(id, windows, overrides = {}) {
  return {
    id, name: id === 'claude' ? 'Claude' : 'Codex', status: 'ok', error: null,
    source: id === 'claude' ? 'claude_code' : 'codex_auth_file', plan: 'Pro', account: 'a@example.com', updatedAt: T0,
    windows, extra: null, credits: null, raw: { secret: 'never-shipped', token: 'sk-xyz' },
    ...overrides,
  };
}

function snapshot(claude, codex, fetchedAt = T0) {
  return { fetchedAt, providers: { claude, codex } };
}

const baseSnapshot = () => snapshot(
  provider('claude', [win('session', 20.2, { color: 'purple' }), win('weekly', 22, { color: 'blue' })], { extra: { enabled: true, percent: 37.6 } }),
  provider('codex', [win('secondary', 99, { color: 'teal' })]),
);

function history(samples = [], series = [{ key: 'claude.session', label: 'Claude · Current Session', color: 'purple' }]) {
  return { samples, series };
}

// ---------------------------------------------------------------------------------------------
// Derivations / pairing string / relay URL
// ---------------------------------------------------------------------------------------------
test('deriveSlot matches the pinned SHA-256 vectors and shapes', () => {
  const d = deriveSlot(K);
  assert.equal(d.slotId, VECTORS.slotId);
  assert.equal(d.writeToken, VECTORS.writeToken);
  assert.equal(d.readToken, VECTORS.readToken);
  assert.equal(d.encKey.toString('hex'), VECTORS.encKeyHex);
  assert.match(d.slotId, /^[0-9a-f]{32}$/);
  assert.match(d.writeToken, /^[0-9a-f]{64}$/);
  assert.equal(d.encKey.length, 32);
  // Uint8Array input is accepted; wrong lengths are not.
  assert.equal(deriveSlot(new Uint8Array(K)).slotId, VECTORS.slotId);
  assert.throws(() => deriveSlot(Buffer.alloc(31)), TypeError);
  assert.throws(() => deriveSlot('not bytes'), TypeError);
});

test('validateRelayUrl normalizes good URLs and rejects everything else', () => {
  assert.equal(validateRelayUrl(RELAY), RELAY);
  assert.equal(validateRelayUrl(`  ${RELAY}/  `), RELAY, 'trimmed, trailing slash stripped');
  assert.equal(validateRelayUrl(`${RELAY}/relay///`), `${RELAY}/relay`, 'path kept, trailing slashes stripped');
  assert.equal(validateRelayUrl('HTTPS://Relay.Example.COM'), 'https://relay.example.com');
  assert.equal(validateRelayUrl('http://localhost:8787'), 'http://localhost:8787');
  assert.equal(validateRelayUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
  assert.equal(validateRelayUrl('http://relay.example.com'), null, 'plain http only for localhost');
  assert.equal(validateRelayUrl('ftp://relay.example.com'), null);
  assert.equal(validateRelayUrl(`${RELAY}?x=1`), null, 'no query');
  assert.equal(validateRelayUrl(`${RELAY}#frag`), null, 'no fragment');
  assert.equal(validateRelayUrl('https://user:pw@relay.example.com'), null, 'no credentials');
  assert.equal(validateRelayUrl('relay.example.com'), null, 'scheme required');
  assert.equal(validateRelayUrl(''), null);
  assert.equal(validateRelayUrl(null), null);
  assert.equal(validateRelayUrl(42), null);
  assert.equal(validateRelayUrl(`https://a.example/${'x'.repeat(520)}`), null, '> 512 chars');
});

test('buildPairString / parsePairString round trip', () => {
  const pair = buildPairString(`${RELAY}/`, K);
  assert.equal(pair, `aiusage://pair?v=1&r=${encodeURIComponent(RELAY)}&k=${VECTORS.kBase64url}`);
  assert.equal(pair.split('k=')[1].length, 43, '43 chars of key, no padding');
  const parsed = parsePairString(pair);
  assert.equal(parsed.relayUrl, RELAY);
  assert.ok(Buffer.isBuffer(parsed.key));
  assert.equal(parsed.key.toString('hex'), K.toString('hex'));
  assert.deepEqual(parsePairString(`  ${pair}\n`), parsed, 'surrounding whitespace tolerated');
  // Parameter order does not matter; a localhost relay is accepted.
  assert.equal(parsePairString(`aiusage://pair?k=${VECTORS.kBase64url}&r=http%3A%2F%2Flocalhost%3A8787%2F&v=1`).relayUrl, 'http://localhost:8787');
  assert.throws(() => buildPairString('http://relay.example.com', K), TypeError);
  assert.throws(() => buildPairString(RELAY, Buffer.alloc(16)), TypeError);
});

test('parsePairString rejects malformed strings', () => {
  const good = buildPairString(RELAY, K);
  const bad = [
    good.replace('v=1', 'v=2'),
    good.replace('aiusage://', 'https://'),
    good.replace('pair?', 'pairing?'),
    good.replace('aiusage://pair?', 'aiusage://pair/extra?'),
    good.replace(/k=.*/, 'k=' + Buffer.alloc(31, 1).toString('base64url')),      // 31 bytes
    good.replace(/k=.*/, 'k=' + Buffer.alloc(33, 1).toString('base64url')),      // 33 bytes
    good.replace(/k=.*/, 'k=' + K.toString('base64')),                           // std base64 with padding
    good.replace(/k=.*/, 'k=' + VECTORS.kBase64url + '='),                       // padding
    good.replace(/k=.*/, 'k=' + VECTORS.kBase64url.slice(0, -1) + '!'),          // bad char
    good.replace(/&k=.*/, ''),                                                   // no key
    good.replace(/r=[^&]*/, 'r=http%3A%2F%2Frelay.example.com'),                // http non-local
    good.replace(/r=[^&]*/, 'r=' + encodeURIComponent(RELAY + '?x=1')),          // query in relay
    good.replace(/r=[^&]*/, 'r='),                                               // empty relay
    good.replace(/&r=[^&]*/, ''),                                                // no relay
    good + '#x',
    '',
    'aiusage://pair',
    null,
    undefined,
    { pair: good },
  ];
  for (const s of bad) assert.equal(parsePairString(s), null, `should reject: ${String(s).slice(0, 80)}`);
});

// ---------------------------------------------------------------------------------------------
// Envelope crypto
// ---------------------------------------------------------------------------------------------
test('encryptPayload → envelope (ciphertext || tag, AAD = slotId) and decryptEnvelope round trips', () => {
  const { encKey, slotId } = deriveSlot(K);
  const payload = { v: 1, generatedAt: T0, hello: 'wörld', nested: { a: [1, 2, 3] } };
  const iv = Buffer.alloc(12, 7);
  const env = encryptPayload(encKey, slotId, payload, { iv });
  assert.deepEqual(Object.keys(env).sort(), ['ct', 'iv', 'ts', 'v']);
  assert.equal(env.v, 1);
  assert.equal(env.iv, iv.toString('base64'));
  assert.equal(env.ts, T0, 'ts defaults to payload.generatedAt');
  const ct = Buffer.from(env.ct, 'base64');
  assert.equal(ct.length, Buffer.byteLength(JSON.stringify(payload), 'utf8') + 16, 'ciphertext || 16-byte tag');
  assert.deepEqual(decryptEnvelope(encKey, slotId, env), payload);

  // Deterministic for a fixed IV (pinned so the Swift side can be checked against the same vector).
  const env2 = encryptPayload(encKey, slotId, { a: 1, generatedAt: 5 }, { iv });
  assert.equal(env2.ct, 'TpS2axsbnBrhHp2xvrXcY8r0DFZFjjc2rxE3q5OlYdWpEZD2rNnh');
  assert.equal(env2.ts, 5);

  // Independent WebCrypto decrypt agrees (what the phone effectively does).
  return crypto.webcrypto.subtle.importKey('raw', encKey, 'AES-GCM', false, ['decrypt']).then(async (key) => {
    const plain = await crypto.webcrypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from(slotId, 'ascii') }, key, ct);
    assert.deepEqual(JSON.parse(Buffer.from(plain).toString('utf8')), payload);
  });
});

test('decryptEnvelope fails on AAD mismatch, tampering, wrong key and malformed envelopes', () => {
  const { encKey, slotId } = deriveSlot(K);
  const other = deriveSlot(Buffer.alloc(32, 9));
  const env = encryptPayload(encKey, slotId, { v: 1, generatedAt: T0 });
  assert.throws(() => decryptEnvelope(encKey, other.slotId, env), 'a blob is bound to its slot (AAD)');
  assert.throws(() => decryptEnvelope(other.encKey, slotId, env), 'wrong key');
  const tampered = Buffer.from(env.ct, 'base64');
  tampered[0] ^= 0x01;
  assert.throws(() => decryptEnvelope(encKey, slotId, { ...env, ct: tampered.toString('base64') }), 'tampered ciphertext');
  const badTag = Buffer.from(env.ct, 'base64');
  badTag[badTag.length - 1] ^= 0x80;
  assert.throws(() => decryptEnvelope(encKey, slotId, { ...env, ct: badTag.toString('base64') }), 'tampered tag');
  assert.throws(() => decryptEnvelope(encKey, slotId, { ...env, iv: Buffer.alloc(11).toString('base64') }), TypeError);
  assert.throws(() => decryptEnvelope(encKey, slotId, { ...env, v: 2 }), TypeError);
  assert.throws(() => decryptEnvelope(encKey, slotId, { ...env, ts: 'now' }), TypeError);
  assert.throws(() => decryptEnvelope(encKey, slotId, null), TypeError);
  assert.throws(() => encryptPayload(encKey, 'not-a-slot', {}), TypeError);
  assert.throws(() => encryptPayload(encKey, slotId, {}, { iv: Buffer.alloc(16) }), TypeError);
  assert.ok(sync.isValidEnvelope(env));
  assert.equal(sync.isValidEnvelope({ ...env, ct: 'AAAA' }), false, 'ct shorter than a tag');
});

// ---------------------------------------------------------------------------------------------
// PhonePayload
// ---------------------------------------------------------------------------------------------
test('buildPhonePayload strips raw from every provider and copies the rest', () => {
  const snap = baseSnapshot();
  snap.providers.codex = null; // disabled provider stays null
  const payload = buildPhonePayload({
    snapshot: snap, history: history(), settings: { warnThreshold: 70, dangerThreshold: 95, timeFormat: '24h', autoStart: true },
    appVersion: '0.2.0', platform: 'win32', hostname: 'AIDAN-PC', now: T0 + 5,
  });
  assert.equal(payload.v, 1);
  assert.equal(payload.generatedAt, T0 + 5);
  assert.deepEqual(payload.source, { app: 'ai-usage-widget', version: '0.2.0', platform: 'win32', host: 'AIDAN-PC' });
  assert.deepEqual(payload.settings, { warnThreshold: 70, dangerThreshold: 95, timeFormat: '24h' }, 'only the three keys the phone needs');
  assert.equal(payload.snapshot.fetchedAt, T0);
  assert.equal(payload.snapshot.providers.codex, null);
  const claude = payload.snapshot.providers.claude;
  assert.ok(!('raw' in claude), 'raw removed');
  assert.ok('raw' in snap.providers.claude, 'input snapshot not mutated');
  assert.equal(claude.status, 'ok');
  assert.equal(claude.plan, 'Pro');
  assert.equal(claude.account, 'a@example.com');
  assert.deepEqual(claude.extra, { enabled: true, percent: 37.6 });
  assert.equal(claude.windows.length, 2);
  assert.equal(claude.windows[0].percent, 20.2);
  assert.ok(!JSON.stringify(payload).includes('never-shipped'));
  assert.deepEqual(payload.history, { days: 7, samples: [], series: [{ key: 'claude.session', label: 'Claude · Current Session', color: 'purple' }] });
  // Missing / odd inputs never throw.
  const empty = buildPhonePayload({ snapshot: null, history: null, settings: {}, now: T0 });
  assert.deepEqual(empty.history, { days: 7, samples: [], series: [] });
  assert.deepEqual(empty.settings, { warnThreshold: 75, dangerThreshold: 90, timeFormat: '12h' });
});

test('history downsampling: 30-min buckets keep the LAST sample, newest 400 kept, series trimmed', () => {
  // 2-minute cadence over 3 h → one survivor per 30-min bucket, the latest of each bucket.
  const samples = [];
  for (let t = T0 - 3 * 60 * MIN; t <= T0; t += 2 * MIN) samples.push({ t, v: { 'claude.session': (t / MIN) % 100 } });
  const out = downsampleHistory(samples);
  const buckets = new Set(out.map((s) => Math.floor(s.t / HISTORY_BUCKET_MS)));
  assert.equal(buckets.size, out.length, 'one sample per bucket');
  for (const s of out) {
    const inBucket = samples.filter((x) => Math.floor(x.t / HISTORY_BUCKET_MS) === Math.floor(s.t / HISTORY_BUCKET_MS));
    assert.equal(s.t, Math.max(...inBucket.map((x) => x.t)), 'the last sample of the bucket survives');
  }
  assert.equal(out[out.length - 1].t, T0, 'the newest sample is always kept');
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t > out[i - 1].t, 'sorted ascending');

  // Same bucket, unsorted input → last-by-time wins, values are copied.
  const bucketStart = Math.floor(T0 / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;
  const two = downsampleHistory([{ t: bucketStart + 10 * MIN, v: { a: 2 } }, { t: bucketStart + MIN, v: { a: 1 } }]);
  assert.deepEqual(two, [{ t: bucketStart + 10 * MIN, v: { a: 2 } }]);

  // Cap: 500 buckets → 400 newest.
  const many = Array.from({ length: 500 }, (_, i) => ({ t: T0 - (499 - i) * HISTORY_BUCKET_MS, v: { a: i } }));
  const capped = downsampleHistory(many);
  assert.equal(capped.length, HISTORY_MAX_SAMPLES);
  assert.equal(capped[0].v.a, 100, 'oldest dropped');
  assert.equal(capped[capped.length - 1].v.a, 499);

  // Junk is ignored.
  assert.deepEqual(downsampleHistory([null, { t: 'x', v: {} }, { t: T0, v: null }, 5]), []);
  assert.deepEqual(downsampleHistory('nope'), []);

  const payload = buildPhonePayload({
    snapshot: baseSnapshot(), now: T0,
    history: history(many, [{ key: 'claude.session', label: 'L', color: 'purple', extra: 'dropped' }, { key: 7 }, null, { key: 'codex.primary' }]),
  });
  assert.equal(payload.history.samples.length, HISTORY_MAX_SAMPLES);
  assert.deepEqual(payload.history.series, [
    { key: 'claude.session', label: 'L', color: 'purple' },
    { key: 'codex.primary', label: 'codex.primary', color: 'slate' },
  ]);
});

// ---------------------------------------------------------------------------------------------
// Push policy (pure)
// ---------------------------------------------------------------------------------------------
test('fingerprint tracks status, integer percents, resetsAt and extra.percent only', () => {
  const a = baseSnapshot();
  const same = baseSnapshot();
  same.providers.claude.windows[0].percent = 20.4;          // rounds to 20 like 20.2
  same.providers.claude.updatedAt = T0 + 1000;              // ignored
  same.providers.claude.raw = { different: true };          // ignored
  same.fetchedAt = T0 + 1000;                               // ignored
  assert.equal(fingerprint(a), fingerprint(same));

  const pct = baseSnapshot(); pct.providers.claude.windows[0].percent = 20.6;   // → 21
  const reset = baseSnapshot(); reset.providers.codex.windows[0].resetsAt = '2026-09-08T00:00:00.000Z';
  const status = baseSnapshot(); status.providers.codex.status = 'stale';
  const extra = baseSnapshot(); extra.providers.claude.extra.percent = 39;
  const off = baseSnapshot(); off.providers.codex = null;
  for (const changed of [pct, reset, status, extra, off]) assert.notEqual(fingerprint(a), fingerprint(changed));
});

test('shouldPush: first fill, 5-min cadence, change detection, 60 s floor, backoff, forced', () => {
  const prev = baseSnapshot();
  const changed = baseSnapshot();
  changed.providers.claude.windows[0].percent = 55;
  const base = { lastPushAt: null, lastAttemptAt: null, nextRetryAt: null, forced: false };

  assert.equal(shouldPush(null, prev, T0, base), 'first');
  assert.equal(shouldPush(null, prev, T0, { ...base, lastAttemptAt: T0 - PUSH_FLOOR_MS + 1 }), false, 'floor blocks the first fill too');
  assert.equal(shouldPush(null, prev, T0, { ...base, lastAttemptAt: T0 - PUSH_FLOOR_MS }), 'first', 'exactly 60 s is allowed');
  assert.equal(shouldPush(null, prev, T0, { ...base, nextRetryAt: T0 + 1 }), false, 'backing off');
  assert.equal(shouldPush(null, prev, T0, { ...base, nextRetryAt: T0 }), 'first', 'retry time reached');

  const pushed = { ...base, lastPushAt: T0, lastAttemptAt: T0 };
  assert.equal(shouldPush(prev, prev, T0 + 2 * MIN, pushed), false, 'no change, inside 5 min');
  assert.equal(shouldPush(prev, changed, T0 + 2 * MIN, pushed), 'change');
  assert.equal(shouldPush(prev, changed, T0 + 30 * 1000, pushed), false, 'change inside the 60 s floor waits');
  assert.equal(shouldPush(prev, prev, T0 + PUSH_INTERVAL_MS, pushed), 'interval');
  assert.equal(shouldPush(prev, prev, T0 + PUSH_INTERVAL_MS - 1, pushed), false);
  assert.equal(shouldPush(prev, prev, T0 + 2 * MIN, { ...pushed, forced: true }), 'forced');
  assert.equal(shouldPush(prev, prev, T0 + 2 * MIN, { ...pushed, forced: true, nextRetryAt: T0 + 10 * MIN }), 'forced', 'forced ignores the backoff');
  assert.equal(shouldPush(prev, prev, T0 + 30 * 1000, { ...pushed, forced: true }), false, 'but not the floor');
  assert.equal(shouldPush(prev, changed, T0 + 2 * MIN, { ...pushed, nextRetryAt: T0 + 10 * MIN }), false, 'change waits for the backoff');
  assert.equal(shouldPush(prev, null, T0 + 2 * MIN, pushed), false, 'nothing to push');
});

// ---------------------------------------------------------------------------------------------
// createPhoneSync
// ---------------------------------------------------------------------------------------------
function harness({ settings, respond, saveKeyResult = true, storedKey = null, requestTimeoutMs } = {}) {
  const st = settings || { phoneSyncEnabled: true, phoneRelayUrl: RELAY, warnThreshold: 75, dangerThreshold: 90, timeFormat: '12h' };
  let nowMs = T0;
  let stored = storedKey;
  let saves = 0;
  let clears = 0;
  let seed = 0;
  const logs = { info: [], warn: [], debug: [] };
  const calls = [];
  const statuses = [];
  const instance = createPhoneSync({
    getSettings: () => st,
    loadKey: () => stored,
    saveKey: (k) => { saves += 1; stored = Buffer.from(k); return saveKeyResult; },
    clearKey: () => { clears += 1; stored = null; },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init || {} });
      if (respond) return respond(String(url), init || {}, calls.length);
      return new Response(null, { status: 204 });
    },
    now: () => nowMs,
    log: { info: (...a) => logs.info.push(a.join(' ')), warn: (...a) => logs.warn.push(a.join(' ')), debug: (...a) => logs.debug.push(a.join(' ')) },
    appVersion: '0.2.0',
    platform: 'win32',
    hostname: 'AIDAN-PC',
    qr: { toDataURL: async (text, opts) => `data:image/png;base64,QR(${opts.width},${opts.margin}):${text.length}` },
    random: (n) => Buffer.alloc(n, (seed += 1)),
    requestTimeoutMs,
  });
  instance.onStatus((s) => statuses.push(s));
  return {
    sync: instance, settings: st, calls, logs, statuses,
    advance: (ms) => { nowMs += ms; },
    get now() { return nowMs; },
    get stored() { return stored; },
    get saves() { return saves; },
    get clears() { return clears; },
    put: () => calls.filter((c) => c.init.method === 'PUT'),
  };
}

test('status has exactly the documented shape before and after pairing', async () => {
  const h = harness();
  const before = h.sync.load();
  assert.deepEqual(Object.keys(before).sort(), ['enabled', 'keyPersisted', 'lastError', 'lastPushAt', 'nextRetryAt', 'paired', 'relayUrl', 'slotId']);
  assert.deepEqual(before, { enabled: true, relayUrl: RELAY, paired: false, keyPersisted: false, lastPushAt: null, lastError: null, nextRetryAt: null, slotId: null });
  await h.sync.getPairing();
  const after = h.sync.getStatus();
  assert.equal(after.paired, true);
  assert.equal(after.keyPersisted, true);
  assert.match(after.slotId, /^[0-9a-f]{32}$/);
  assert.equal(after.lastPushAt, null);
  assert.equal(h.statuses.length >= 2, true, 'onStatus fired');
});

test('load() restores a persisted key; a memory-only key reports keyPersisted false', async () => {
  const h = harness({ storedKey: K });
  h.sync.load();
  assert.deepEqual(h.sync.getStatus().slotId, VECTORS.slotId);
  assert.equal(h.sync.getStatus().keyPersisted, true);

  const mem = harness({ saveKeyResult: false });
  await mem.sync.getPairing();
  assert.equal(mem.sync.getStatus().paired, true);
  assert.equal(mem.sync.getStatus().keyPersisted, false);
  assert.ok(mem.logs.warn.some((l) => /memory only/.test(l)));
});

test('getPairing creates K once (never rotates), renders the QR via the injected renderer, needs a relay URL', async () => {
  const h = harness();
  const p1 = await h.sync.getPairing();
  assert.equal(p1.error, null);
  assert.equal(h.saves, 1);
  const parsed = parsePairString(p1.pairString);
  assert.equal(parsed.relayUrl, RELAY);
  assert.equal(parsed.key.toString('hex'), h.stored.toString('hex'));
  assert.equal(p1.slotId, deriveSlot(h.stored).slotId);
  assert.equal(p1.qrDataUrl, `data:image/png;base64,QR(220,1):${p1.pairString.length}`, 'toDataURL called with width 220, margin 1');

  const p2 = await h.sync.getPairing();
  assert.equal(p2.slotId, p1.slotId, 'existing key kept');
  assert.equal(p2.pairString, p1.pairString);
  assert.equal(h.saves, 1, 'not re-saved');

  const noRelay = harness({ settings: { phoneSyncEnabled: false, phoneRelayUrl: '' } });
  const p3 = await noRelay.sync.getPairing();
  assert.equal(p3.pairString, null);
  assert.equal(p3.qrDataUrl, null);
  assert.match(p3.slotId, /^[0-9a-f]{32}$/, 'key is still created');
  assert.match(p3.error, /relay URL/i);
});

test('settingsChanged: turning sync on with no key generates one; a relay change resets state and re-fills', async () => {
  const h = harness({ settings: { phoneSyncEnabled: false, phoneRelayUrl: RELAY } });
  h.sync.load();
  assert.equal(h.sync.getStatus().paired, false);
  h.settings.phoneSyncEnabled = true;
  await h.sync.settingsChanged({ phoneSyncEnabled: false, phoneRelayUrl: RELAY }, h.settings);
  assert.equal(h.sync.getStatus().paired, true);
  assert.equal(h.saves, 1);
  assert.equal(h.calls.length, 0, 'no snapshot yet → nothing to push');

  await h.sync.onSnapshot(baseSnapshot(), history());
  assert.equal(h.put().length, 1, 'first fill');
  assert.equal(h.sync.getStatus().lastPushAt, T0);

  h.advance(2 * MIN);
  await h.sync.onSnapshot(baseSnapshot(), history());
  assert.equal(h.put().length, 1, 'unchanged inside 5 min → no push');

  const prevSettings = { ...h.settings };
  h.settings.phoneRelayUrl = 'https://other.example.workers.dev';
  await h.sync.settingsChanged(prevSettings, h.settings);
  assert.equal(h.put().length, 2, 'new relay is filled right away');
  assert.ok(h.put()[1].url.startsWith('https://other.example.workers.dev/v1/slots/'));
  assert.equal(h.sync.getStatus().relayUrl, 'https://other.example.workers.dev');
});

test('onSnapshot applies the push policy: first fill, floor, change, 5-min interval; history getter is lazy', async () => {
  const h = harness();
  h.sync.load();
  await h.sync.settingsChanged({ phoneSyncEnabled: false }, h.settings); // generates K, forced
  const { slotId, writeToken, readToken, encKey } = deriveSlot(h.stored);
  let historyReads = 0;
  const lazyHistory = () => { historyReads += 1; return history([{ t: T0 - MIN, v: { 'claude.session': 20 } }]); };

  await h.sync.onSnapshot(baseSnapshot(), lazyHistory);
  assert.equal(h.put().length, 1);
  assert.equal(historyReads, 1);
  const req = h.put()[0];
  assert.equal(req.url, `${RELAY}/v1/slots/${slotId}`);
  assert.equal(req.init.headers.Authorization, `Bearer ${writeToken}`);
  assert.equal(req.init.headers['X-Read-Token'], readToken);
  assert.equal(req.init.headers['Content-Type'], 'application/json');
  assert.ok(req.init.signal instanceof AbortSignal, 'timeout signal attached');
  const envelope = JSON.parse(req.init.body);
  assert.equal(envelope.ts, T0);
  const payload = decryptEnvelope(encKey, slotId, envelope);
  assert.equal(payload.generatedAt, T0);
  assert.equal(payload.source.host, 'AIDAN-PC');
  assert.ok(!('raw' in payload.snapshot.providers.claude));
  assert.equal(payload.history.samples.length, 1);
  assert.deepEqual(payload.settings, { warnThreshold: 75, dangerThreshold: 90, timeFormat: '12h' });

  // 30 s later with a change: floor.
  h.advance(30 * 1000);
  const changed = baseSnapshot();
  changed.providers.claude.windows[0].percent = 41;
  await h.sync.onSnapshot(changed, lazyHistory);
  assert.equal(h.put().length, 1, '60 s floor');
  assert.equal(historyReads, 1, 'history not read when nothing is pushed');

  // 60 s later, no change vs the pushed snapshot: nothing.
  h.advance(30 * 1000);
  await h.sync.onSnapshot(baseSnapshot(), lazyHistory);
  assert.equal(h.put().length, 1);

  // A sub-integer change is not a change.
  const tiny = baseSnapshot();
  tiny.providers.claude.windows[0].percent = 20.4;
  await h.sync.onSnapshot(tiny, lazyHistory);
  assert.equal(h.put().length, 1);

  // A real change is.
  await h.sync.onSnapshot(changed, lazyHistory);
  assert.equal(h.put().length, 2, 'change detected');
  assert.equal(h.sync.getStatus().lastPushAt, T0 + MIN);

  // Then nothing for < 5 min, and an interval push at 5 min even without change.
  h.advance(PUSH_INTERVAL_MS - 1);
  await h.sync.onSnapshot(changed, lazyHistory);
  assert.equal(h.put().length, 2);
  h.advance(1);
  await h.sync.onSnapshot(changed, lazyHistory);
  assert.equal(h.put().length, 3, '5-min cadence');

  // resetsAt change counts.
  h.advance(2 * MIN);
  const reset = JSON.parse(JSON.stringify(changed));
  reset.providers.codex.windows[0].resetsAt = '2026-09-09T00:00:00.000Z';
  await h.sync.onSnapshot(reset, lazyHistory);
  assert.equal(h.put().length, 4);
  assert.equal(historyReads, 4, 'history read once per push');

  // Disabled → no pushes at all.
  h.settings.phoneSyncEnabled = false;
  h.advance(10 * MIN);
  await h.sync.onSnapshot(baseSnapshot(), lazyHistory);
  assert.equal(h.put().length, 4);
});

test('failures back off 1 → 2 → 4 → … → 30 min, are logged once, and a success resets the backoff', async () => {
  let failing = true;
  const h = harness({ respond: () => (failing ? new Response('nope', { status: 500 }) : new Response(null, { status: 204 })) });
  h.sync.load();
  await h.sync.settingsChanged({ phoneSyncEnabled: false }, h.settings);
  const attempt = async () => { await h.sync.onSnapshot(baseSnapshot(), history()); return h.put().length; };

  assert.equal(await attempt(), 1);
  let st = h.sync.getStatus();
  assert.equal(st.lastError, 'HTTP 500');
  assert.equal(st.nextRetryAt, T0 + BACKOFF_MIN_MS);
  assert.equal(st.lastPushAt, null);
  assert.equal(h.logs.warn.length, 1, 'logged once');

  const expected = [1, 2, 4, 8, 16, 30, 30, 30]; // minutes
  let attempts = 1;
  for (let i = 0; i < expected.length; i++) {
    const retryAt = h.sync.getStatus().nextRetryAt;
    assert.equal(retryAt, h.now + expected[i] * MIN, `backoff step ${i} = ${expected[i]} min`);
    // Inside the backoff: nothing happens (also past the 60 s floor).
    h.advance(Math.min(expected[i] * MIN - 1, 90 * 1000));
    assert.equal(await attempt(), attempts, 'no attempt while backing off');
    h.advance(retryAt - h.now);
    attempts += 1;
    assert.equal(await attempt(), attempts, 'retried once the backoff elapsed');
  }
  assert.equal(h.logs.warn.length, 1, 'further failures only at debug level');
  assert.ok(h.logs.debug.length >= expected.length);

  failing = false;
  h.advance(BACKOFF_MAX_MS);
  await attempt();
  st = h.sync.getStatus();
  assert.equal(st.lastError, null);
  assert.equal(st.nextRetryAt, null);
  assert.equal(st.lastPushAt, h.now);

  // A later failure starts again at 1 min and is logged again (once).
  failing = true;
  h.advance(PUSH_INTERVAL_MS);
  await attempt();
  assert.equal(h.sync.getStatus().nextRetryAt, h.now + BACKOFF_MIN_MS);
  assert.equal(h.logs.warn.length, 2);
});

test('network errors and timeouts become lastError with a readable message', async () => {
  const h = harness({ respond: () => { throw new TypeError('fetch failed'); } });
  h.sync.load();
  await h.sync.settingsChanged({ phoneSyncEnabled: false }, h.settings);
  await h.sync.onSnapshot(baseSnapshot(), history());
  assert.equal(h.sync.getStatus().lastError, 'fetch failed');

  const slow = harness({
    requestTimeoutMs: 20,
    respond: (_url, init) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(init.signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' }))); }),
  });
  slow.sync.load();
  await slow.sync.settingsChanged({ phoneSyncEnabled: false }, slow.settings);
  await slow.sync.onSnapshot(baseSnapshot(), history());
  assert.match(slow.sync.getStatus().lastError, /^Timed out/);
});

test('repair rotates K (old slot deleted best-effort) and unpair forgets everything', async () => {
  const h = harness();
  h.sync.load();
  const first = await h.sync.getPairing();
  const oldDerived = deriveSlot(h.stored);
  await h.sync.onSnapshot(baseSnapshot(), history());
  assert.equal(h.sync.getStatus().lastPushAt, T0);

  h.advance(2 * MIN);
  const second = await h.sync.repair();
  assert.notEqual(second.slotId, first.slotId);
  assert.notEqual(second.pairString, first.pairString);
  assert.equal(h.saves, 2);
  const del = h.calls.find((c) => c.init.method === 'DELETE');
  assert.ok(del, 'old slot deleted');
  assert.equal(del.url, `${RELAY}/v1/slots/${oldDerived.slotId}`);
  assert.equal(del.init.headers.Authorization, `Bearer ${oldDerived.writeToken}`);
  assert.equal(h.put().length, 2, 'first fill of the new slot');
  assert.ok(h.put()[1].url.endsWith(second.slotId));
  assert.equal(h.sync.getStatus().slotId, second.slotId);

  h.advance(2 * MIN);
  assert.equal(await h.sync.unpair(), true);
  assert.equal(h.clears, 1);
  assert.equal(h.stored, null);
  const deletes = h.calls.filter((c) => c.init.method === 'DELETE');
  assert.equal(deletes.length, 2);
  assert.ok(deletes[1].url.endsWith(second.slotId));
  const st = h.sync.getStatus();
  assert.equal(st.paired, false);
  assert.equal(st.slotId, null);
  assert.equal(st.lastPushAt, null);
  await h.sync.onSnapshot(baseSnapshot(), history());
  assert.equal(h.put().length, 2, 'no pushes without a key');
  // A relay that refuses the delete does not block unpairing.
  const stubborn = harness({ respond: () => { throw new Error('offline'); } });
  await stubborn.sync.getPairing();
  assert.equal(await stubborn.sync.unpair(), true);
  assert.equal(stubborn.sync.getStatus().paired, false);
});

test('test() probes /v1/health on the given or saved relay URL', async () => {
  const h = harness({
    respond: (url) => {
      if (url === `${RELAY}/v1/health`) return new Response(JSON.stringify({ ok: true, v: 1 }), { status: 200 });
      if (url.startsWith('https://down.example')) return new Response('', { status: 503 });
      if (url.startsWith('https://notarelay.example')) return new Response('<html>', { status: 200 });
      throw new TypeError('fetch failed');
    },
  });
  const ok = await h.sync.test();
  assert.deepEqual(ok, { ok: true, status: 200, latencyMs: 0 });
  assert.equal(h.calls[0].init.method, 'GET');
  const down = await h.sync.test('https://down.example');
  assert.equal(down.ok, false);
  assert.equal(down.status, 503);
  assert.match(down.error, /503/);
  const notRelay = await h.sync.test('https://notarelay.example/');
  assert.equal(notRelay.ok, false);
  assert.match(notRelay.error, /Not a relay/);
  const offline = await h.sync.test('https://gone.example');
  assert.deepEqual(offline, { ok: false, latencyMs: 0, error: 'fetch failed' });
  const invalid = await h.sync.test('http://relay.example.com');
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /https/);
  const trailing = await h.sync.test(`${RELAY}/`);
  assert.equal(trailing.ok, true, 'normalized before probing');
});

test('pushNow pushes immediately, honours the 60 s floor and explains why it cannot', async () => {
  const h = harness();
  h.sync.load();
  assert.deepEqual(await h.sync.pushNow(), { ok: false, error: 'Not paired' });
  await h.sync.getPairing();
  assert.deepEqual(await h.sync.pushNow(), { ok: false, error: 'No usage data yet' });
  await h.sync.onSnapshot(baseSnapshot(), history());   // forced first fill
  assert.equal(h.put().length, 1);
  const tooSoon = await h.sync.pushNow();
  assert.equal(tooSoon.ok, false);
  assert.match(tooSoon.error, /Wait 60 s/);
  h.advance(PUSH_FLOOR_MS);
  assert.deepEqual(await h.sync.pushNow(), { ok: true });
  assert.equal(h.put().length, 2);
  h.settings.phoneSyncEnabled = false;
  h.advance(PUSH_FLOOR_MS);
  assert.deepEqual(await h.sync.pushNow(), { ok: false, error: 'Phone sync is turned off' });
});

test('never logs the key, the tokens, the encryption key or the payload', async () => {
  const h = harness({ respond: () => new Response('', { status: 500 }) });
  h.sync.load();
  await h.sync.getPairing();
  await h.sync.onSnapshot(baseSnapshot(), history());
  await h.sync.repair();
  const { writeToken, readToken, encKey } = deriveSlot(h.stored);
  const everything = [...h.logs.info, ...h.logs.warn, ...h.logs.debug].join('\n');
  for (const secret of [h.stored.toString('hex'), h.stored.toString('base64'), sync.base64url(h.stored), writeToken, readToken, encKey.toString('hex'), 'never-shipped', 'a@example.com']) {
    assert.ok(!everything.includes(secret), `log leaked ${secret.slice(0, 12)}…`);
  }
  assert.ok(everything.length > 0);
});
