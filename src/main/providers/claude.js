'use strict';

/**
 * claude.js — Claude provider via Claude Code credentials:
 *   ~/.claude/.credentials.json (claudeAiOauth) → GET https://api.anthropic.com/api/oauth/usage
 *                                                (+ /api/oauth/profile at most once per hour,
 *                                                 + /api/oauth/organizations/<org>/prepaid/credits at most
 *                                                   once per 5 min when the spend panel is open / first fill)
 *
 *   module.exports = { id: 'claude', name: 'Claude', source: 'claude_code',
 *                      fetchSnapshot({ settings, fetch, now, log, lastGood, paths, timeoutMs }) → Promise<ProviderSnapshot>,
 *                      resetState(), getUserAgent(), setCliVersion(v), … }
 *
 * fetchSnapshot NEVER throws. Test hooks: `paths.credentialsPath`, `paths.lockPath`, `lockOptions`, injected
 * `fetch` / `now`, `setCliVersion()` (skips running `claude --version`).
 *
 * The rules below come from research-claude.md (§1.3, §1.8, §1.9, §2.1–2.4, §8.5) and are binding:
 *
 *   Headers    Claude Code's own UA `claude-cli/<version> (external, cli)` (version detected once per process
 *              from `claude --version`, fallback 2.1.263), `anthropic-beta: oauth-2025-04-20`, Accept + Content-Type
 *              application/json. Without a Claude-like UA the token lands in an aggressively rate-limited bucket.
 *   Etiquette  ≥ 60 s between real /usage requests regardless of settings.refreshInterval (sooner → last result);
 *              429 → honour Retry-After, else 5 → 10 → 20 → 30 min, never inside 60 s, keep last good (stale).
 *   Refresh    NEVER proactively before expiry — Claude Code refreshes 4 min ahead and refresh tokens are
 *              single-use. Trigger only once now ≥ expiresAt + 60 s or on a real 401, and only when (b) the file
 *              still holds the refresh token we loaded, (c) refreshTokenExpiresAt is in the future, (d) we made no
 *              refresh attempt in the last 10 min, (e) the file's mtime is ≥ 30 s old and Claude Code's
 *              `.oauth_refresh.lock` is free. Under the lock re-read; if someone else refreshed, use theirs.
 *              invalid_grant → park 24 h or until the file changes; network/5xx → retry after 60 s, then 30 min.
 *   In-band    a 200 whose body has none of the known usage keys is a failure (code parse), last good kept.
 *   401        can arrive before local expiresAt: re-read the file → retry once if the token changed → else
 *              refresh (rules above) → retry once → else auth_required.
 *   403        scope problem (setup-token) → auth_required http_403; no retry until the credentials change.
 *
 * Module state (per process): request floor, rate-limit park, refresh back-off / spacing, 403 park, profile
 * cache, prepaid-credits cache, detected CLI version. Nothing here ever logs a token.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { exec } = require('node:child_process');
const tokens = require('./tokens');
const { normalizeClaude } = require('./normalize');

const id = 'claude';
const name = 'Claude';
const source = 'claude_code';

const API_BASE = 'https://api.anthropic.com';
const USAGE_URL = `${API_BASE}/api/oauth/usage`;
const PROFILE_URL = `${API_BASE}/api/oauth/profile`;
function creditsUrl(orgUuid) {
  return `${API_BASE}/api/oauth/organizations/${encodeURIComponent(String(orgUuid))}/prepaid/credits`;
}

const REQUEST_TIMEOUT_MS = 15000;
const PROFILE_TTL_MS = 60 * 60 * 1000;          // /profile at most once per hour (per token)
const CREDITS_TTL_MS = 5 * 60 * 1000;           // /prepaid/credits at most once per 5 min
const USAGE_FLOOR_MS = 60 * 1000;               // F4: never two real /usage requests inside 60 s
const EXPIRY_GRACE_MS = 60 * 1000;              // F2 (a): refresh only once now ≥ expiresAt + 60 s
const REFRESH_SPACING_MS = 10 * 60 * 1000;      // F2 (d): at most one refresh attempt per 10 min
const FRESH_FILE_MS = 30 * 1000;                // F2 (e): a file written < 30 s ago means Claude Code is on it
const RATE_LIMIT_STEPS_MS = [5, 10, 20, 30].map((m) => m * 60 * 1000); // F4: 429 schedule (cap 30 min)
const RATE_LIMIT_MIN_MS = 60 * 1000;            // F4: never retry a 429 inside 60 s (also floors Retry-After)
const RATE_LIMIT_MAX_MS = 24 * 60 * 60 * 1000;  // F4: a Retry-After beyond a day is bogus — never park the widget for the rest of the process
const PROFILE_RETRY_MS = 5 * 60 * 1000;         // a failed /profile attempt is not retried for 5 min (never once per poll)
const TRANSIENT_REFRESH_STEPS_MS = [60 * 1000, 30 * 60 * 1000]; // F1: retry once after 60 s, then 30 min
const PERMANENT_REFRESH_PARK_MS = 24 * 60 * 60 * 1000;          // F1: invalid_grant → 24 h (or file change)

const CLI_VERSION_FALLBACK = '2.1.263';
const CLI_VERSION_TIMEOUT_MS = 3000;
const CLI_VERSION_COMMAND = 'claude --version';

/** A 200 body without ANY of these is an in-band error (Claude Code's own check, research §1.9). */
const USAGE_PAYLOAD_KEYS = ['five_hour', 'seven_day', 'seven_day_oauth_apps', 'seven_day_opus', 'seven_day_sonnet', 'cinder_cove', 'extra_usage', 'limits'];

const SIGN_IN_EXPIRED = 'Claude Code sign-in expired - run claude to sign in again';
const SCOPE_MESSAGE = 'Claude token lacks the user:profile scope (setup-token credentials cannot read usage) - run claude and log in again';
const WAITING_PREFIX = 'Claude token expired - waiting for Claude Code to refresh it';

// ---------------------------------------------------------------------------
// User-Agent (research §1.3): look like Claude Code, version detected once per process
// ---------------------------------------------------------------------------

function userAgentFor(version) {
  return `claude-cli/${version} (external, cli)`;
}

/** First semver in `claude --version` output ("2.1.263 (Claude Code)" → "2.1.263"). */
function parseCliVersion(text) {
  const m = String(text == null ? '' : text).match(/\b(\d+\.\d+\.\d+)\b/);
  return m ? m[1] : null;
}

/** Runs the installed CLI once; never rejects, never takes longer than ~timeoutMs. */
function detectCliVersion({ exec: execImpl = exec, timeoutMs = CLI_VERSION_TIMEOUT_MS, command = CLI_VERSION_COMMAND } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v || CLI_VERSION_FALLBACK); } };
    // exec's own `timeout` kills the child; the extra timer guards an exec implementation that never calls back.
    const guard = setTimeout(() => finish(null), timeoutMs + 500);
    if (typeof guard.unref === 'function') guard.unref();
    try {
      execImpl(command, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
        clearTimeout(guard);
        finish(parseCliVersion(stdout) || parseCliVersion(stderr));
      });
    } catch {
      clearTimeout(guard);
      finish(null);
    }
  });
}

let cliVersionPromise = null;
function getCliVersion() {
  if (!cliVersionPromise) cliVersionPromise = detectCliVersion().catch(() => CLI_VERSION_FALLBACK);
  return cliVersionPromise;
}
async function getUserAgent() {
  return userAgentFor(await getCliVersion());
}
/** Test / override hook: pin the CLI version instead of running `claude --version`. */
function setCliVersion(version) {
  cliVersionPromise = Promise.resolve(parseCliVersion(version) || CLI_VERSION_FALLBACK);
}
const USER_AGENT_FALLBACK = userAgentFor(CLI_VERSION_FALLBACK);

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

function freshState() {
  return {
    lastUsageRequestAt: 0,        // F4 floor
    lastResult: null,             // returned again while the floor is active
    rateLimit: { until: 0, step: 0 },
    lastRefreshAttemptAt: 0,      // F2 (d)
    refreshBackoff: tokens.createBackoff({ steps: TRANSIENT_REFRESH_STEPS_MS, permanentMs: PERMANENT_REFRESH_PARK_MS }),
    refreshFileSig: null,         // { refreshKey, mtimeMs } at the last refresh failure — a change releases the back-off
    forbidden: null,              // { key, mtimeMs, message } — 403 scope park until the credentials change
    profileCache: { key: null, fetchedAt: 0, profile: null, retryAt: 0 },
    creditsCache: { orgUuid: null, fetchedAt: 0, payload: null },
  };
}
let state = freshState();

/** Test hook — clears every per-process guard except the detected CLI version. */
function resetState() {
  state = freshState();
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function defaultConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim()
    ? process.env.CLAUDE_CONFIG_DIR.trim()
    : path.join(os.homedir(), '.claude');
}
function defaultCredentialsPath() {
  return path.join(defaultConfigDir(), '.credentials.json');
}
function lockPathFor(credentialsPath) {
  return path.join(path.dirname(credentialsPath), tokens.CLAUDE_LOCK_NAME);
}

/** Short hash so a token never sits in module state / debug dumps. */
function tokenKey(token) {
  return crypto.createHash('sha256').update(String(token == null ? '' : token)).digest('hex').slice(0, 16);
}

/** Local wall-clock "HH:MM" for user-facing retry times / Retry-After parsing — shared with the Codex provider. */
const { hhmm, retryAfterMs } = tokens;

function makeSnapshot({ status, error = null, plan = null, account = null, updatedAt = 0, windows = [], extra = null, raw = null, skipNextCycle = false }) {
  const snap = { id, name, status, error, source, plan, account, updatedAt, windows, extra, credits: null, raw: raw || {} };
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
    extra: hasLastGood ? lastGood.extra : null,
    raw,
    skipNextCycle,
  });
}

function headersFor(accessToken, userAgent) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'anthropic-beta': 'oauth-2025-04-20',
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': userAgent,
  };
}

function bodyMessage(text, fallback) {
  try {
    const j = JSON.parse(text);
    const m = j && j.error && (typeof j.error === 'string' ? j.error : j.error.message);
    if (typeof m === 'string' && m.length < 200) return m;
  } catch { /* not JSON */ }
  return fallback;
}

function looksLikeUsage(usage) {
  return Boolean(usage && typeof usage === 'object' && !Array.isArray(usage)
    && USAGE_PAYLOAD_KEYS.some((k) => Object.prototype.hasOwnProperty.call(usage, k)));
}

function oauthOf(creds) {
  return creds && creds.claudeAiOauth && typeof creds.claudeAiOauth === 'object' ? creds.claudeAiOauth : null;
}

/** Read + stat the credentials file. Throws readJsonFile's errors (code 'parse' / fs codes). */
async function readCredentials(credentialsPath) {
  const creds = await tokens.readJsonFile(credentialsPath);
  let mtimeMs = null;
  try {
    mtimeMs = (await fsp.stat(credentialsPath)).mtimeMs;
  } catch { /* file vanished or unreadable — treated as unknown age */ }
  return { creds, oauth: oauthOf(creds), mtimeMs };
}

function debugLog(log, message) {
  if (log && typeof log.debug === 'function') log.debug(message);
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

function getUsage(fetch, accessToken, userAgent, timeoutMs) {
  return tokens.fetchWithTimeout(fetch, USAGE_URL, { method: 'GET', headers: headersFor(accessToken, userAgent) }, timeoutMs);
}

/**
 * /api/oauth/profile, cached for an hour per token. Never fatal — plan/account/org are cosmetic. A failed attempt
 * (403 for setup tokens, 429, 5xx, timeout) keeps the previous values and is not retried for 5 min — never once per
 * poll, which would hit the endpoint every 60 s while it is failing.
 */
async function getProfile({ fetch, accessToken, userAgent, now, log, timeoutMs }) {
  const key = tokenKey(accessToken);
  const nowMs = now();
  const cache = state.profileCache;
  const sameToken = cache.key === key;
  if (sameToken && (nowMs - cache.fetchedAt < PROFILE_TTL_MS || nowMs < (cache.retryAt || 0))) return cache.profile;
  const keepPrevious = () => {
    state.profileCache = { key, fetchedAt: sameToken ? cache.fetchedAt : 0, profile: sameToken ? cache.profile : null, retryAt: nowMs + PROFILE_RETRY_MS };
    return state.profileCache.profile;
  };
  try {
    const res = await tokens.fetchWithTimeout(fetch, PROFILE_URL, { method: 'GET', headers: headersFor(accessToken, userAgent) }, timeoutMs);
    if (!res.ok) {
      log(`[claude] profile request returned HTTP ${res.status}; retrying in ${PROFILE_RETRY_MS / 60000} min`);
      return keepPrevious();
    }
    const profile = await res.json();
    state.profileCache = { key, fetchedAt: nowMs, profile: profile && typeof profile === 'object' ? profile : null, retryAt: 0 };
    return state.profileCache.profile;
  } catch (e) {
    log(`[claude] profile request failed: ${e && e.message}; retrying in ${PROFILE_RETRY_MS / 60000} min`);
    return keepPrevious();
  }
}

/**
 * Prepaid credits over OAuth (research §1.7). Fetched at most once per 5 min and only when the Claude expand
 * panel is open, the compact spend row is open, or nothing has been fetched yet (first fill). Failures are
 * non-fatal: the previous payload is kept and the failure only logged at debug level.
 */
async function getCredits({ fetch, accessToken, userAgent, orgUuid, settings, now, log, timeoutMs }) {
  if (!orgUuid) return state.creditsCache.orgUuid ? state.creditsCache.payload : null;
  const nowMs = now();
  const cache = state.creditsCache;
  const sameOrg = cache.orgUuid === orgUuid;
  const cached = sameOrg ? cache.payload : null;
  const expanded = Boolean(settings.expandedOpen && settings.expandedOpen.claude === true);
  const compactSpend = Boolean(settings.compactMode && settings.compactSpendOpen);
  const firstFill = !cached;
  if (!expanded && !compactSpend && !firstFill) return cached;
  if (sameOrg && cache.fetchedAt && nowMs - cache.fetchedAt < CREDITS_TTL_MS) return cached;

  const remember = (payload) => { state.creditsCache = { orgUuid, fetchedAt: nowMs, payload }; return payload; };
  try {
    const res = await tokens.fetchWithTimeout(fetch, creditsUrl(orgUuid), { method: 'GET', headers: headersFor(accessToken, userAgent) }, timeoutMs);
    if (!res.ok) {
      debugLog(log, `[claude] prepaid credits request returned HTTP ${res.status}; keeping previous values`);
      return remember(cached);
    }
    const body = await res.json();
    if (!body || typeof body !== 'object' || !('amount' in body)) {
      debugLog(log, '[claude] prepaid credits payload unrecognised; keeping previous values');
      return remember(cached);
    }
    return remember(body);
  } catch (e) {
    debugLog(log, `[claude] prepaid credits request failed: ${e && e.message}; keeping previous values`);
    return remember(cached);
  }
}

// ---------------------------------------------------------------------------
// Guarded refresh (F1 + F2)
// ---------------------------------------------------------------------------

/**
 * Decide whether we may refresh right now and, if so, do it through tokens.refreshClaudeTokens (which owns the
 * lock, the under-lock re-read and the atomic write-back).
 *
 * Returns { ok: true, oauth } or { ok: false, kind: 'permanent'|'transient'|'deferred', code, message }.
 *   permanent → auth_required (user must sign in again)
 *   transient → stale, retried after the back-off
 *   deferred  → stale, retried next cycle (another process is/was refreshing, or spacing)
 */
/** Earliest moment a refresh may be attempted: the back-off AND the 10-min spacing must both allow it. */
function nextRefreshAllowedAt() {
  const fromBackoff = state.refreshBackoff.state().nextAllowedAt;
  const fromSpacing = state.lastRefreshAttemptAt ? state.lastRefreshAttemptAt + REFRESH_SPACING_MS : 0;
  return Math.max(fromBackoff, fromSpacing);
}
function minutesUntil(atMs, nowMs) {
  return Math.max(1, Math.ceil((atMs - nowMs) / 60000));
}

async function guardedRefresh({ oauth, mtimeMs, credentialsPath, lockPath, lockOptions, fetch, now, log, userAgent, reason }) {
  const nowMs = now();
  const backoff = state.refreshBackoff;
  if (backoff.shouldSkip(nowMs)) {
    const st = backoff.state();
    if (st.permanent) {
      return { ok: false, kind: 'permanent', code: 'refresh_failed', message: 'Claude sign-in expired - run claude to sign in again (refresh token rejected)' };
    }
    return { ok: false, kind: 'transient', code: 'refresh_failed', message: `Claude token refresh failed; retrying in ${minutesUntil(nextRefreshAllowedAt(), nowMs)} min` };
  }
  // (c) a refresh token past its own expiry cannot be redeemed — only a new sign-in helps.
  const rtExpiresAt = Number(oauth.refreshTokenExpiresAt);
  if (Number.isFinite(rtExpiresAt) && rtExpiresAt > 0 && nowMs >= rtExpiresAt) {
    return { ok: false, kind: 'permanent', code: 'token_expired', message: `${SIGN_IN_EXPIRED} (refresh token expired)` };
  }
  // (d) at most one attempt per 10 min from this process.
  if (state.lastRefreshAttemptAt && nowMs - state.lastRefreshAttemptAt < REFRESH_SPACING_MS) {
    return { ok: false, kind: 'deferred', code: 'token_expired', message: `${WAITING_PREFIX} (next attempt in ${minutesUntil(nextRefreshAllowedAt(), nowMs)} min)` };
  }
  // (e) a file written moments ago means a live Claude Code is (or just was) refreshing.
  if (mtimeMs != null && nowMs - mtimeMs < FRESH_FILE_MS) {
    return { ok: false, kind: 'deferred', code: 'token_expired', message: `${WAITING_PREFIX} (credentials were just written)` };
  }

  log(`[claude] refreshing token (${reason})`);
  const previousAttemptAt = state.lastRefreshAttemptAt;
  state.lastRefreshAttemptAt = nowMs;
  const r = await tokens.refreshClaudeTokens({
    fetch, credentialsPath, now, log, userAgent, lockPath, lockOptions,
    expectedRefreshToken: oauth.refreshToken,
    expectedAccessToken: oauth.accessToken,
  });
  if (r.ok) {
    if (r.rotatedByOther) state.lastRefreshAttemptAt = previousAttemptAt; // no token endpoint call was made
    backoff.reset();
    state.refreshFileSig = null;
    return { ok: true, oauth: r.oauth };
  }
  if (r.lockHeld) {
    state.lastRefreshAttemptAt = previousAttemptAt;
    return { ok: false, kind: 'deferred', code: 'token_expired', message: `${WAITING_PREFIX} (another process holds the refresh lock)` };
  }
  backoff.recordFailure(nowMs, { permanent: r.permanent, error: r.error });
  state.refreshFileSig = { refreshKey: tokenKey(oauth.refreshToken), mtimeMs };
  if (r.permanent) {
    log(`[claude] refresh token rejected (${r.error && r.error.code}); parking refresh attempts until the credentials change`);
    return { ok: false, kind: 'permanent', code: 'refresh_failed', message: 'Claude sign-in expired - run claude to sign in again' };
  }
  return { ok: false, kind: 'transient', code: 'refresh_failed', message: `Claude token refresh failed (${r.error && r.error.code}); retrying in ${minutesUntil(nextRefreshAllowedAt(), nowMs)} min` };
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

async function fetchSnapshotInner({ settings, fetch = globalThis.fetch, now = Date.now, log = () => {}, lastGood = null, paths, timeoutMs = REQUEST_TIMEOUT_MS, lockOptions = {} } = {}) {
  settings = settings || {}; // default params do not cover an explicit null
  paths = paths || {};
  const credentialsPath = paths.credentialsPath || defaultCredentialsPath();
  const lockPath = paths.lockPath || lockPathFor(credentialsPath);
  const autoRefresh = settings.tokenAutoRefresh !== false;
  const ctx = { lastGood };

  try {
    const nowMs = now();

    // 0a. Per-process request floor (F4). Manual refreshes go through here too.
    if (state.lastUsageRequestAt && nowMs - state.lastUsageRequestAt < USAGE_FLOOR_MS) {
      debugLog(log, `[claude] inside the ${USAGE_FLOOR_MS / 1000} s request floor (${Math.round((nowMs - state.lastUsageRequestAt) / 1000)} s since the last request) - returning the previous snapshot`);
      if (state.lastResult) {
        const { skipNextCycle, ...previous } = state.lastResult; // the scheduler hint belongs to the cycle that saw the 429
        return previous;
      }
      if (lastGood && Array.isArray(lastGood.windows) && lastGood.windows.length) return { ...lastGood, status: 'ok', error: null };
      return failure('network', 'Waiting for the next Claude poll', ctx);
    }
    // 0b. Rate-limit park (F4): no request until the back-off has elapsed.
    if (nowMs < state.rateLimit.until) {
      return failure('http_429', `Rate limited, retrying at ${hhmm(state.rateLimit.until)}`, ctx);
    }

    // 1. Re-read credentials on every poll (Claude Code rotates them itself).
    let creds; let oauth; let mtimeMs;
    try {
      ({ creds, oauth, mtimeMs } = await readCredentials(credentialsPath));
    } catch (e) {
      if (e && e.code === 'parse') return failure('parse', 'Claude credentials file is not valid JSON', ctx);
      return failure('no_credentials', `Cannot read Claude credentials (${e && e.code || 'error'})`, { ...ctx, authRequired: true });
    }
    if (!creds || !oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) {
      return failure('no_credentials', 'Log in to Claude Code (run `claude`) to see usage', { ...ctx, authRequired: true });
    }
    const accessKey = tokenKey(oauth.accessToken);

    // 1b. 403 park: a scope problem never fixes itself until the credentials change.
    if (state.forbidden) {
      if (state.forbidden.key === accessKey && state.forbidden.mtimeMs === mtimeMs) {
        return failure('http_403', state.forbidden.message, { ...ctx, authRequired: true });
      }
      state.forbidden = null;
    }
    // 1c. A credentials change (new refresh token or rewritten file) releases a refresh back-off.
    if (state.refreshFileSig && (state.refreshFileSig.refreshKey !== tokenKey(oauth.refreshToken) || state.refreshFileSig.mtimeMs !== mtimeMs)) {
      log('[claude] credentials changed since the last refresh failure - back-off released');
      state.refreshBackoff.reset();
      state.refreshFileSig = null;
    }

    const userAgent = await getUserAgent();
    const refreshArgs = { credentialsPath, lockPath, lockOptions, fetch, now, log, userAgent };

    // 2. Expiry (F2): only a token that has actually lapsed (+60 s grace) triggers a refresh. A token that is
    //    merely close to expiry is used as-is — a live Claude Code refreshes 4 min ahead and would race us.
    const expiresAt = Number(oauth.expiresAt);
    if (Number.isFinite(expiresAt) && nowMs >= expiresAt + EXPIRY_GRACE_MS) {
      if (!autoRefresh) {
        return failure('token_expired', 'Claude token expired - enable token auto-refresh or run claude to sign in again', { ...ctx, authRequired: true });
      }
      const r = await guardedRefresh({ ...refreshArgs, oauth, mtimeMs, reason: 'token lapsed' });
      if (!r.ok) return refreshFailureSnapshot(r, ctx);
      oauth = r.oauth;
    }

    // 3. Usage request.
    const request = async () => {
      state.lastUsageRequestAt = now();
      debugLog(log, '[claude] GET /api/oauth/usage');
      return getUsage(fetch, oauth.accessToken, userAgent, timeoutMs);
    };
    const networkFailure = (e) => failure('network', e && e.name === 'AbortError' ? 'Claude request timed out' : `Network error: ${e && e.message}`, ctx);
    let res;
    try {
      res = await request();
    } catch (e) {
      return networkFailure(e);
    }

    // 3b. 401 (F5) — may arrive before local expiresAt. Re-read; retry with a changed token; else refresh once.
    if (res.status === 401) {
      let again = null;
      try { again = await readCredentials(credentialsPath); } catch { /* fall through to refresh */ }
      const fresh = again && again.oauth;
      if (fresh && typeof fresh.accessToken === 'string' && fresh.accessToken && fresh.accessToken !== oauth.accessToken) {
        log('[claude] 401 but the credentials file changed - retrying with the new token');
        oauth = fresh;
        mtimeMs = again.mtimeMs;
      } else if (autoRefresh) {
        const r = await guardedRefresh({ ...refreshArgs, oauth, mtimeMs: again ? again.mtimeMs : mtimeMs, reason: 'usage request returned 401' });
        if (!r.ok) return refreshFailureSnapshot(r, ctx);
        oauth = r.oauth;
      } else {
        return failure('http_401', SIGN_IN_EXPIRED, { ...ctx, authRequired: true });
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
    if (res.status === 401) return failure('http_401', SIGN_IN_EXPIRED, { ...ctx, authRequired: true });
    if (res.status === 403) {
      const scopeIssue = /scope|user:profile/i.test(text || '');
      const message = scopeIssue ? SCOPE_MESSAGE : bodyMessage(text, 'Claude denied access to usage (HTTP 403)');
      if (scopeIssue) state.forbidden = { key: tokenKey(oauth.accessToken), mtimeMs, message };
      return failure('http_403', message, { ...ctx, authRequired: true });
    }
    if (res.status === 429) {
      const requestedAt = state.lastUsageRequestAt || nowMs;
      const step = state.rateLimit.step;
      const fromHeader = retryAfterMs(res, requestedAt);
      // Retry-After is honoured, but never below the 60 s floor and never beyond a day (a bogus / far-future header
      // would otherwise park the provider until the app is restarted).
      const delay = Math.min(RATE_LIMIT_MAX_MS, Math.max(RATE_LIMIT_MIN_MS, fromHeader != null ? fromHeader : RATE_LIMIT_STEPS_MS[Math.min(step, RATE_LIMIT_STEPS_MS.length - 1)]));
      state.rateLimit = { until: requestedAt + delay, step: step + 1 };
      log(`[claude] rate limited (HTTP 429${fromHeader != null ? ', Retry-After honoured' : ''}); next attempt at ${hhmm(state.rateLimit.until)}`);
      return failure('http_429', `Rate limited, retrying at ${hhmm(state.rateLimit.until)}`, { ...ctx, skipNextCycle: true });
    }
    if (res.status >= 500) return failure('http_5xx', `Claude service error (HTTP ${res.status})`, ctx);
    if (!res.ok) return failure('http_5xx', `Unexpected HTTP ${res.status} from Claude`, ctx);

    let usage;
    try { usage = JSON.parse(text); } catch { return failure('parse', 'Claude returned non-JSON usage data', ctx); }
    if (!looksLikeUsage(usage)) return failure('parse', 'Claude returned an unexpected usage payload (no usage fields)', ctx);
    state.rateLimit = { until: 0, step: 0 };

    // 4. Profile (cached hourly) for account name / plan fallback / organization uuid; then prepaid credits.
    const profile = await getProfile({ fetch, accessToken: oauth.accessToken, userAgent, now, log, timeoutMs });
    const orgUuid = profile && profile.organization && typeof profile.organization === 'object' && typeof profile.organization.uuid === 'string'
      ? profile.organization.uuid : null;
    const credits = await getCredits({ fetch, accessToken: oauth.accessToken, userAgent, orgUuid, settings, now, log, timeoutMs });

    const norm = normalizeClaude({ usage, profile, credentials: oauth, prepaid: credits });
    return makeSnapshot({
      status: 'ok',
      plan: norm.plan,
      account: norm.account,
      updatedAt: now(),
      windows: norm.windows,
      extra: norm.extra,
      raw: { usage, profile, credits },
    });
  } catch (e) {
    log(`[claude] unexpected error: ${e && e.message}`);
    return failure('network', `Unexpected error: ${e && e.message}`, ctx);
  }
}

module.exports = {
  id,
  name,
  source,
  fetchSnapshot,
  resetState,
  // URLs / headers
  USAGE_URL,
  PROFILE_URL,
  creditsUrl,
  USER_AGENT: USER_AGENT_FALLBACK,      // compatibility alias: the UA used when the CLI cannot be detected
  USER_AGENT_FALLBACK,
  userAgentFor,
  getUserAgent,
  setCliVersion,
  parseCliVersion,
  detectCliVersion,
  CLI_VERSION_FALLBACK,
  // paths
  defaultCredentialsPath,
  lockPathFor,
  // tunables (exported for tests / docs)
  USAGE_FLOOR_MS,
  EXPIRY_GRACE_MS,
  REFRESH_SPACING_MS,
  FRESH_FILE_MS,
  RATE_LIMIT_STEPS_MS,
  RATE_LIMIT_MIN_MS,
  RATE_LIMIT_MAX_MS,
  CREDITS_TTL_MS,
  PROFILE_TTL_MS,
  PROFILE_RETRY_MS,
  USAGE_PAYLOAD_KEYS,
  SIGN_IN_EXPIRED,
  SCOPE_MESSAGE,
  hhmm,
  // test hook
  _state: () => state,
};
