'use strict';

/**
 * codex.js — Codex provider: ~/.codex/auth.json → GET https://chatgpt.com/backend-api/wham/usage
 *
 *   module.exports = { id: 'codex', name: 'Codex', source: 'codex_auth_file',
 *                      fetchSnapshot({ settings, fetch, now, log, lastGood, paths, timeoutMs }) → Promise<ProviderSnapshot>,
 *                      resetState(), … tunables }
 *
 * fetchSnapshot NEVER throws: every failure becomes `status` + `error` on the snapshot.
 * Test hooks: `paths.authPath` overrides the credential file; `fetch` and `now` are injected.
 *
 * Refresh policy — research-codex.md §3.3–3.5 and §7, aligned with the Claude provider (claude.js F2 / F4):
 *
 *   Who else writes   The Codex CLI and the Codex desktop app (an app-server child of the same CLI binary) share
 *   auth.json         ~/.codex/auth.json. Both refresh ≤ 5 min before the JWT `exp` (before every backend request,
 *                     or on a 401); refresh tokens ROTATE and the old one is single-use. A widget refreshing ahead
 *                     of expiry would race them and burn the token — the "false logout" hazard (openai/codex
 *                     #39925, #31459).
 *   Refresh           NEVER proactively before expiry. Trigger only once now ≥ exp + 60 s (the token has actually
 *                     lapsed) or on a real 401 where a re-read of auth.json still shows the token we sent (a changed
 *                     file → retry with theirs, no token call). Then only when (b) auth.json was written ≥ 30 s ago
 *                     (a younger file means the CLI/desktop is on it) and (c) this process made no refresh attempt
 *                     in the last 10 min. tokens.refreshCodexTokens owns the guarded reload (the refresh token on
 *                     disk must still be the one we loaded), the mid-flight rotation check and the atomic write.
 *   Failures          permanent (400 invalid_grant / refresh_token_*, 401) → auth_required, parked 30 min or until
 *                     auth.json changes (`codex login` recovers at once); transient (5xx / network) → stale, back
 *                     off 1 → 2 → 4 … 30 min; deferred (spacing, fresh file) → stale / token_expired "waiting".
 *   Inside the grace  a token close to expiry, or < 60 s past it, is used as-is.
 *   Etiquette         ≥ 30 s between real wham/usage requests regardless of settings.refreshInterval or a manual
 *                     refresh (sooner → the previous snapshot is returned unchanged).
 *
 * Module state (per process): request floor + last result, refresh spacing, refresh back-off, file signature at
 * the last refresh failure. Nothing here ever logs a token.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const tokens = require('./tokens');
const { normalizeCodex } = require('./normalize');

const id = 'codex';
const name = 'Codex';
const source = 'codex_auth_file';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const REQUEST_TIMEOUT_MS = 15000;
const USAGE_FLOOR_MS = 30 * 1000;               // never two real wham/usage requests inside 30 s
const EXPIRY_GRACE_MS = 60 * 1000;              // (a) refresh only once now ≥ exp + 60 s
const REFRESH_SPACING_MS = 10 * 60 * 1000;      // (c) at most one refresh attempt per 10 min
const FRESH_FILE_MS = 30 * 1000;                // (b) auth.json written < 30 s ago means the CLI/desktop is on it
const RATE_LIMIT_STEPS_MS = [1, 2, 4, 10].map((m) => m * 60 * 1000); // 429: honour Retry-After, else 1 → 2 → 4 → 10 min (research §Errors)
const RATE_LIMIT_MIN_MS = 60 * 1000;            // never retry a 429 inside 60 s (also floors Retry-After)
const RATE_LIMIT_MAX_MS = 24 * 60 * 60 * 1000;  // a Retry-After beyond a day is bogus — never park the widget for the rest of the process

const { hhmm, retryAfterMs } = tokens;

const SIGN_IN_MESSAGE = 'Sign in to Codex with ChatGPT to see usage';
const SIGN_IN_EXPIRED = 'Codex sign-in expired — run `codex login` to sign in again';
const TOKEN_REJECTED = 'Codex rejected the token — sign in with `codex login`';
const WAITING_PREFIX = 'Codex token expired — waiting for Codex to refresh it';

let pkgVersion = '0.0.0';
try { pkgVersion = require('../../../package.json').version || pkgVersion; } catch { /* tests may run from elsewhere */ }
const PLATFORM = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
const USER_AGENT = `ai-usage-widget/${pkgVersion} (${PLATFORM})`; // truthful UA — never impersonate codex_cli_rs

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

function freshState() {
  return {
    lastUsageRequestAt: 0,        // request floor
    lastResult: null,             // returned again while the floor is active
    rateLimit: { until: 0, step: 0 }, // 429 park: no wham/usage request before `until`
    lastRefreshAttemptAt: 0,      // (c) spacing
    refreshBackoff: tokens.createBackoff(), // transient 1 → 2 → 4 … 30 min; permanent parks 30 min (research §3.3)
    refreshFileSig: null,         // { refreshKey, mtimeMs } at the last refresh failure — a changed auth.json releases it
  };
}
let state = freshState();

/** Test hook — clears every per-process guard. */
function resetState() {
  state = freshState();
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function defaultAuthPath() {
  const home = process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
    ? process.env.CODEX_HOME.trim()
    : path.join(os.homedir(), '.codex');
  return path.join(home, 'auth.json');
}

/** Short hash so a token never sits in module state / debug dumps. */
function tokenKey(token) {
  return crypto.createHash('sha256').update(String(token == null ? '' : token)).digest('hex').slice(0, 16);
}

/** Build a ProviderSnapshot; failed cycles carry the last good values (status stale/auth_required). */
function makeSnapshot({ status, error = null, plan = null, account = null, updatedAt = 0, windows = [], credits = null, raw = null, skipNextCycle = false }) {
  const snap = { id, name, status, error, source, plan, account, updatedAt, windows, extra: null, credits, raw: raw || {} };
  if (skipNextCycle) snap.skipNextCycle = true;
  return snap;
}

function failure(code, message, { lastGood, authRequired = false, raw = null, skipNextCycle = false }) {
  const hasLastGood = Boolean(lastGood && Array.isArray(lastGood.windows) && lastGood.windows.length);
  const status = authRequired ? 'auth_required' : hasLastGood ? 'stale' : 'error';
  return makeSnapshot({
    status,
    error: { code, message },
    plan: hasLastGood ? lastGood.plan : null,
    account: hasLastGood ? lastGood.account : null,
    updatedAt: hasLastGood ? lastGood.updatedAt : 0,
    windows: hasLastGood ? lastGood.windows : [],
    credits: hasLastGood ? lastGood.credits : null,
    raw,
    skipNextCycle,
  });
}

/** ChatGPT-login credentials we can use: auth_mode chatgpt (or absent) with a string access_token. */
function hasChatgptTokens(auth) {
  return Boolean(auth && typeof auth === 'object'
    && (!auth.auth_mode || auth.auth_mode === 'chatgpt')
    && auth.tokens && typeof auth.tokens === 'object'
    && typeof auth.tokens.access_token === 'string' && auth.tokens.access_token);
}

function accountIdFrom(auth) {
  const t = auth.tokens || {};
  if (typeof t.account_id === 'string' && t.account_id) return t.account_id;
  for (const jwt of [t.access_token, t.id_token]) {
    const claims = tokens.decodeJwt(jwt);
    const authClaim = claims && claims['https://api.openai.com/auth'];
    if (authClaim && typeof authClaim.chatgpt_account_id === 'string') return authClaim.chatgpt_account_id;
  }
  return null;
}

/** Read + stat auth.json. Throws readJsonFile's errors (code 'parse' / fs codes); mtime is null when unknown. */
async function readAuth(authPath) {
  const auth = await tokens.readJsonFile(authPath);
  const mtimeMs = await tokens.fileMtimeMs(authPath);
  return { auth, mtimeMs };
}

async function getUsage(fetch, accessToken, accountId, timeoutMs) {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': USER_AGENT };
  if (accountId) headers['ChatGPT-Account-Id'] = accountId; // undici would send the literal "undefined" otherwise
  return tokens.fetchWithTimeout(fetch, USAGE_URL, { method: 'GET', headers }, timeoutMs);
}

/** Short human message from an error body without echoing anything sensitive. */
function bodyMessage(text, fallback) {
  try {
    const j = JSON.parse(text);
    const m = j && (j.detail || (j.error && (j.error.message || j.error)) || j.message);
    if (typeof m === 'string' && m.length < 200) return m;
  } catch { /* not JSON */ }
  return fallback;
}

// ---------------------------------------------------------------------------
// Guarded refresh
// ---------------------------------------------------------------------------

/** Earliest moment a refresh may be attempted: the back-off AND the 10-min spacing must both allow it. */
function nextRefreshAllowedAt() {
  const fromBackoff = state.refreshBackoff.state().nextAllowedAt;
  const fromSpacing = state.lastRefreshAttemptAt ? state.lastRefreshAttemptAt + REFRESH_SPACING_MS : 0;
  return Math.max(fromBackoff, fromSpacing);
}
function minutesUntil(atMs, nowMs) {
  return Math.max(1, Math.ceil((atMs - nowMs) / 60000));
}

/**
 * Decide whether we may refresh right now and, if so, do it through tokens.refreshCodexTokens (which owns the
 * guarded reload, the mid-flight rotation check and the atomic write-back).
 *
 * Returns { ok: true, auth } or { ok: false, kind: 'permanent'|'transient'|'deferred', code, message }.
 *   permanent → auth_required (user must run `codex login`)
 *   transient → stale, retried after the back-off
 *   deferred  → stale, retried next cycle (the CLI/desktop just wrote the file, or attempt spacing)
 */
async function guardedRefresh({ auth, mtimeMs, authPath, fetch, now, log, reason }) {
  const nowMs = now();
  const backoff = state.refreshBackoff;
  if (backoff.shouldSkip(nowMs)) {
    const st = backoff.state();
    if (st.permanent) {
      return { ok: false, kind: 'permanent', code: 'refresh_failed', message: `${SIGN_IN_EXPIRED} (refresh token rejected)` };
    }
    return { ok: false, kind: 'transient', code: 'refresh_failed', message: `Codex token refresh failed; retrying in ${minutesUntil(nextRefreshAllowedAt(), nowMs)} min` };
  }
  // (b) fresh file / (c) attempt spacing.
  const gate = tokens.refreshGate({ nowMs, lastAttemptAt: state.lastRefreshAttemptAt, spacingMs: REFRESH_SPACING_MS, mtimeMs, freshFileMs: FRESH_FILE_MS });
  if (!gate.ok) {
    const why = gate.reason === 'spacing'
      ? `next attempt in ${minutesUntil(nextRefreshAllowedAt(), nowMs)} min`
      : 'auth.json was just written';
    return { ok: false, kind: 'deferred', code: 'token_expired', message: `${WAITING_PREFIX} (${why})` };
  }

  log(`[codex] refreshing token (${reason})`);
  const previousAttemptAt = state.lastRefreshAttemptAt;
  state.lastRefreshAttemptAt = nowMs;
  const r = await tokens.refreshCodexTokens({ fetch, authPath, now, log, expectedRefreshToken: auth.tokens.refresh_token, userAgent: USER_AGENT });
  if (r.ok) {
    if (r.rotatedByOther) state.lastRefreshAttemptAt = previousAttemptAt; // the other process refreshed; we made no token call
    backoff.reset();
    state.refreshFileSig = null;
    return { ok: true, auth: r.auth };
  }
  backoff.recordFailure(nowMs, { permanent: r.permanent, error: r.error });
  state.refreshFileSig = { refreshKey: tokenKey(auth.tokens.refresh_token), mtimeMs };
  if (r.permanent) {
    log(`[codex] refresh token rejected (${r.error && r.error.code}); parking refresh attempts until auth.json changes`);
    return { ok: false, kind: 'permanent', code: 'refresh_failed', message: SIGN_IN_EXPIRED };
  }
  return { ok: false, kind: 'transient', code: 'refresh_failed', message: `Codex token refresh failed (${r.error && r.error.code}); retrying in ${minutesUntil(nextRefreshAllowedAt(), nowMs)} min` };
}

function refreshFailureSnapshot(r, ctx) {
  if (r.kind === 'permanent') return failure(r.code, r.message, { ...ctx, authRequired: true });
  return failure(r.code, r.message, ctx); // transient / deferred keep last good (stale)
}

// ---------------------------------------------------------------------------
// fetchSnapshot
// ---------------------------------------------------------------------------

async function fetchSnapshot(args = {}) {
  const snap = await fetchSnapshotInner(args || {});
  state.lastResult = snap;
  return snap;
}

async function fetchSnapshotInner({ settings, fetch = globalThis.fetch, now = Date.now, log = () => {}, lastGood = null, paths, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  settings = settings || {}; // default params do not cover an explicit null
  paths = paths || {};
  const authPath = paths.authPath || defaultAuthPath();
  const autoRefresh = settings.tokenAutoRefresh !== false;
  const ctx = { lastGood };

  try {
    const nowMs = now();

    // 0. Per-process request floor. Manual refreshes go through here too.
    if (state.lastUsageRequestAt && nowMs - state.lastUsageRequestAt < USAGE_FLOOR_MS) {
      if (typeof log.debug === 'function') log.debug(`[codex] inside the ${USAGE_FLOOR_MS / 1000} s request floor (${Math.round((nowMs - state.lastUsageRequestAt) / 1000)} s since the last request) - returning the previous snapshot`);
      if (state.lastResult) {
        const { skipNextCycle, ...previous } = state.lastResult; // the scheduler hint belongs to the cycle that saw the 429
        return previous;
      }
      if (lastGood && Array.isArray(lastGood.windows) && lastGood.windows.length) return { ...lastGood, status: 'ok', error: null };
      return failure('network', 'Waiting for the next Codex poll', ctx);
    }
    // 0b. Rate-limit park: no request (and no token refresh) until the back-off has elapsed.
    if (nowMs < state.rateLimit.until) {
      return failure('http_429', `Codex rate limited, retrying at ${hhmm(state.rateLimit.until)}`, ctx);
    }

    // 1. Read credentials (+ mtime) on EVERY poll — the CLI/desktop may have rotated them.
    let auth; let mtimeMs;
    try {
      ({ auth, mtimeMs } = await readAuth(authPath));
    } catch (e) {
      if (e && e.code === 'parse') return failure('parse', 'Codex auth.json is not valid JSON', ctx);
      return failure('no_credentials', `Cannot read Codex auth.json (${e && e.code || 'error'})`, { ...ctx, authRequired: true });
    }
    if (!auth || !hasChatgptTokens(auth)) return failure('no_credentials', SIGN_IN_MESSAGE, { ...ctx, authRequired: true });

    // 1b. A changed auth.json (new refresh token or rewritten file) releases a refresh park — `codex login` recovers at once.
    if (state.refreshFileSig && (state.refreshFileSig.refreshKey !== tokenKey(auth.tokens.refresh_token) || state.refreshFileSig.mtimeMs !== mtimeMs)) {
      log('[codex] auth.json changed since the last refresh failure - back-off released');
      state.refreshBackoff.reset();
      state.refreshFileSig = null;
    }

    const refreshArgs = { authPath, fetch, now, log };

    // 2. Expiry (a): only a token that has actually lapsed (+60 s grace) triggers a refresh. A token that is
    //    merely close to expiry is used as-is — the CLI/desktop refreshes 5 min ahead and would race us.
    const expMs = tokens.jwtExpiryMs(auth.tokens.access_token);
    if (tokens.isLapsed(expMs, nowMs, EXPIRY_GRACE_MS)) {
      if (!autoRefresh) {
        return failure('token_expired', 'Codex token expired — enable token auto-refresh or run `codex login`', { ...ctx, authRequired: true });
      }
      const r = await guardedRefresh({ ...refreshArgs, auth, mtimeMs, reason: 'token lapsed' });
      if (!r.ok) return refreshFailureSnapshot(r, ctx);
      auth = r.auth;
    }

    // 3. Usage request.
    const request = async () => {
      state.lastUsageRequestAt = now();
      if (typeof log.debug === 'function') log.debug('[codex] GET wham/usage');
      return getUsage(fetch, auth.tokens.access_token, accountIdFrom(auth), timeoutMs);
    };
    const networkFailure = (e) => failure('network', e && e.name === 'AbortError' ? 'Codex request timed out' : `Network error: ${e && e.message}`, ctx);
    let res;
    try {
      res = await request();
    } catch (e) {
      return networkFailure(e);
    }

    // 3b. 401 — may arrive before the local exp. Re-read; retry with a changed token; else refresh once (guarded).
    if (res.status === 401) {
      let again = null;
      try { again = await readAuth(authPath); } catch { /* fall through to refresh */ }
      const fresh = again && hasChatgptTokens(again.auth) ? again.auth : null;
      if (fresh && fresh.tokens.access_token !== auth.tokens.access_token) {
        log('[codex] 401 but auth.json changed - retrying with the new token');
        auth = fresh;
        mtimeMs = again.mtimeMs;
      } else if (autoRefresh) {
        const r = await guardedRefresh({ ...refreshArgs, auth, mtimeMs: again ? again.mtimeMs : mtimeMs, reason: 'usage request returned 401' });
        if (!r.ok) return refreshFailureSnapshot(r, ctx);
        auth = r.auth;
      } else {
        return failure('http_401', TOKEN_REJECTED, { ...ctx, authRequired: true });
      }
      try {
        res = await request();
      } catch (e) {
        return networkFailure(e);
      }
    }

    let text;
    try {
      text = await res.text();
    } catch (e) {
      return networkFailure(e);
    }
    if (res.status === 401) return failure('http_401', TOKEN_REJECTED, { ...ctx, authRequired: true });
    if (res.status === 403) return failure('http_403', bodyMessage(text, 'Codex denied access to usage (HTTP 403)'), { ...ctx, authRequired: true });
    if (res.status === 429) {
      // Honour Retry-After (floored at 60 s, capped at a day), else back off 1 → 2 → 4 → 10 min. Without a park the
      // 30 s floor alone would keep hammering a rate-limited endpoint every 30 s.
      const requestedAt = state.lastUsageRequestAt || nowMs;
      const step = state.rateLimit.step;
      const fromHeader = retryAfterMs(res, requestedAt);
      const delay = Math.min(RATE_LIMIT_MAX_MS, Math.max(RATE_LIMIT_MIN_MS, fromHeader != null ? fromHeader : RATE_LIMIT_STEPS_MS[Math.min(step, RATE_LIMIT_STEPS_MS.length - 1)]));
      state.rateLimit = { until: requestedAt + delay, step: step + 1 };
      log(`[codex] rate limited (HTTP 429${fromHeader != null ? ', Retry-After honoured' : ''}); next attempt at ${hhmm(state.rateLimit.until)}`);
      return failure('http_429', `Codex rate limited, retrying at ${hhmm(state.rateLimit.until)}`, { ...ctx, skipNextCycle: true });
    }
    if (res.status >= 500) return failure('http_5xx', `Codex service error (HTTP ${res.status})`, ctx);
    if (!res.ok) return failure('http_5xx', `Unexpected HTTP ${res.status} from Codex`, ctx);

    let usage;
    try { usage = JSON.parse(text); } catch { return failure('parse', 'Codex returned non-JSON usage data', ctx); }
    if (!usage || typeof usage !== 'object') return failure('parse', 'Codex returned an unexpected payload', ctx);
    state.rateLimit = { until: 0, step: 0 };

    const norm = normalizeCodex({ usage, now });
    return makeSnapshot({
      status: 'ok',
      plan: norm.plan,
      account: norm.account,
      updatedAt: now(),
      windows: norm.windows,
      credits: norm.credits,
      raw: { usage },
    });
  } catch (e) {
    // Belt and braces: the contract says errors never escape.
    log(`[codex] unexpected error: ${e && e.message}`);
    return failure('network', `Unexpected error: ${e && e.message}`, ctx);
  }
}

module.exports = {
  id,
  name,
  source,
  fetchSnapshot,
  resetState,
  USAGE_URL,
  USER_AGENT,
  defaultAuthPath,
  // tunables (exported for tests / docs)
  USAGE_FLOOR_MS,
  EXPIRY_GRACE_MS,
  REFRESH_SPACING_MS,
  FRESH_FILE_MS,
  RATE_LIMIT_STEPS_MS,
  RATE_LIMIT_MIN_MS,
  RATE_LIMIT_MAX_MS,
  SIGN_IN_MESSAGE,
  SIGN_IN_EXPIRED,
  hhmm,
  // test hook
  _state: () => state,
};
