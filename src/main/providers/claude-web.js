'use strict';

/**
 * claude-web.js — Claude provider via a claude.ai browser session (port of the original widget's
 * sessionKey flow, adapted to ARCHITECTURE §13). OPTIONAL source; selected by settings.claudeSource === 'claude_web'.
 *
 * Why a hidden BrowserWindow: Cloudflare in front of claude.ai blocks Node fetch from Electron.
 * Loading the JSON URL in a hidden window rides on real browser cookies + a Chrome UA and passes.
 * There is no access to the HTTP status — only the body text — so failures are classified by content.
 *
 * `require('electron')` is LAZY (inside functions) so tests can import this module under plain Node.
 *
 * ---------------------------------------------------------------------------------------------
 * Exports / signatures (main.js wires these to the §8 IPC handlers):
 *
 *   id = 'claude', name = 'Claude', source = 'claude_web'
 *
 *   fetchSnapshot({ settings, fetch, now, log, lastGood }) → Promise<ProviderSnapshot>
 *       Uses the session set via setSession(). `settings.claudeOrganizationId` is the org fallback.
 *       Extended endpoints (/overage_spend_limit, /prepaid/credits) are fetched only when
 *       settings.expandedOpen.claude is true or (settings.compactMode && settings.compactSpendOpen).
 *       A dead session → status 'auth_required', error.code 'http_401' (main.js should then emit
 *       'claude-web-session-expired' to the renderer and clear the stored key).
 *
 *   setSession({ sessionKey, organizationId })   main.js calls this at startup after decrypting the
 *                                                 stored key (safeStorage) and after login/selectOrg.
 *   getSession() → { sessionKey: boolean(has), organizationId }   never returns the key itself.
 *
 *   login({ onSessionKey, timeoutMs }) → Promise<{ success, error?, organizationId?, organizations? }>
 *       Opens a visible login window (navigation restricted to claude.ai + OAuth IdPs), waits for the
 *       `sessionKey` cookie, validates it against /api/organizations, picks a default org (team first),
 *       stores everything in module state and calls onSessionKey(sessionKey, { organizationId, organizations })
 *       so main.js can persist the key (safeStorage) and the org id (settings.claudeOrganizationId).
 *   logout() → Promise<true>          clears module state, claude.ai cookies and cached storage.
 *   listOrgs() → Promise<[{ id, name, isTeam }]>    chat-capable orgs (cached from the last validation).
 *   selectOrg(id) → Promise<true>     switches the active org (main.js persists settings.claudeOrganizationId).
 * ---------------------------------------------------------------------------------------------
 */

const { normalizeClaude } = require('./normalize');

const id = 'claude';
const name = 'Claude';
const source = 'claude_web';

const CLAUDE_ORIGIN = 'https://claude.ai';
const PARTITION = 'persist:claude-web'; // isolate claude.ai cookies from the widget's own pages
const PER_REQUEST_TIMEOUT_MS = 15000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
// Same etiquette as the Claude Code source (ARCHITECTURE §5/§6): at most one real claude.ai poll per 60 s per
// process regardless of settings.refreshInterval or manual refreshes — a poll inside the floor returns the previous
// snapshot unchanged. The original widget's observed cadence against claude.ai was exactly 60 s (research §8.6).
const USAGE_FLOOR_MS = 60 * 1000;

/** Body signatures that mean "you are not logged in / Cloudflare stopped us" (order matters). */
const BLOCKED_SIGNATURES = [
  { pattern: 'Just a moment', code: 'CloudflareBlocked' },
  { pattern: 'Enable JavaScript and cookies to continue', code: 'CloudflareChallenge' },
  { pattern: '<html', code: 'UnexpectedHTML' },
];

const ALLOWED_LOGIN_DOMAINS = ['claude.ai', 'anthropic.com', 'accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com'];

// Module state: the session, the org cache and the request floor. main.js owns persistence.
const freshFloor = () => ({ at: 0, result: null });
const freshState = () => ({ sessionKey: null, organizationId: null, organizations: [], floor: freshFloor() });
let state = freshState();

// ---------------------------------------------------------------------------
// Electron access (lazy)
// ---------------------------------------------------------------------------

function electron() {
  // eslint-disable-next-line global-require
  return require('electron');
}

function webSession() {
  return electron().session.fromPartition(PARTITION);
}

/** Honest Chromium UA: Electron's default minus the "Electron/x.y" token that Cloudflare keys on. */
function chromeUserAgent() {
  const chrome = (process.versions && process.versions.chrome) || '120.0.0.0';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

async function setSessionCookie(sessionKey) {
  await webSession().cookies.set({
    url: CLAUDE_ORIGIN, name: 'sessionKey', value: sessionKey, domain: '.claude.ai', path: '/', secure: true, httpOnly: true,
  });
}

// ---------------------------------------------------------------------------
// Body classification (pure — exported for tests)
// ---------------------------------------------------------------------------

/**
 * parseBody(text) → { ok: true, value } | { ok: false, code, message }
 * codes: CloudflareBlocked | CloudflareChallenge | UnexpectedHTML | InvalidJSON | ApiError
 */
function parseBody(text) {
  const body = typeof text === 'string' ? text : '';
  for (const sig of BLOCKED_SIGNATURES) {
    if (body.includes(sig.pattern)) return { ok: false, code: sig.code, message: `${sig.code}: ${body.slice(0, 120)}` };
  }
  let value;
  try { value = JSON.parse(body); } catch { return { ok: false, code: 'InvalidJSON', message: `InvalidJSON: ${body.slice(0, 120)}` }; }
  if (value && typeof value === 'object' && !Array.isArray(value) && value.error && Object.keys(value).length <= 2) {
    const msg = typeof value.error === 'string' ? value.error : (value.error.message || value.error.type || 'API error');
    return { ok: false, code: 'ApiError', message: String(msg).slice(0, 200), apiError: value.error };
  }
  return { ok: true, value };
}

/** Which failures mean the session is dead (→ auth_required) versus transient. */
function isSessionDeadCode(code, apiError) {
  if (code === 'CloudflareBlocked' || code === 'CloudflareChallenge' || code === 'UnexpectedHTML') return true;
  if (code === 'ApiError' && apiError && typeof apiError === 'object') {
    return /permission|authentication|unauthori[sz]ed|not_found_error|invalid_session/i.test(`${apiError.type || ''} ${apiError.message || ''}`);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Hidden-window fetch
// ---------------------------------------------------------------------------

/**
 * Load each URL in turn in ONE hidden window and return per-URL settled results —
 * `[{ ok, value } | { ok: false, code, message }]` in input order. Unlike the original
 * fetchMultipleViaWindow, one failing URL does not reject the batch (that bug logged users out when
 * an extended endpoint served an HTML error page). The window is always closed.
 */
function fetchJsonViaWindow(urls, { timeoutMs = PER_REQUEST_TIMEOUT_MS, log = () => {} } = {}) {
  const { BrowserWindow } = electron();
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 800, height: 600, show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: PARTITION },
    });
    win.webContents.setUserAgent(chromeUserAgent());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    const results = [];
    let index = 0;
    let timer = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (!win.isDestroyed()) win.destroy(); } catch { /* already gone */ }
      resolve(results);
    };
    const record = (r) => {
      if (timer) { clearTimeout(timer); timer = null; }
      results.push(r);
      index += 1;
      loadNext();
    };
    const loadNext = () => {
      if (index >= urls.length) return finish();
      const url = urls[index];
      timer = setTimeout(() => record({ ok: false, code: 'Timeout', message: `Request timeout: ${url}` }), timeoutMs);
      win.loadURL(url).catch((e) => {
        // loadURL rejects on did-fail-load in newer Electron; the event handler below records it.
        log(`[claude-web] loadURL rejected: ${e && e.message}`);
      });
    };

    win.webContents.on('did-finish-load', async () => {
      if (settled) return;
      try {
        const text = await win.webContents.executeJavaScript('document.body ? (document.body.innerText || document.body.textContent) : ""', true);
        record(parseBody(text));
      } catch (e) {
        record({ ok: false, code: 'ExtractFailed', message: `ExtractFailed: ${e && e.message}` });
      }
    });
    win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, _url, isMainFrame) => {
      if (settled || !isMainFrame || errorCode === -3 /* ERR_ABORTED: navigation superseded */) return;
      record({ ok: false, code: 'LoadFailed', message: `LoadFailed: ${errorCode} ${errorDescription}` });
    });
    win.on('closed', () => {
      if (!settled) { while (results.length < urls.length) results.push({ ok: false, code: 'WindowClosed', message: 'Fetch window closed' }); finish(); }
    });

    loadNext();
  });
}

// ---------------------------------------------------------------------------
// Session / org management
// ---------------------------------------------------------------------------

function setSession({ sessionKey = null, organizationId = null } = {}) {
  state.sessionKey = sessionKey || null;
  state.organizationId = organizationId || null;
  state.floor = freshFloor(); // a new session/org must not replay the previous session's snapshot
}

function getSession() {
  return { sessionKey: Boolean(state.sessionKey), organizationId: state.organizationId, organizations: state.organizations.slice() };
}

function mapOrgs(data) {
  if (!Array.isArray(data)) return [];
  return data
    .filter((org) => org && Array.isArray(org.capabilities) && org.capabilities.includes('chat')) // excludes API-only orgs
    .map((org) => ({ id: org.uuid || org.id, name: org.name, isTeam: org.raven_type === 'team', raw: org }));
}

/** Validate the current cookie by listing orgs; caches them. Throws on a dead session. */
async function loadOrgs({ log = () => {} } = {}) {
  if (!state.sessionKey) throw new Error('Missing credentials');
  await setSessionCookie(state.sessionKey);
  const [res] = await fetchJsonViaWindow([`${CLAUDE_ORIGIN}/api/organizations`], { log });
  if (!res.ok) throw new Error(res.message || res.code);
  const orgs = mapOrgs(res.value);
  if (!orgs.length) {
    if (res.value && res.value.error) throw new Error(res.value.error.message || String(res.value.error));
    throw new Error('No chat-enabled organizations found');
  }
  state.organizations = orgs;
  return orgs;
}

async function listOrgs(opts) {
  if (state.organizations.length) return state.organizations.map(({ id: oid, name: n, isTeam }) => ({ id: oid, name: n, isTeam }));
  const orgs = await loadOrgs(opts);
  return orgs.map(({ id: oid, name: n, isTeam }) => ({ id: oid, name: n, isTeam }));
}

async function selectOrg(organizationId) {
  if (!organizationId) throw new Error('organizationId required');
  state.organizationId = String(organizationId);
  state.floor = freshFloor();
  return true;
}

/**
 * Open the login window and capture the sessionKey cookie. Claude.ai/Cloudflare block embedded logins
 * with an Electron UA, so we present a Chrome UA and restrict navigation to trusted domains.
 */
function login({ onSessionKey = () => {}, timeoutMs = LOGIN_TIMEOUT_MS, log = () => {} } = {}) {
  const { BrowserWindow } = electron();
  const ses = webSession();
  return new Promise((resolve) => {
    let done = false;
    const loginWin = new BrowserWindow({
      width: 1000, height: 700, title: 'Claude Login - https://claude.ai/login',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: PARTITION },
    });
    loginWin.webContents.setUserAgent(chromeUserAgent());

    const isAllowed = (url) => {
      try {
        const host = new URL(url).hostname;
        return ALLOWED_LOGIN_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
      } catch { return false; }
    };
    loginWin.webContents.on('will-navigate', (event, url) => {
      if (!isAllowed(url)) { event.preventDefault(); log(`[claude-web] blocked navigation to untrusted domain`); return; }
      loginWin.setTitle(`Claude Login - ${url}`);
    });
    loginWin.webContents.on('did-navigate', (_e, url) => loginWin.setTitle(`Claude Login - ${url}`));
    loginWin.webContents.on('did-navigate-in-page', (_e, url) => loginWin.setTitle(`Claude Login - ${url}`));
    loginWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    const cleanup = () => {
      ses.cookies.removeListener('changed', onCookieChanged);
      clearTimeout(timer);
    };
    const settle = (result) => {
      if (done) return;
      done = true;
      cleanup();
      try { if (!loginWin.isDestroyed()) loginWin.close(); } catch { /* ignore */ }
      resolve(result);
    };

    const onCookieChanged = async (_event, cookie, _cause, removed) => {
      if (done || removed || cookie.name !== 'sessionKey' || !cookie.domain || !cookie.domain.includes('claude.ai') || !cookie.value) return;
      done = true; // claim before the awaits below so a second cookie event cannot double-resolve
      cleanup();
      try { if (!loginWin.isDestroyed()) loginWin.close(); } catch { /* ignore */ }
      state.sessionKey = cookie.value;
      state.organizations = [];
      state.floor = freshFloor();
      try {
        const orgs = await loadOrgs({ log });
        const def = orgs.find((o) => o.isTeam) || orgs[0];
        state.organizationId = def.id;
        const organizations = orgs.map(({ id: oid, name: n, isTeam }) => ({ id: oid, name: n, isTeam }));
        try { await onSessionKey(cookie.value, { organizationId: def.id, organizations }); } catch (e) { log(`[claude-web] onSessionKey handler failed: ${e && e.message}`); }
        resolve({ success: true, organizationId: def.id, organizations });
      } catch (e) {
        state.sessionKey = null;
        state.organizationId = null;
        await ses.cookies.remove(CLAUDE_ORIGIN, 'sessionKey').catch(() => {});
        resolve({ success: false, error: e && e.message ? e.message : 'Validation failed' });
      }
    };

    const timer = setTimeout(() => settle({ success: false, error: 'Login timed out' }), timeoutMs);
    ses.cookies.on('changed', onCookieChanged);
    loginWin.on('closed', () => settle({ success: false, error: 'Login window closed' }));

    // Start from a clean cookie so the 'changed' event fires for the new login.
    ses.cookies.remove(CLAUDE_ORIGIN, 'sessionKey').catch(() => {}).then(() => {
      if (!done) loginWin.loadURL(`${CLAUDE_ORIGIN}/login`).catch(() => {});
    });
  });
}

async function logout() {
  state = freshState();
  try {
    const ses = webSession();
    const cookies = await ses.cookies.get({ url: CLAUDE_ORIGIN });
    for (const c of cookies) await ses.cookies.remove(CLAUDE_ORIGIN, c.name).catch(() => {});
    await ses.clearStorageData({ storages: ['localstorage', 'sessionstorage', 'cachestorage'], origin: CLAUDE_ORIGIN }).catch(() => {});
  } catch { /* electron unavailable (tests) — state is cleared regardless */ }
  return true;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

function makeSnapshot({ status, error = null, plan = null, account = null, updatedAt = 0, windows = [], extra = null, raw = null }) {
  return { id, name, status, error, source, plan, account, updatedAt, windows, extra, credits: null, raw: raw || {} };
}

function failure(code, message, { lastGood, authRequired = false, raw = null }) {
  const hasLastGood = Boolean(lastGood && Array.isArray(lastGood.windows) && lastGood.windows.length);
  const status = authRequired ? 'auth_required' : hasLastGood ? 'stale' : 'error';
  return makeSnapshot({
    status, error: { code, message },
    plan: hasLastGood ? lastGood.plan : null,
    account: hasLastGood ? lastGood.account : null,
    updatedAt: hasLastGood ? lastGood.updatedAt : 0,
    windows: hasLastGood ? lastGood.windows : [],
    extra: hasLastGood ? lastGood.extra : null,
    raw,
  });
}

/** Map a failed /usage result to a snapshot error. Only THIS endpoint's failure is fatal. */
function usageFailure(res, ctx) {
  if (isSessionDeadCode(res.code, res.apiError)) {
    return failure('http_401', 'claude.ai session expired — log in again in Settings', { ...ctx, authRequired: true });
  }
  if (res.code === 'InvalidJSON' || res.code === 'ApiError' || res.code === 'ExtractFailed') return failure('parse', res.message, ctx);
  return failure('network', res.message || 'claude.ai request failed', ctx); // Timeout / LoadFailed / WindowClosed
}

async function fetchSnapshot({ settings, now = Date.now, log = () => {}, lastGood = null, fetchJson = fetchJsonViaWindow } = {}) {
  settings = settings || {}; // default params do not cover an explicit null
  const ctx = { lastGood };
  try {
    const sessionKey = state.sessionKey;
    const organizationId = state.organizationId || settings.claudeOrganizationId || null;
    if (!sessionKey || !organizationId) {
      return failure('no_credentials', 'Log in to claude.ai in Settings to see usage', { ...ctx, authRequired: true });
    }
    // Request floor: manual refreshes and short refreshInterval settings go through here too.
    const nowMs = now();
    if (state.floor.result && nowMs - state.floor.at < USAGE_FLOOR_MS) {
      if (typeof log.debug === 'function') log.debug(`[claude-web] inside the ${USAGE_FLOOR_MS / 1000} s request floor - returning the previous snapshot`);
      return state.floor.result;
    }
    const remember = (snap) => { state.floor = { at: nowMs, result: snap }; return snap; };
    if (fetchJson === fetchJsonViaWindow) await setSessionCookie(sessionKey);

    const expanded = Boolean(settings.expandedOpen && settings.expandedOpen.claude);
    const compactSpend = Boolean(settings.compactMode && settings.compactSpendOpen);
    const extended = expanded || compactSpend;

    const base = `${CLAUDE_ORIGIN}/api/organizations/${encodeURIComponent(organizationId)}`;
    const urls = [`${base}/usage`];
    if (extended) urls.push(`${base}/overage_spend_limit`, `${base}/prepaid/credits`);

    const results = await fetchJson(urls, { log });
    const usageRes = results[0];
    if (!usageRes || !usageRes.ok) return remember(usageFailure(usageRes || { code: 'WindowClosed' }, ctx));
    const usage = usageRes.value;
    if (!usage || typeof usage !== 'object' || (!usage.five_hour && !usage.seven_day && !Array.isArray(usage.limits))) {
      return remember(failure('parse', 'claude.ai returned an unexpected usage payload', ctx));
    }

    let overage = null; let prepaid = null;
    if (extended) {
      if (results[1] && results[1].ok) overage = results[1].value; else log(`[claude-web] overage endpoint skipped: ${results[1] && results[1].code}`);
      if (results[2] && results[2].ok) prepaid = results[2].value; else log(`[claude-web] prepaid endpoint skipped: ${results[2] && results[2].code}`);
    }
    const orgEntry = state.organizations.find((o) => o.id === organizationId);
    const org = orgEntry ? orgEntry.raw : null;

    const norm = normalizeClaude({ usage, web: { overage, prepaid, org } });
    return remember(makeSnapshot({
      status: 'ok', plan: norm.plan, account: norm.account, updatedAt: now(),
      windows: norm.windows, extra: norm.extra, raw: { usage, overage, prepaid },
    }));
  } catch (e) {
    log(`[claude-web] unexpected error: ${e && e.message}`);
    return failure('network', `Unexpected error: ${e && e.message}`, ctx);
  }
}

/** Test hook. */
function resetState() { state = freshState(); }

module.exports = {
  id, name, source,
  fetchSnapshot,
  setSession, getSession, login, logout, listOrgs, selectOrg,
  parseBody, isSessionDeadCode, mapOrgs, chromeUserAgent, fetchJsonViaWindow,
  resetState,
  USAGE_FLOOR_MS,
};
