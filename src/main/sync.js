'use strict';
// Phone sync (docs/PHONE-SYNC.md, ARCHITECTURE.md §14). Pure-ish: no `require('electron')` — the pair-key
// persistence (safeStorage), fetch, clock, logger and QR renderer are injected so `node --test` can drive
// everything, including an end-to-end run against the relay worker with an in-memory KV.
//
// Wire format recap: K (32 random bytes) → slotId / writeToken / readToken / encKey by SHA-256 over
// `ASCII(label) || K`; plaintext PhonePayload JSON → AES-256-GCM (12-byte IV, 16-byte tag, AAD = slotId)
// → envelope { v, iv, ct, ts } PUT to `<relay>/v1/slots/<slotId>`. The relay only ever sees ciphertext.

const crypto = require('crypto');

const PROTOCOL_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const LABELS = Object.freeze({ slot: 'aiusage-slot', write: 'aiusage-write', read: 'aiusage-read', enc: 'aiusage-enc' });
const SLOT_ID_RE = /^[0-9a-f]{32}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_RELAY_URL_LENGTH = 512;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Push policy (spec "Desktop behaviour").
const PUSH_INTERVAL_MS = 5 * 60 * 1000;   // push at least every 5 min while data flows
const PUSH_FLOOR_MS = 60 * 1000;          // never two attempts within 60 s (relay KV write budget)
const BACKOFF_MIN_MS = 60 * 1000;         // 1 → 2 → 4 → … → 30 min
const BACKOFF_MAX_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15000;
const HISTORY_DAYS = 7;
const HISTORY_BUCKET_MS = 30 * 60 * 1000;
const HISTORY_MAX_SAMPLES = 400;
const QR_OPTIONS = Object.freeze({ margin: 1, width: 220, errorCorrectionLevel: 'M' });

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------
function toKeyBuffer(K) {
  const buf = Buffer.isBuffer(K) ? K : (K instanceof Uint8Array ? Buffer.from(K.buffer, K.byteOffset, K.byteLength) : null);
  if (!buf || buf.length !== KEY_BYTES) throw new TypeError(`pair key must be ${KEY_BYTES} bytes`);
  return buf;
}

function labelledHash(label, K) {
  return crypto.createHash('sha256').update(Buffer.from(label, 'ascii')).update(K).digest();
}

// K → { slotId (32 hex), writeToken (64 hex), readToken (64 hex), encKey (32 raw bytes) }.
function deriveSlot(K) {
  const key = toKeyBuffer(K);
  return {
    slotId: labelledHash(LABELS.slot, key).toString('hex').slice(0, 32),
    writeToken: labelledHash(LABELS.write, key).toString('hex'),
    readToken: labelledHash(LABELS.read, key).toString('hex'),
    encKey: labelledHash(LABELS.enc, key),
  };
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(str) {
  if (typeof str !== 'string' || !str || !BASE64URL_RE.test(str)) return null;
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64');
  // Buffer.from(base64) silently ignores junk; a round trip proves the input was canonical.
  return base64url(buf) === str ? buf : null;
}

// Relay base URL rules (spec "Pairing string"): https only (http for localhost / 127.0.0.1), no credentials,
// no query or fragment, trailing slashes stripped, ≤ 512 chars. Returns the normalized string or null.
function validateRelayUrl(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text || text.length > MAX_RELAY_URL_LENGTH) return null;
  let url;
  try {
    url = new URL(text);
  } catch (err) {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol === 'http:') {
    if (!LOCAL_HOSTS.has(url.hostname)) return null;
  } else if (url.protocol !== 'https:') {
    return null;
  }
  if (!url.hostname) return null;
  const path = url.pathname.replace(/\/+$/, '');
  const normalized = `${url.origin}${path}`;
  return normalized.length <= MAX_RELAY_URL_LENGTH ? normalized : null;
}

function buildPairString(relayUrl, K) {
  const relay = validateRelayUrl(relayUrl);
  if (!relay) throw new TypeError('invalid relay URL');
  const key = toKeyBuffer(K);
  return `aiusage://pair?v=${PROTOCOL_VERSION}&r=${encodeURIComponent(relay)}&k=${base64url(key)}`;
}

// → { relayUrl, key } or null. Strict: any deviation from the documented shape is rejected.
function parsePairString(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!/^aiusage:\/\/pair\?/i.test(text)) return null;
  let url;
  try {
    url = new URL(text);
  } catch (err) {
    return null;
  }
  if (url.protocol !== 'aiusage:' || url.hostname !== 'pair' || (url.pathname !== '' && url.pathname !== '/') || url.hash) return null;
  const params = url.searchParams;
  if (params.get('v') !== String(PROTOCOL_VERSION)) return null;
  const relayUrl = validateRelayUrl(params.get('r'));
  if (!relayUrl) return null;
  const key = fromBase64url(params.get('k'));
  if (!key || key.length !== KEY_BYTES) return null;
  return { relayUrl, key };
}

function isValidEnvelope(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return false;
  if (env.v !== PROTOCOL_VERSION) return false;
  if (typeof env.iv !== 'string' || typeof env.ct !== 'string') return false;
  if (typeof env.ts !== 'number' || !Number.isFinite(env.ts)) return false;
  let iv;
  let ct;
  try {
    iv = Buffer.from(env.iv, 'base64');
    ct = Buffer.from(env.ct, 'base64');
  } catch (err) {
    return false;
  }
  return iv.length === IV_BYTES && ct.length >= TAG_BYTES;
}

// AES-256-GCM with AAD = ASCII(slotId); `ct` is ciphertext || 16-byte tag, exactly what WebCrypto/CryptoKit expect.
function encryptPayload(encKey, slotId, payloadObj, { iv, ts } = {}) {
  const key = toKeyBuffer(encKey);
  if (typeof slotId !== 'string' || !SLOT_ID_RE.test(slotId)) throw new TypeError('invalid slotId');
  const nonce = iv ? Buffer.from(iv) : crypto.randomBytes(IV_BYTES);
  if (nonce.length !== IV_BYTES) throw new TypeError(`iv must be ${IV_BYTES} bytes`);
  const plaintext = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(slotId, 'ascii'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const stamp = Number.isFinite(ts) ? ts : (payloadObj && Number.isFinite(payloadObj.generatedAt) ? payloadObj.generatedAt : Date.now());
  return { v: PROTOCOL_VERSION, iv: nonce.toString('base64'), ct: body.toString('base64'), ts: stamp };
}

// Node-side reference of the phone's decrypt (tests + relay round trips). Throws on any auth failure.
function decryptEnvelope(encKey, slotId, envelope) {
  const key = toKeyBuffer(encKey);
  if (typeof slotId !== 'string' || !SLOT_ID_RE.test(slotId)) throw new TypeError('invalid slotId');
  if (!isValidEnvelope(envelope)) throw new TypeError('invalid envelope');
  const iv = Buffer.from(envelope.iv, 'base64');
  const ct = Buffer.from(envelope.ct, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(slotId, 'ascii'));
  decipher.setAuthTag(ct.subarray(ct.length - TAG_BYTES));
  const plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - TAG_BYTES)), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// 30-minute buckets, LAST sample of each bucket wins, newest 400 kept.
function downsampleHistory(samples, { bucketMs = HISTORY_BUCKET_MS, max = HISTORY_MAX_SAMPLES } = {}) {
  const valid = (Array.isArray(samples) ? samples : [])
    .filter((s) => s && typeof s.t === 'number' && Number.isFinite(s.t) && s.v && typeof s.v === 'object')
    .sort((a, b) => a.t - b.t);
  const byBucket = new Map();
  for (const sample of valid) byBucket.set(Math.floor(sample.t / bucketMs), sample);
  const out = [...byBucket.values()].map((s) => ({ t: s.t, v: { ...s.v } }));
  return out.length > max ? out.slice(out.length - max) : out;
}

function stripRaw(snapshot) {
  const plain = JSON.parse(JSON.stringify(snapshot || { fetchedAt: 0, providers: {} }));
  const providers = plain && plain.providers && typeof plain.providers === 'object' ? plain.providers : {};
  for (const provider of Object.values(providers)) {
    if (provider && typeof provider === 'object') delete provider.raw;
  }
  return plain;
}

function buildPhonePayload({ snapshot, history, settings = {}, appVersion = '0.0.0', platform = process.platform, hostname = '', now = Date.now() } = {}) {
  const hist = history && typeof history === 'object' ? history : {};
  const series = (Array.isArray(hist.series) ? hist.series : [])
    .filter((s) => s && typeof s.key === 'string')
    .map((s) => ({ key: s.key, label: typeof s.label === 'string' ? s.label : s.key, color: typeof s.color === 'string' ? s.color : 'slate' }));
  return {
    v: PROTOCOL_VERSION,
    generatedAt: now,
    source: { app: 'ai-usage-widget', version: String(appVersion), platform: String(platform), host: String(hostname || '') },
    snapshot: stripRaw(snapshot),
    settings: {
      warnThreshold: Number.isFinite(settings.warnThreshold) ? settings.warnThreshold : 75,
      dangerThreshold: Number.isFinite(settings.dangerThreshold) ? settings.dangerThreshold : 90,
      timeFormat: settings.timeFormat === '24h' ? '24h' : '12h',
      // Added in 0.2.1 so the phone's weekly "resets at" text matches the desktop's exactly. Older iOS
      // builds ignore the extra key; the two accepted values are the two the settings UI offers.
      dateFormat: settings.dateFormat === 'date-day' || settings.dateFormat === 'date-day-time' ? 'date-day' : 'date',
    },
    history: { days: HISTORY_DAYS, samples: downsampleHistory(hist.samples), series },
  };
}

// Change detection: provider status, each window's integer percent + resetsAt, and the integer extra percent.
function fingerprint(snapshot) {
  const providers = snapshot && snapshot.providers && typeof snapshot.providers === 'object' ? snapshot.providers : {};
  const parts = [];
  for (const id of Object.keys(providers).sort()) {
    const p = providers[id];
    if (!p || typeof p !== 'object') { parts.push(`${id}:off`); continue; }
    const windows = (Array.isArray(p.windows) ? p.windows : []).filter((w) => w && typeof w === 'object');
    const rows = windows.map((w) => `${w.key}=${Number.isFinite(Number(w.percent)) ? Math.round(Number(w.percent)) : 'x'}@${w.resetsAt || ''}`);
    const extra = p.extra && Number.isFinite(p.extra.percent) ? Math.round(p.extra.percent) : 'x';
    parts.push(`${id}:${p.status}|${rows.join(',')}|${extra}`);
  }
  return parts.join(';');
}

// Decides whether a push is due now. `state` = { lastPushAt, lastAttemptAt, nextRetryAt, forced }.
// Returns false or the reason ('forced' | 'first' | 'interval' | 'change'). The 60 s floor gates every
// reason; the failure backoff gates the automatic ones only (a forced push is the user's explicit retry).
function shouldPush(prev, next, now, state = {}) {
  if (!next) return false;
  const lastAttemptAt = Number.isFinite(state.lastAttemptAt) ? state.lastAttemptAt : null;
  if (lastAttemptAt !== null && now - lastAttemptAt < PUSH_FLOOR_MS) return false;
  if (state.forced) return 'forced';
  const nextRetryAt = Number.isFinite(state.nextRetryAt) ? state.nextRetryAt : null;
  if (nextRetryAt !== null && now < nextRetryAt) return false;
  const lastPushAt = Number.isFinite(state.lastPushAt) ? state.lastPushAt : null;
  if (lastPushAt === null) return 'first';
  if (now - lastPushAt >= PUSH_INTERVAL_MS) return 'interval';
  if (fingerprint(prev) !== fingerprint(next)) return 'change';
  return false;
}

function nextBackoff(currentMs) {
  if (!Number.isFinite(currentMs) || currentMs <= 0) return BACKOFF_MIN_MS;
  return Math.min(BACKOFF_MAX_MS, currentMs * 2);
}

function describeHttpFailure(status) {
  if (status === 401) return 'HTTP 401 — slot owned by another key (re-pair)';
  if (status === 413) return 'HTTP 413 — payload too large';
  if (status === 404) return 'HTTP 404 — not a relay URL';
  return `HTTP ${status}`;
}

function errorMessage(err, timeoutMs = REQUEST_TIMEOUT_MS) {
  if (err && err.name === 'AbortError') return `Timed out after ${Math.round(timeoutMs / 1000)} s`;
  const msg = String((err && err.message) || err || 'Unknown error');
  return msg.length > 200 ? `${msg.slice(0, 197)}...` : msg;
}

// ---------------------------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------------------------
function createPhoneSync({
  getSettings,
  loadKey,            // () → Buffer | null   (persisted K; requires safeStorage → call load() after app ready)
  saveKey,            // (Buffer) → boolean   (true when it landed on disk; false = memory only this run)
  clearKey,           // () → void
  fetch: fetchImpl,
  now = Date.now,
  log,
  appVersion = '0.0.0',
  platform = process.platform,
  hostname = '',
  qr,                 // { toDataURL(text, opts) → Promise<string> }; defaults to the `qrcode` package
  random = (n) => crypto.randomBytes(n),
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const logger = {
    info: (...a) => { if (typeof log === 'function') log(...a); else if (log && log.info) log.info(...a); },
    warn: (...a) => { if (log && typeof log.warn === 'function') log.warn(...a); else logger.info('WARN', ...a); },
    debug: (...a) => { if (log && typeof log.debug === 'function') log.debug(...a); },
  };
  const doFetch = (...args) => (fetchImpl || globalThis.fetch)(...args);

  let key = null;            // Buffer | null
  let derived = null;        // deriveSlot(key)
  let keyPersisted = false;
  let lastPushAt = null;
  let lastAttemptAt = null;
  let lastError = null;
  let nextRetryAt = null;
  let backoffMs = 0;
  let forced = false;        // first fill after (re-)pairing / relay change — bypasses the backoff, not the floor
  let failureLogged = false;
  let lastPushedSnapshot = null;
  let lastSnapshot = null;
  let lastHistory = null;    // object or () → object (lazy: history reads the store)
  let inFlight = null;
  const listeners = new Set();

  function settings() {
    try {
      return (typeof getSettings === 'function' && getSettings()) || {};
    } catch (err) {
      logger.warn('getSettings failed:', errorMessage(err));
      return {};
    }
  }

  function relayUrl() {
    return validateRelayUrl(settings().phoneRelayUrl);
  }

  function enabled() {
    return settings().phoneSyncEnabled === true;
  }

  function getStatus() {
    return {
      enabled: enabled(),
      relayUrl: relayUrl() || '',
      paired: !!key,
      keyPersisted: !!key && keyPersisted,
      lastPushAt,
      lastError,
      nextRetryAt,
      slotId: derived ? derived.slotId : null,
    };
  }

  function emit() {
    const status = getStatus();
    for (const cb of listeners) {
      try { cb(status); } catch (err) { logger.warn('status listener threw:', errorMessage(err)); }
    }
    return status;
  }

  function onStatus(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  function setKey(buf, persisted) {
    key = buf ? toKeyBuffer(buf) : null;
    derived = key ? deriveSlot(key) : null;
    keyPersisted = !!key && !!persisted;
  }

  function resetPushState() {
    lastPushAt = null;
    lastAttemptAt = null;
    lastError = null;
    nextRetryAt = null;
    backoffMs = 0;
    failureLogged = false;
    lastPushedSnapshot = null;
  }

  // Restores a persisted key. Safe to call more than once; never throws.
  function load() {
    try {
      const stored = typeof loadKey === 'function' ? loadKey() : null;
      if (stored) {
        setKey(stored, true);
        logger.info(`pair key restored (slot ${derived.slotId.slice(0, 8)}…)`);
      }
    } catch (err) {
      logger.warn('restoring the pair key failed:', errorMessage(err));
    }
    return emit();
  }

  function generateKey() {
    const fresh = toKeyBuffer(random(KEY_BYTES));
    let persisted = false;
    try {
      persisted = typeof saveKey === 'function' ? saveKey(fresh) === true : false;
    } catch (err) {
      logger.warn('persisting the pair key failed; keeping it for this run only:', errorMessage(err));
    }
    setKey(fresh, persisted);
    resetPushState();
    forced = true;
    if (!persisted) logger.warn('pair key is kept in memory only (safeStorage unavailable) — re-pair after a restart');
    logger.info(`new pair key (slot ${derived.slotId.slice(0, 8)}…)`);
  }

  function ensureKey() {
    if (!key) generateKey();
  }

  async function timedFetch(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      return await doFetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // Best-effort slot delete with the CURRENT key (before it is rotated/forgotten). Never throws.
  async function deleteSlot() {
    const relay = relayUrl();
    if (!relay || !derived) return false;
    try {
      const res = await timedFetch(`${relay}/v1/slots/${derived.slotId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${derived.writeToken}` },
      });
      logger.debug(`slot delete → HTTP ${res.status}`);
      return res.status === 204;
    } catch (err) {
      logger.debug('slot delete failed:', errorMessage(err));
      return false;
    }
  }

  function resolveHistory() {
    try {
      const h = typeof lastHistory === 'function' ? lastHistory() : lastHistory;
      return h && typeof h === 'object' ? h : { samples: [], series: [] };
    } catch (err) {
      logger.warn('history for the phone payload failed:', errorMessage(err));
      return { samples: [], series: [] };
    }
  }

  function recordFailure(message, at) {
    backoffMs = nextBackoff(backoffMs);
    nextRetryAt = at + backoffMs;
    lastError = message;
    if (!failureLogged) {
      failureLogged = true;
      logger.warn(`push failed: ${message}; retrying in ${Math.round(backoffMs / 60000)} min (further failures logged at debug level)`);
    } else {
      logger.debug(`push failed again: ${message}; next retry in ${Math.round(backoffMs / 60000)} min`);
    }
  }

  // One PUT. Returns { ok, error? }. Never rejects; never logs key material or the payload.
  function push(reason) {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const relay = relayUrl();
      if (!relay || !derived) return { ok: false, error: !derived ? 'Not paired' : 'No relay URL' };
      if (!lastSnapshot) return { ok: false, error: 'No usage data yet' };
      const startedAt = now();
      lastAttemptAt = startedAt;
      // A forced push is one attempt; if it fails the normal path ('first' / 'interval' / 'change') takes
      // over and honours the backoff instead of hammering the relay every 60 s.
      forced = false;
      const snapshot = lastSnapshot;
      let envelope;
      try {
        const payload = buildPhonePayload({
          snapshot, history: resolveHistory(), settings: settings(), appVersion, platform, hostname, now: startedAt,
        });
        envelope = encryptPayload(derived.encKey, derived.slotId, payload, { iv: random(IV_BYTES), ts: startedAt });
      } catch (err) {
        const message = `Could not build the payload: ${errorMessage(err)}`;
        recordFailure(message, startedAt);
        emit();
        return { ok: false, error: message };
      }
      const body = JSON.stringify(envelope);
      try {
        const res = await timedFetch(`${relay}/v1/slots/${derived.slotId}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${derived.writeToken}`,
            'X-Read-Token': derived.readToken,
            'Content-Type': 'application/json',
          },
          body,
        });
        if (res.status !== 204 && !(res.status >= 200 && res.status < 300)) {
          recordFailure(describeHttpFailure(res.status), startedAt);
          emit();
          return { ok: false, error: lastError };
        }
        lastPushAt = now();
        lastError = null;
        nextRetryAt = null;
        backoffMs = 0;
        failureLogged = false;
        forced = false;
        lastPushedSnapshot = snapshot;
        logger.info(`pushed (${reason}, ${body.length} bytes)`);
        emit();
        return { ok: true };
      } catch (err) {
        recordFailure(errorMessage(err, requestTimeoutMs), startedAt);
        emit();
        return { ok: false, error: lastError };
      }
    })().catch((err) => {
      // Defensive: nothing above should reject, but a bug here must never surface as an unhandled rejection.
      logger.warn('push crashed:', errorMessage(err));
      return { ok: false, error: errorMessage(err) };
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function evaluate() {
    if (!enabled() || !relayUrl() || !derived || !lastSnapshot) return null;
    const reason = shouldPush(lastPushedSnapshot, lastSnapshot, now(), { lastPushAt, lastAttemptAt, nextRetryAt, forced });
    if (!reason) return null;
    return push(reason);
  }

  // Scheduler hook. `history` may be the { samples, series } object or a function returning it (evaluated
  // only when a push actually happens — the history store is read from disk).
  function onSnapshot(snapshot, history) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    lastSnapshot = snapshot;
    if (history !== undefined) lastHistory = history;
    return evaluate();
  }

  // Settings side effects (main.js calls this when phoneSyncEnabled / phoneRelayUrl changed).
  function settingsChanged(prev = {}, next = {}) {
    const turnedOn = next.phoneSyncEnabled === true && prev.phoneSyncEnabled !== true;
    const relayChanged = validateRelayUrl(prev.phoneRelayUrl) !== validateRelayUrl(next.phoneRelayUrl);
    if (turnedOn && !key) generateKey();
    if (relayChanged) {
      // A different relay has no data yet; forget the old failure state and fill it right away.
      resetPushState();
      forced = true;
    }
    if (turnedOn) forced = true;
    emit();
    return evaluate();
  }

  async function renderQr(text) {
    const impl = qr || require('qrcode');
    // qrcode mutates the options object in place (getOptions does `if (!options.color) options.color = {}`
    // before reading options.color.dark). QR_OPTIONS is frozen, so that write silently no-ops in sloppy
    // mode and the next read throws. Hand it a throwaway copy.
    return impl.toDataURL(text, { ...QR_OPTIONS });
  }

  // { pairString, qrDataUrl, slotId, error }. Creates K when absent; never rotates an existing one.
  async function getPairing() {
    ensureKey();
    const relay = relayUrl();
    const base = { pairString: null, qrDataUrl: null, slotId: derived.slotId, error: null };
    emit();
    if (!relay) return { ...base, error: 'Set a relay URL first' };
    try {
      const pairString = buildPairString(relay, key);
      const qrDataUrl = await renderQr(pairString);
      return { ...base, pairString, qrDataUrl };
    } catch (err) {
      logger.warn('rendering the pairing code failed:', errorMessage(err));
      return { ...base, error: `Could not render the pairing code: ${errorMessage(err)}` };
    }
  }

  async function repair() {
    if (key) await deleteSlot();
    generateKey();
    const pairing = await getPairing();
    evaluate();
    return pairing;
  }

  // DELETE best-effort, forget K. Disabling the setting is main.js's job (it owns settings + broadcast).
  async function unpair() {
    if (key) await deleteSlot();
    try {
      if (typeof clearKey === 'function') clearKey();
    } catch (err) {
      logger.warn('clearing the pair key failed:', errorMessage(err));
    }
    setKey(null, false);
    resetPushState();
    forced = false;
    logger.info('unpaired');
    emit();
    return true;
  }

  // GET /v1/health on the given (unsaved) or the saved relay URL.
  async function test(candidate) {
    const relay = validateRelayUrl(candidate === undefined || candidate === null || candidate === '' ? settings().phoneRelayUrl : candidate);
    if (!relay) return { ok: false, error: 'Enter an https:// relay URL' };
    const startedAt = now();
    try {
      const res = await timedFetch(`${relay}/v1/health`, { method: 'GET', headers: { Accept: 'application/json' } });
      const latencyMs = Math.max(0, now() - startedAt);
      let body = null;
      try { body = await res.json(); } catch (err) { body = null; }
      if (res.status === 200 && body && body.ok === true) return { ok: true, status: res.status, latencyMs };
      return { ok: false, status: res.status, latencyMs, error: res.status === 200 ? 'Not a relay (unexpected health response)' : describeHttpFailure(res.status) };
    } catch (err) {
      return { ok: false, latencyMs: Math.max(0, now() - startedAt), error: errorMessage(err, requestTimeoutMs) };
    }
  }

  async function pushNow() {
    if (!derived) return { ok: false, error: 'Not paired' };
    if (!relayUrl()) return { ok: false, error: 'No relay URL' };
    if (!enabled()) return { ok: false, error: 'Phone sync is turned off' };
    if (!lastSnapshot) return { ok: false, error: 'No usage data yet' };
    if (inFlight) return inFlight;
    const t = now();
    if (lastAttemptAt !== null && t - lastAttemptAt < PUSH_FLOOR_MS) {
      return { ok: false, error: `Wait ${Math.ceil((PUSH_FLOOR_MS - (t - lastAttemptAt)) / 1000)} s between pushes` };
    }
    return push('manual');
  }

  // Resolves when the push in flight (if any) has finished — lets callers/tests observe fire-and-forget pushes.
  function pending() {
    return inFlight ? inFlight.then(() => undefined) : Promise.resolve();
  }

  return {
    load,
    onSnapshot,
    settingsChanged,
    getStatus,
    getPairing,
    repair,
    unpair,
    test,
    pushNow,
    onStatus,
    pending,
  };
}

module.exports = {
  createPhoneSync,
  deriveSlot,
  buildPairString,
  parsePairString,
  encryptPayload,
  decryptEnvelope,
  isValidEnvelope,
  buildPhonePayload,
  downsampleHistory,
  validateRelayUrl,
  shouldPush,
  fingerprint,
  base64url,
  fromBase64url,
  PROTOCOL_VERSION,
  KEY_BYTES,
  PUSH_INTERVAL_MS,
  PUSH_FLOOR_MS,
  BACKOFF_MIN_MS,
  BACKOFF_MAX_MS,
  REQUEST_TIMEOUT_MS,
  HISTORY_BUCKET_MS,
  HISTORY_MAX_SAMPLES,
};
