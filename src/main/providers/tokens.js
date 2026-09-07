'use strict';

/**
 * tokens.js — PURE-ish credential helpers (fs + injected fetch, no Electron, no module state).
 *
 *   decodeJwt(token) → claims|null
 *   jwtExpiryMs(token) → ms|null
 *   readJsonFile(path) → Promise<object|null>      null when the file does not exist;
 *                                                 retries once after 100 ms on a parse error
 *                                                 (the owning CLI truncates+rewrites, never renames);
 *                                                 still-unparseable → throws with err.code = 'parse'
 *                                                 (message carries the position only — never file content)
 *   readJsonText(path) → Promise<{ data, text }|null>   same, but also returns the raw text
 *   writeJsonAtomic(path, obj, opts) → Promise<void>    temp file in same dir + rename, Windows EPERM retry;
 *                                                 a failed staging write removes its own temp file
 *   refreshCodexTokens({ fetch, authPath, now, expectedRefreshToken }) → { ok, tokens?, auth?, permanent?, error? }
 *   refreshClaudeTokens({ fetch, credentialsPath, now, expectedRefreshToken, expectedAccessToken, lockPath })
 *                                                → { ok, oauth?, permanent?, lockHeld?, error? }
 *   acquireLock(lockPath, opts) → { ok, release()? , reason? }   proper-lockfile-compatible directory lock
 *   createBackoff(opts) → { shouldSkip(now), recordFailure(now, { permanent }), reset(), state() }
 *   isLapsed(expiresAtMs, nowMs, graceMs) → boolean   now ≥ expiresAt + grace — "about to expire" is never lapsed
 *   refreshGate({ nowMs, lastAttemptAt, spacingMs, mtimeMs, freshFileMs })
 *                                                → { ok: true } | { ok: false, reason: 'spacing'|'fresh_file', retryAt }
 *   fileMtimeMs(path) → Promise<number|null>       stat mtime in ms; null when the file cannot be stat'ed
 *
 * Nothing in this file ever logs a token. Log lines carry status codes and OAuth error codes only.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

// research-claude.md §2.1: platform.claude.com is what Claude Code 2.1.263 uses; console.anthropic.com
// is the legacy alias. Tried in order only when the previous host gave no definitive answer
// (network / 404 / 405 / 5xx) — a 400/401/403 from the first host is final.
const CLAUDE_TOKEN_URLS = [
  'https://platform.claude.com/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token',
];
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Claude Code's default refresh scope list (`X8` in the 2.1.263 binary) — used when the file has no `scopes`.
const CLAUDE_DEFAULT_SCOPES = ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'];
// Cross-process refresh lock shared with Claude Code (research §2.2 / §8.5): proper-lockfile semantics.
const CLAUDE_LOCK_NAME = '.oauth_refresh.lock';
const LOCK_STALE_MS = 60000;
const LOCK_TOTAL_WAIT_MS = 7500;
const LOCK_UPDATE_MS = 5000;

const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const REFRESH_TIMEOUT_MS = 30000;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noop = () => {};

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

/** Decode the payload of a JWT without verifying it (we only need `exp` and account claims). */
function decodeJwt(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

/** `exp` claim as ms epoch, or null when absent / unparseable. */
function jwtExpiryMs(token) {
  const claims = decodeJwt(token);
  return claims && Number.isFinite(claims.exp) ? claims.exp * 1000 : null;
}

// ---------------------------------------------------------------------------
// JSON files
// ---------------------------------------------------------------------------

/**
 * V8's JSON.parse messages quote a window of the source text (`Unexpected token 'x', "...sk-ant-oat01-ab"... is not
 * valid JSON`). For a credentials file that window can be a token fragment, so it never makes it into an error
 * message. Position information is kept.
 */
function sanitizeJsonError(message) {
  return String(message == null ? '' : message)
    .replace(/,?\s*(?:\.\.\.)?"[\s\S]*"(?:\.\.\.)?\s*is not valid JSON\s*$/, '')
    .replace(/[\s\S]*is not valid JSON\s*$/, 'is not valid JSON')
    .trim() || 'invalid JSON';
}

async function readJsonText(filePath, { retryDelayMs = 100, sleep = defaultSleep, fs = fsp } = {}) {
  for (let attempt = 0; ; attempt++) {
    let text;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return null;
      // A writer holding the file exclusively for a moment looks like EBUSY/EPERM on Windows.
      if (attempt === 0 && e && RENAME_RETRY_CODES.has(e.code)) { await sleep(retryDelayMs); continue; }
      throw e;
    }
    try {
      const data = JSON.parse(text);
      return { data, text };
    } catch (e) {
      if (attempt === 0) { await sleep(retryDelayMs); continue; } // writer may be mid-write
      const err = new Error(`Unparseable JSON in ${path.basename(filePath)}: ${sanitizeJsonError(e && e.message)}`);
      err.code = 'parse';
      throw err;
    }
  }
}

async function readJsonFile(filePath, opts) {
  const res = await readJsonText(filePath, opts);
  return res ? res.data : null;
}

/** mtime of a file in ms, or null when it cannot be stat'ed (missing, or a writer is mid-rename). Never throws. */
async function fileMtimeMs(filePath, { fs = fsp } = {}) {
  try {
    return (await fs.stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Refresh policy (pure) — shared by both providers
// ---------------------------------------------------------------------------
//
// The owning CLI (Claude Code, Codex CLI / desktop) refreshes AHEAD of expiry and rotates single-use refresh
// tokens. A second process that also refreshes ahead of expiry races it and burns the token, forcing the user to
// sign in again (research-claude.md §2.x, research-codex.md §3.3–3.5 / §7 — openai/codex #39925). So a widget
// refreshes only once the token has actually lapsed (or on a real 401), never when the credential file was
// written moments ago, and never more than once per spacing window from one process.

/**
 * True once the token has actually lapsed: now ≥ expiresAt + graceMs. A token merely close to expiry, or an
 * unknown / unparseable expiry, is NOT lapsed — it is used as-is and a 401 decides.
 */
function isLapsed(expiresAtMs, nowMs, graceMs = 60000) {
  const exp = Number(expiresAtMs);
  return Number.isFinite(exp) && exp > 0 && nowMs >= exp + graceMs;
}

/**
 * refreshGate({ nowMs, lastAttemptAt = 0, spacingMs = 10 min, mtimeMs = null, freshFileMs = 30 s })
 *   → { ok: true }
 *   | { ok: false, reason: 'spacing',    retryAt }   this process attempted a refresh < spacingMs ago
 *   | { ok: false, reason: 'fresh_file', retryAt }   the credential file was written < freshFileMs ago (or has a
 *                                                    future mtime — clock skew is treated as "just written")
 * `mtimeMs: null` (unknown age) and `lastAttemptAt: 0` (no attempt yet) do not block.
 */
function refreshGate({ nowMs, lastAttemptAt = 0, spacingMs = 10 * 60000, mtimeMs = null, freshFileMs = 30000 } = {}) {
  if (lastAttemptAt && nowMs - lastAttemptAt < spacingMs) return { ok: false, reason: 'spacing', retryAt: lastAttemptAt + spacingMs };
  if (mtimeMs != null && Number.isFinite(mtimeMs) && nowMs - mtimeMs < freshFileMs) return { ok: false, reason: 'fresh_file', retryAt: mtimeMs + freshFileMs };
  return { ok: true };
}

/** Keep the on-disk formatting style: Codex writes pretty 2-space JSON, Claude Code writes one line. */
function detectIndent(text) {
  if (typeof text !== 'string') return 2;
  const m = text.match(/\n([ \t]+)"/);
  if (m) return m[1];
  return text.trim().includes('\n') ? 2 : 0;
}

/** Claude Code's staging-file name: `<target>.tmp.<8 hex>` (its cleanup regex recognises this shape). */
function claudeTempPath(filePath) {
  return `${filePath}.tmp.${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Write JSON atomically: temp file in the same directory, then rename over the target.
 * On Windows rename-over-existing fails with EPERM/EBUSY/EACCES while another process holds the
 * target open (codex.exe mid-read, Defender, indexer) → retry 6× with 50 ms → 1 s back-off.
 *
 *   tmpPath  optional (filePath) → temp path, e.g. `claudeTempPath`; default `.<base>.<pid>.<uuid>.tmp`
 *   fsync    flush the temp file to disk before the rename (needs a real fs with `open`)
 * The temp file is always created exclusively (`wx`) so two writers can never share a staging file.
 */
/** The on-disk text for `obj`: compact when indent is 0 (Claude Code style), otherwise pretty + trailing newline. */
function serializeJson(obj, indent) {
  return indent === 0 ? JSON.stringify(obj) : JSON.stringify(obj, null, indent) + '\n';
}

async function writeJsonAtomic(filePath, obj, { fs = fsp, sleep = defaultSleep, maxRetries = 6, indent = 2, tmpPath = null, fsync = false } = {}) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = typeof tmpPath === 'function' ? tmpPath(filePath) : path.join(dir, `.${base}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const body = serializeJson(obj, indent);
  // mode is a no-op on Windows (inherits the %USERPROFILE% ACL)
  try {
    if (fsync && typeof fs.open === 'function') {
      const fh = await fs.open(tmp, 'wx', 0o600);
      try {
        await fh.writeFile(body);
        await fh.sync();
      } finally {
        await fh.close();
      }
    } else {
      await fs.writeFile(tmp, body, { mode: 0o600, flag: 'wx' });
    }
  } catch (e) {
    // A failed staging write (ENOSPC, EIO…) must not leave a partial `<target>.tmp.*` behind. An EEXIST from the
    // exclusive create belongs to someone else's staging file, which we must not touch.
    if (!e || e.code !== 'EEXIST') await fs.rm(tmp, { force: true }).catch(noop);
    throw e;
  }
  for (let attempt = 0, delay = 50; ; attempt++, delay = Math.min(delay * 2, 1000)) {
    try {
      await fs.rename(tmp, filePath);
      return;
    } catch (e) {
      if (!e || !RENAME_RETRY_CODES.has(e.code) || attempt >= maxRetries) {
        await fs.rm(tmp, { force: true }).catch(noop);
        throw e;
      }
      await sleep(delay);
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-process lock (proper-lockfile semantics, no dependency)
// ---------------------------------------------------------------------------

/**
 * acquireLock(lockPath, opts) → { ok: true, release(), attempts } | { ok: false, reason: 'held'|'error', attempts, error? }
 *
 * Mirrors what proper-lockfile (and therefore Claude Code) does with `{ stale: 60000, update: 5000 }`:
 *   - the lock is a DIRECTORY created with an exclusive mkdir;
 *   - a lock whose mtime is older than `staleMs` is considered abandoned and removed, then re-tried;
 *   - while held, the directory's mtime is touched every `updateMs` so others never see us as stale;
 *   - contention → poll every 1–2 s (Claude Code waits `1000 + random()*1000` ms) for up to `totalWaitMs`;
 *   - `release()` removes the directory (idempotent; errors swallowed).
 * Nothing here throws: a failure to lock is a normal, reported outcome.
 */
async function acquireLock(lockPath, {
  fs = fsp, now = Date.now, sleep = defaultSleep, random = Math.random, log = noop,
  staleMs = LOCK_STALE_MS, totalWaitMs = LOCK_TOTAL_WAIT_MS, updateMs = LOCK_UPDATE_MS, maxAttempts = 20,
} = {}) {
  const start = now();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fs.mkdir(lockPath);
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return { ok: false, reason: 'error', attempts: attempt, error: e };
      let st = null;
      try {
        st = await fs.stat(lockPath);
      } catch (e2) {
        if (e2 && e2.code === 'ENOENT') continue; // vanished between mkdir and stat — retry at once
        return { ok: false, reason: 'error', attempts: attempt, error: e2 };
      }
      if (now() - st.mtimeMs > staleMs) {
        log(`[lock] stale lock (${Math.round((now() - st.mtimeMs) / 1000)} s old) — taking over`);
        await fs.rm(lockPath, { recursive: true, force: true }).catch(noop);
        continue;
      }
      if (now() - start >= totalWaitMs) return { ok: false, reason: 'held', attempts: attempt };
      log(`[lock] held by another process, waiting (attempt ${attempt})`);
      await sleep(1000 + random() * 1000);
      continue;
    }
    // Acquired. Keep the mtime fresh while we work so a slow refresh is never mistaken for a stale lock.
    let released = false;
    const timer = setInterval(() => {
      const t = new Date(now());
      Promise.resolve(fs.utimes(lockPath, t, t)).catch(noop);
    }, updateMs);
    if (typeof timer.unref === 'function') timer.unref();
    return {
      ok: true,
      attempts: attempt,
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(timer);
        await fs.rm(lockPath, { recursive: true, force: true }).catch(noop);
      },
    };
  }
  return { ok: false, reason: 'held', attempts: maxAttempts };
}

// ---------------------------------------------------------------------------
// Refresh helpers
// ---------------------------------------------------------------------------

/**
 * fetch with a hard deadline that covers BOTH the headers and the body: a server that answers and then stalls the
 * body must not hang a poll (undici's own body timeout is 5 min, the scheduler's provider deadline 60 s). The body
 * readers reject with an AbortError once the deadline passes; the timer is unref'd so an unread body (a 401 that is
 * retried without reading it) never keeps the process alive.
 */
async function fetchWithTimeout(fetch, url, init, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  let res;
  try {
    res = await fetch(url, { ...init, signal: ac.signal });
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
  if (res && typeof res === 'object') {
    for (const method of ['text', 'json']) {
      if (typeof res[method] !== 'function') continue;
      const original = res[method].bind(res);
      res[method] = async () => {
        try { return await original(); } finally { clearTimeout(timer); }
      };
    }
  }
  return res;
}

/** Local wall-clock "HH:MM" for user-facing retry times. */
function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Retry-After as ms (delta-seconds or HTTP date, relative to `nowMs`), or null when absent / unparseable. */
function retryAfterMs(res, nowMs) {
  const h = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/**
 * A network failure after which the token endpoint may ALREADY have processed our request — and consumed the
 * single-use refresh token: our own deadline fired, or the connection dropped mid-flight. Only a failure that
 * happened before anything was sent (DNS, refused connection, unreachable network, TLS handshake) is safe to replay
 * on an alias host. undici wraps the socket error as `TypeError: fetch failed` with the Node error in `cause`.
 */
const MAYBE_SENT_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_ABORTED']);
function requestMayHaveReachedServer(e) {
  if (!e) return false;
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  const codes = [e.code, e.cause && e.cause.code, e.cause && e.cause.cause && e.cause.cause.code];
  return codes.some((c) => typeof c === 'string' && MAYBE_SENT_CODES.has(c));
}

/** Pull an OAuth error code + human message out of the many body shapes token endpoints use. */
function parseOauthError(text) {
  let code = null; let message = null;
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') {
      if (typeof j.error === 'string') code = j.error;
      else if (j.error && typeof j.error === 'object') {
        code = j.error.code || j.error.type || null;
        message = j.error.message || null;
      }
      if (!code && typeof j.code === 'string') code = j.code;
      if (!message && typeof j.error_description === 'string') message = j.error_description;
      if (!message && typeof j.message === 'string') message = j.message;
    }
  } catch { /* HTML / plain text body */ }
  return { code, message };
}

const PERMANENT_OAUTH_CODES = /^(invalid_grant|refresh_token_expired|refresh_token_reused|refresh_token_invalidated|invalid_request_token|invalid_token)$/i;

/**
 * Permanent = the user must sign in again (stop retrying for ~30 min).
 * Transient = 5xx / network / unrecognised body → keep backing off.
 * UX lesson from openusage: only claim "expired" when the body carries a recognised OAuth code
 * or the status is 401/403 — an HTML WAF page must not log the user out.
 */
function classifyRefreshFailure(status, text) {
  const { code, message } = parseOauthError(text);
  const permanent = status === 401 || status === 403 || (status === 400 && PERMANENT_OAUTH_CODES.test(code || ''));
  return {
    permanent,
    error: {
      code: code || `http_${status}`,
      status,
      message: message || `Token refresh failed (HTTP ${status})`,
    },
  };
}

function transient(code, message) {
  return { ok: false, permanent: false, error: { code, message } };
}
function permanentFail(code, message) {
  return { ok: false, permanent: true, error: { code, message } };
}

/**
 * Refresh Codex (ChatGPT) tokens and persist them to auth.json.
 *
 *   expectedRefreshToken  the refresh token we loaded earlier this poll. If the file now holds a
 *                         different one, another process (Codex CLI/desktop) already rotated →
 *                         return its tokens without touching the network (`rotatedByOther: true`).
 *
 * Returns { ok: true, tokens, auth, persisted?, inPlace?, rotatedByOther? } or
 *         { ok: false, permanent, error: { code, message, status? } }.
 * `persisted: false` = both the atomic and the in-place write failed (tokens only in memory this cycle);
 * error code `signed_out` (permanent) = auth.json vanished / lost its tokens during the request — nothing written.
 * `writeOptions` (tests) is spread into writeJsonAtomic; its `fs` is also used for the in-place fallback.
 */
async function refreshCodexTokens({ fetch, authPath, now = Date.now, expectedRefreshToken = null, log = noop, timeoutMs = REFRESH_TIMEOUT_MS, userAgent = 'ai-usage-widget', writeOptions = {} } = {}) {
  let file;
  try {
    file = await readJsonText(authPath);
  } catch (e) {
    return transient(e.code === 'parse' ? 'parse' : 'read_failed', e.message);
  }
  const auth = file && file.data;
  const tokens = auth && auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : null;
  if (!tokens || !tokens.refresh_token) return permanentFail('no_refresh_token', 'Codex auth.json has no refresh token — run `codex login` again.');

  // Guarded reload: never burn a single-use refresh token that is not the one on disk any more.
  if (expectedRefreshToken && tokens.refresh_token !== expectedRefreshToken) {
    log('[codex] auth.json changed since load — using the other process\'s tokens');
    return { ok: true, tokens, auth, rotatedByOther: true };
  }
  const rt = tokens.refresh_token;

  let res;
  try {
    res = await fetchWithTimeout(fetch, CODEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': userAgent },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: rt }),
    }, timeoutMs);
  } catch (e) {
    return transient('network', e && e.name === 'AbortError' ? 'Token refresh timed out' : `Token refresh network error: ${e && e.message}`);
  }
  let text;
  try {
    text = await res.text();
  } catch (e) {
    // The server answered (it may have consumed the single-use refresh token) but the body was cut off. A reported
    // transient failure — never a thrown error — so the provider records the attempt in its back-off.
    return transient('network', `Token refresh response could not be read: ${e && e.message}`);
  }
  if (!res.ok) {
    const c = classifyRefreshFailure(res.status, text);
    log(`[codex] token refresh failed: HTTP ${res.status} ${c.error.code}${c.permanent ? ' (permanent)' : ''}`);
    return { ok: false, permanent: c.permanent, error: c.error };
  }
  let body;
  try { body = JSON.parse(text); } catch { return transient('parse', 'Token endpoint returned non-JSON'); }
  if (!body || typeof body.access_token !== 'string' || !body.access_token) {
    // A 2xx without a token is a dead session (openusage), not a transient hiccup.
    return permanentFail('no_access_token', 'Token endpoint returned no access token — sign in to Codex again.');
  }

  // Re-read right before writing: the CLI/desktop may have rotated while our request was in flight.
  let latest = auth;
  let signedOut = false;
  try {
    const again = await readJsonText(authPath);
    if (again === null) signedOut = true; // auth.json was removed (`codex logout`) while we were refreshing
    else latest = again.data;
  } catch { /* torn read — fall back to the object we already have */ }
  if (signedOut || !latest || typeof latest !== 'object' || !latest.tokens || typeof latest.tokens !== 'object' || !latest.tokens.refresh_token) {
    // The user signed out (or switched to an API key) during our request: never resurrect the credentials.
    log('[codex] auth.json was removed or signed out during the refresh — not writing the new tokens back');
    return permanentFail('signed_out', 'Codex was signed out while the token was being refreshed — run `codex login` to sign in again.');
  }
  if (latest.tokens.refresh_token !== rt) {
    log('[codex] auth.json rotated by another process during refresh — dropping our result');
    return { ok: true, tokens: latest.tokens, auth: latest, rotatedByOther: true };
  }
  latest.tokens.access_token = body.access_token;
  if (typeof body.refresh_token === 'string' && body.refresh_token) latest.tokens.refresh_token = body.refresh_token; // rotation
  if (typeof body.id_token === 'string' && body.id_token) latest.tokens.id_token = body.id_token;
  latest.last_refresh = new Date(now()).toISOString(); // RFC-3339 UTC, like the CLI

  const indent = detectIndent(file.text);
  try {
    await writeJsonAtomic(authPath, latest, { indent, ...writeOptions });
    return { ok: true, tokens: latest.tokens, auth: latest, persisted: true };
  } catch (e) {
    // The rotated refresh token is single-use and already consumed server-side: losing it forces `codex login` on every
    // Codex process. The CLI itself writes auth.json in place (truncate + write), so do the same when the atomic rename
    // was refused for a sharing/permission reason (rename over a file someone holds open — the Windows case) or the
    // staging file collided. Never on ENOSPC/EIO etc.: truncating the target there would destroy the file.
    const code = e && e.code;
    if (code && (RENAME_RETRY_CODES.has(code) || code === 'EEXIST')) {
      const fsImpl = writeOptions.fs || fsp;
      try {
        await fsImpl.writeFile(authPath, serializeJson(latest, indent), { mode: 0o600 });
        log(`[codex] atomic write-back refused (${code}); auth.json rewritten in place instead`);
        return { ok: true, tokens: latest.tokens, auth: latest, persisted: true, inPlace: true };
      } catch (e2) {
        log(`[codex] WARNING: refreshed tokens could not be written back (${code}, then ${e2 && e2.code || e2 && e2.message})`);
        return { ok: true, tokens: latest.tokens, auth: latest, persisted: false, error: { code: 'write_failed', message: e2 && e2.message } };
      }
    }
    // The new tokens are still valid in memory for this cycle; warn because the rotated RT is now lost to other processes.
    log(`[codex] WARNING: refreshed tokens could not be written back (${code || e && e.message})`);
    return { ok: true, tokens: latest.tokens, auth: latest, persisted: false, error: { code: 'write_failed', message: e && e.message } };
  }
}

/** The `claudeAiOauth` object of a parsed credentials file, or null. */
function claudeOauthOf(creds) {
  return creds && creds.claudeAiOauth && typeof creds.claudeAiOauth === 'object' ? creds.claudeAiOauth : null;
}

/**
 * Refresh Claude Code OAuth tokens (.credentials.json → claudeAiOauth) and persist them the way
 * Claude Code 2.1.263 does (research-claude.md §2.1, §2.2, §2.4):
 *
 *   1. take the cross-process lock `<configDir>/.oauth_refresh.lock` (give up this cycle when held);
 *   2. under the lock re-read the file — if `accessToken` or `refreshToken` changed, another process
 *      already refreshed → release and return THEIR tokens (`rotatedByOther: true`, no network);
 *   3. POST { grant_type, refresh_token, client_id, scope } to platform.claude.com, falling back to
 *      console.anthropic.com only on 404/405/5xx/network (no anthropic-beta header on the token call);
 *   4. on 200 spread the freshly re-read object and override accessToken / refreshToken (old one kept
 *      when absent) / expiresAt / refreshTokenExpiresAt (from refresh_token_expires_in) / scopes (from
 *      scope); every other key (profile, clientId, tokenAccount, mcpOAuth…) is preserved;
 *   5. write compact JSON to `<target>.tmp.<8hex>` (exclusive create, fsync) and rename over the target; when
 *      the rename is refused for a sharing/permission reason (EPERM/EBUSY/EACCES after the retries, or an EEXIST
 *      staging collision) rewrite the target in place instead — losing the rotated single-use refresh token
 *      would force every Claude Code process to /login. Never in place on ENOSPC/EIO (would truncate the file);
 *   6. release the lock (always, in finally).
 *
 * `writeOptions` (tests) is spread into writeJsonAtomic (`fs`, `sleep`, …); its `fs` is also used for the
 * in-place fallback.
 *
 * Returns { ok: true, oauth, credentials, account?, persisted?, inPlace?, rotatedByOther? } or
 *         { ok: false, permanent, error: { code, message, status? }, lockHeld?: true }.
 * `lockHeld` (code 'lock_held') means "someone else is refreshing right now — try next cycle"; callers
 * should not count it as a failure. `persisted: false` means both write paths failed: the fresh tokens live
 * only in memory for this cycle.
 */
async function refreshClaudeTokens({
  fetch, credentialsPath, now = Date.now, expectedRefreshToken = null, expectedAccessToken = null, log = noop,
  timeoutMs = REFRESH_TIMEOUT_MS, userAgent = 'ai-usage-widget', tokenUrls = CLAUDE_TOKEN_URLS,
  lockPath = null, lock = true, lockOptions = {}, writeOptions = {},
} = {}) {
  let file;
  try {
    file = await readJsonText(credentialsPath);
  } catch (e) {
    return transient(e.code === 'parse' ? 'parse' : 'read_failed', e.message);
  }
  const creds = file && file.data;
  const oauth = claudeOauthOf(creds);
  if (!oauth || !oauth.refreshToken) return permanentFail('no_refresh_token', 'Claude credentials have no refresh token — run `claude` and log in again.');

  // Guard (b): never burn a single-use refresh token that is not the one on disk any more.
  if (expectedRefreshToken && oauth.refreshToken !== expectedRefreshToken) {
    log('[claude] credentials changed since load — using the other process\'s tokens');
    return { ok: true, oauth, credentials: creds, rotatedByOther: true };
  }
  if (expectedAccessToken && oauth.accessToken && oauth.accessToken !== expectedAccessToken) {
    log('[claude] another process already refreshed — using its access token');
    return { ok: true, oauth, credentials: creds, rotatedByOther: true };
  }

  let held = null;
  if (lock) {
    const lp = lockPath || path.join(path.dirname(credentialsPath), CLAUDE_LOCK_NAME);
    held = await acquireLock(lp, { now, log, ...lockOptions });
    if (!held.ok) {
      if (held.reason === 'held') {
        log(`[claude] refresh lock held by another process after ${held.attempts} attempt(s) — giving up this cycle`);
        return { ok: false, permanent: false, lockHeld: true, error: { code: 'lock_held', message: 'Another process is refreshing the Claude token' } };
      }
      log(`[claude] could not create the refresh lock (${held.error && held.error.code}) — giving up this cycle`);
      return { ok: false, permanent: false, lockHeld: true, error: { code: 'lock_error', message: `Could not create the refresh lock (${held.error && held.error.code || 'error'})` } };
    }
  }

  try {
    // Under the lock: the winner of a concurrent refresh may have landed already.
    let latest = creds;
    try {
      const again = await readJsonText(credentialsPath);
      if (again && again.data) latest = again.data;
    } catch { /* keep the copy we have */ }
    const current = claudeOauthOf(latest);
    if (current && ((current.accessToken && oauth.accessToken && current.accessToken !== oauth.accessToken) || (current.refreshToken && current.refreshToken !== oauth.refreshToken))) {
      log('[claude] another process landed fresh tokens while we waited for the lock — using those');
      return { ok: true, oauth: current, credentials: latest, rotatedByOther: true };
    }
    const rt = oauth.refreshToken;
    const scopes = Array.isArray(oauth.scopes) && oauth.scopes.length ? oauth.scopes.filter((s) => typeof s === 'string' && s) : CLAUDE_DEFAULT_SCOPES;

    let lastTransient = null;
    let res = null; let text = null;
    for (const url of tokenUrls) {
      try {
        res = await fetchWithTimeout(fetch, url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': userAgent },
          body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: rt, client_id: CLAUDE_CLIENT_ID, scope: scopes.join(' ') }),
        }, timeoutMs);
      } catch (e) {
        lastTransient = transient('network', e && e.name === 'AbortError' ? 'Token refresh timed out' : `Token refresh network error: ${e && e.message}`);
        res = null;
        // Our deadline fired / the connection dropped mid-flight: the server may have processed the request and
        // consumed the single-use refresh token. Replaying it on the alias host would burn it (invalid_grant → the
        // user is sent to /login although a refresh may have succeeded). Only a failure before anything was sent
        // (DNS, refused, unreachable, TLS) moves on to the alias.
        if (requestMayHaveReachedServer(e)) break;
        continue; // try the next host
      }
      try {
        text = await res.text();
      } catch (e) {
        // The server answered (it may have consumed the single-use refresh token) but the body was cut off. Do NOT
        // replay the same token against the alias host; report a transient failure and let the back-off decide.
        lastTransient = transient('network', `Token refresh response could not be read: ${e && e.message}`);
        res = null;
        break;
      }
      if (res.ok) break;
      if (res.status === 404 || res.status === 405 || res.status >= 500) {
        lastTransient = { ok: false, permanent: false, error: { code: `http_${res.status}`, status: res.status, message: `Token refresh failed (HTTP ${res.status})` } };
        res = null;
        continue; // this host does not serve the endpoint (or is down) — try the alias
      }
      break; // definitive 4xx answer
    }
    if (!res) return lastTransient || transient('network', 'Token refresh failed');
    if (!res.ok) {
      const c = classifyRefreshFailure(res.status, text);
      log(`[claude] token refresh failed: HTTP ${res.status} ${c.error.code}${c.permanent ? ' (permanent)' : ''}`);
      return { ok: false, permanent: c.permanent, error: c.error };
    }
    let body;
    try { body = JSON.parse(text); } catch { return transient('parse', 'Token endpoint returned non-JSON'); }
    if (!body || typeof body.access_token !== 'string' || !body.access_token) {
      return permanentFail('no_access_token', 'Token endpoint returned no access token — log in to Claude Code again.');
    }

    // Re-read right before writing (the request took a while); a rotation in the meantime wins.
    let signedOut = false;
    try {
      const again = await readJsonText(credentialsPath);
      if (again === null) signedOut = true; // the file was removed while we were refreshing
      else latest = again.data;
    } catch { /* keep in-memory copy */ }
    if (!latest || typeof latest !== 'object' || Array.isArray(latest)) latest = {};
    const before = claudeOauthOf(latest) || {};
    if (signedOut || !before.refreshToken) {
      // The file (or its claudeAiOauth block — Claude Code's /logout) is gone: the user signed out during our request.
      // Never resurrect credentials the user just removed, even though the new tokens are valid.
      log('[claude] credentials were removed (logout) while the token was being refreshed — not writing the new tokens back');
      return permanentFail('signed_out', 'Claude Code was signed out while the token was being refreshed — run claude and log in again.');
    }
    if (before.refreshToken !== rt) {
      log('[claude] credentials rotated by another process during refresh — dropping our result');
      return { ok: true, oauth: before, credentials: latest, rotatedByOther: true };
    }
    const nowMs = now();
    const expiresIn = Number(body.expires_in);
    const target = {
      ...before,
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : rt,
      // Without expires_in we assume one hour so the next poll re-checks rather than looping on "expired".
      expiresAt: nowMs + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600 * 1000),
    };
    const rtExpiresIn = Number(body.refresh_token_expires_in);
    if (Number.isFinite(rtExpiresIn) && rtExpiresIn > 0) target.refreshTokenExpiresAt = nowMs + rtExpiresIn * 1000;
    if (typeof body.scope === 'string' && body.scope.trim()) target.scopes = body.scope.trim().split(/\s+/);
    const updated = { ...latest, claudeAiOauth: target };
    const account = body.account && typeof body.account === 'object' ? body.account : null;

    try {
      // Claude Code writes single-line JSON via `<target>.tmp.<8hex>` + rename; match it exactly.
      await writeJsonAtomic(credentialsPath, updated, { indent: 0, tmpPath: claudeTempPath, fsync: true, ...writeOptions });
      return { ok: true, oauth: target, credentials: updated, account, persisted: true };
    } catch (e) {
      // The refresh token was consumed server-side: if the rotated tokens never reach the disk, every Claude Code
      // process (and our next cycle) fails with invalid_grant and the user is forced to /login. When the atomic
      // path was refused for a sharing/permission reason (rename over a file someone holds open — the Windows
      // case), fall back to an in-place rewrite like Claude Code's own `inPlaceOnTempCreateRefused` arm. Never on
      // ENOSPC/EIO etc.: truncating the target there would destroy the credentials file.
      const code = e && e.code;
      if (code && (RENAME_RETRY_CODES.has(code) || code === 'EEXIST')) {
        const fsImpl = writeOptions.fs || fsp;
        try {
          await fsImpl.writeFile(credentialsPath, serializeJson(updated, 0), { mode: 0o600 });
          log(`[claude] atomic write-back refused (${code}); credentials rewritten in place instead`);
          return { ok: true, oauth: target, credentials: updated, account, persisted: true, inPlace: true };
        } catch (e2) {
          log(`[claude] WARNING: refreshed tokens could not be written back (${code}, then ${e2 && e2.code || e2 && e2.message})`);
          return { ok: true, oauth: target, credentials: updated, account, persisted: false, error: { code: 'write_failed', message: e2 && e2.message } };
        }
      }
      log(`[claude] WARNING: refreshed tokens could not be written back (${code || e && e.message})`);
      return { ok: true, oauth: target, credentials: updated, account, persisted: false, error: { code: 'write_failed', message: e && e.message } };
    }
  } finally {
    if (held && held.ok) {
      await held.release();
      log('[claude] released refresh lock');
    }
  }
}

// ---------------------------------------------------------------------------
// Backoff (the only stateful thing here, and callers own the instance)
// ---------------------------------------------------------------------------

/**
 * createBackoff({ baseMs = 60 s, maxMs = 30 min, permanentMs = 30 min, steps = null })
 * Transient failures double the wait 1 → 2 → 4 … → 30 min; a permanent failure parks retries
 * for `permanentMs`. `reset()` after any success.
 * `steps` (ms[]) replaces the doubling with a fixed schedule — the Nth failure waits steps[N-1],
 * the last entry repeats (Claude: [60 s, 30 min] = "retry once after 60 s, then back off 30 min").
 */
function createBackoff({ baseMs = 60000, maxMs = 30 * 60000, permanentMs = 30 * 60000, steps = null } = {}) {
  let failures = 0;
  let nextAllowedAt = 0;
  let permanent = false;
  let lastError = null;
  const schedule = Array.isArray(steps) && steps.length ? steps : null;
  return {
    shouldSkip(nowMs) { return nowMs < nextAllowedAt; },
    remainingMs(nowMs) { return Math.max(0, nextAllowedAt - nowMs); },
    recordFailure(nowMs, { permanent: isPermanent = false, error = null } = {}) {
      lastError = error;
      if (isPermanent) {
        permanent = true;
        nextAllowedAt = nowMs + permanentMs;
      } else {
        failures += 1;
        const wait = schedule ? schedule[Math.min(failures, schedule.length) - 1] : Math.min(baseMs * 2 ** (failures - 1), maxMs);
        nextAllowedAt = nowMs + wait;
      }
    },
    reset() { failures = 0; nextAllowedAt = 0; permanent = false; lastError = null; },
    state() { return { failures, nextAllowedAt, permanent, lastError }; },
  };
}

module.exports = {
  decodeJwt,
  jwtExpiryMs,
  readJsonFile,
  readJsonText,
  sanitizeJsonError,
  fileMtimeMs,
  isLapsed,
  refreshGate,
  writeJsonAtomic,
  detectIndent,
  refreshCodexTokens,
  refreshClaudeTokens,
  classifyRefreshFailure,
  createBackoff,
  fetchWithTimeout,
  requestMayHaveReachedServer,
  retryAfterMs,
  hhmm,
  acquireLock,
  claudeTempPath,
  CODEX_TOKEN_URL,
  CODEX_CLIENT_ID,
  CLAUDE_TOKEN_URLS,
  CLAUDE_CLIENT_ID,
  CLAUDE_DEFAULT_SCOPES,
  CLAUDE_LOCK_NAME,
  LOCK_STALE_MS,
  LOCK_TOTAL_WAIT_MS,
};
