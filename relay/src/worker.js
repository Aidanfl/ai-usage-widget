// aiusage-relay — Cloudflare Worker implementing the phone-sync relay (docs/PHONE-SYNC.md "Relay HTTP API").
//
// The relay stores one opaque envelope per slot: it never sees the pair key or the AES key, only
// ciphertext plus the SHA-256 hashes of the write/read tokens that guard the slot. No dependencies;
// only Request/Response/URL/crypto.subtle globals, so the same file runs under plain Node 24 in tests.
//
// Storage record (KV key = slotId):  { wh, rh, env, updatedAt }   expirationTtl 7 days, refreshed on write.

const VERSION = 1;
const SLOT_ID_RE = /^[0-9a-f]{32}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 256 * 1024;
const SLOT_TTL_SECONDS = 7 * 24 * 60 * 60;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const BASE_HEADERS = Object.freeze({ 'Cache-Control': 'no-store' });

function respond(status, body, extraHeaders) {
  const headers = { ...BASE_HEADERS, ...(extraHeaders || {}) };
  if (body === undefined || body === null) return new Response(null, { status, headers });
  headers['Content-Type'] = 'application/json; charset=utf-8';
  return new Response(JSON.stringify(body), { status, headers });
}

function error(status, message, extraHeaders) {
  return respond(status, { error: message }, extraHeaders);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time comparison of two equal-length ASCII strings (crypto.subtle.timingSafeEqual is
// Workers-only, so this stays portable to Node for the tests).
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Tokens are lowercase hex by construction (spec: ^[0-9a-f]{64}$); anything else is rejected as-is.
function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+([0-9a-f]{64})\s*$/.exec(header);
  return match ? match[1] : null;
}

function readToken(request) {
  const value = (request.headers.get('X-Read-Token') || '').trim();
  return TOKEN_RE.test(value) ? value : null;
}

function base64Length(str) {
  // Returns the decoded byte length of a standard-base64 string, or -1 when it is not valid base64.
  if (typeof str !== 'string' || str.length === 0 || str.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(str)) return -1;
  const padding = str.endsWith('==') ? 2 : (str.endsWith('=') ? 1 : 0);
  return (str.length / 4) * 3 - padding;
}

// Envelope validation on PUT: { v: 1, iv: base64 (12 bytes), ct: base64 (≥ 16 bytes), ts: finite number }.
function isValidEnvelope(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return false;
  if (env.v !== VERSION) return false;
  if (typeof env.ts !== 'number' || !Number.isFinite(env.ts)) return false;
  return base64Length(env.iv) === IV_BYTES && base64Length(env.ct) >= TAG_BYTES;
}

async function readRecord(env, slotId) {
  const record = await env.SLOTS.get(slotId, 'json');
  if (!record || typeof record !== 'object' || typeof record.wh !== 'string' || typeof record.rh !== 'string') return null;
  return record;
}

async function handlePut(request, env, slotId) {
  const writeToken = bearerToken(request);
  const read = readToken(request);
  if (!writeToken || !read) return error(401, 'missing or malformed tokens');

  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return error(413, 'envelope too large');
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) return error(413, 'envelope too large');

  let envelope;
  try {
    envelope = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    return error(400, 'body is not JSON');
  }
  if (!isValidEnvelope(envelope)) return error(400, 'invalid envelope');

  const [wh, rh] = await Promise.all([sha256Hex(writeToken), sha256Hex(read)]);
  const existing = await readRecord(env, slotId);
  // First write claims the slot; afterwards only the owner (same write token) may replace it.
  if (existing && !constantTimeEqual(existing.wh, wh)) return error(401, 'write token does not match the slot owner');

  const record = {
    wh,
    rh,
    env: { v: VERSION, iv: envelope.iv, ct: envelope.ct, ts: envelope.ts },
    updatedAt: Date.now(),
  };
  await env.SLOTS.put(slotId, JSON.stringify(record), { expirationTtl: SLOT_TTL_SECONDS });
  return respond(204);
}

async function handleGet(request, env, slotId) {
  const token = bearerToken(request);
  if (!token) return error(401, 'missing or malformed read token');
  const record = await readRecord(env, slotId);
  if (!record) return error(404, 'no data for this slot');
  const rh = await sha256Hex(token);
  if (!constantTimeEqual(record.rh, rh)) return error(401, 'read token rejected');
  return respond(200, record.env);
}

async function handleDelete(request, env, slotId) {
  const token = bearerToken(request);
  if (!token) return error(401, 'missing or malformed write token');
  const record = await readRecord(env, slotId);
  if (record) {
    const wh = await sha256Hex(token);
    if (!constantTimeEqual(record.wh, wh)) return error(401, 'write token does not match the slot owner');
    await env.SLOTS.delete(slotId);
  }
  return respond(204);
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/v1/health') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return error(405, 'method not allowed', { Allow: 'GET, HEAD' });
    return respond(200, { ok: true, v: VERSION });
  }

  const slotMatch = /^\/v1\/slots\/([^/]+)$/.exec(path);
  if (slotMatch) {
    if (!['PUT', 'GET', 'DELETE'].includes(request.method)) return error(405, 'method not allowed', { Allow: 'GET, PUT, DELETE' });
    const slotId = slotMatch[1];
    if (!SLOT_ID_RE.test(slotId)) return error(400, 'invalid slot id');
    if (!env || !env.SLOTS) return error(500, 'KV binding SLOTS is not configured');
    if (request.method === 'PUT') return handlePut(request, env, slotId);
    if (request.method === 'GET') return handleGet(request, env, slotId);
    return handleDelete(request, env, slotId);
  }

  return error(404, 'not found');
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      return error(500, 'internal error');
    }
  },
};
