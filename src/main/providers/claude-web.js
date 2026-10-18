'use strict';

/**
 * claude-web.js — Claude provider via a claude.ai browser session (port of the original widget's
 * sessionKey flow, adapted to ARCHITECTURE §13). The `claude_web` source of a Claude account.
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
 *   createClaudeWebProvider({ id = 'claude', name = 'Claude',
 *                             partition = id === 'claude' ? 'persist:claude-web' : `persist:claude-web-${id}`,
 *                             getOrganizationId = null })
 *     → { id, name, source: 'claude_web', partition, fetchSnapshot, setSession, getSession, login, logout,
 *         listOrgs, selectOrg, resetState }
 *       One instance per Claude account. The session key, org, org cache and request floor are per instance, and
 *       every window / cookie operation uses the instance's own partition — several sign-ins never share a cookie,
 *       and each partition keeps its own Google/Apple SSO cookies. `name` may also be a function (current label).
 *
 *   module.exports = the default instance (id 'claude', partition 'persist:claude-web' — the 1.0.x sign-in)
 *                    + createClaudeWebProvider + the pure helpers (parseBody, isSessionDeadCode, mapOrgs,
 *                    chromeUserAgent, fetchJsonViaWindow(urls, { partition, timeoutMs, log })).
 *
 *   fetchSnapshot({ settings, fetch, now, log, lastGood }) → Promise<ProviderSnapshot>
 *       Uses the session set via setSession(). Org fallback: the instance's org → getOrganizationId() → (account 1,
 *       id 'claude', only) `settings.claudeOrganizationId`. Extended endpoints (/overage_spend_limit,
 *       /prepaid/credits) are fetched only when settings.expandedOpen[id] is true or
 *       (settings.compactMode && settings.compactSpendOpen). A dead session → status 'auth_required',
 *       error.code 'http_401' (main.js should then emit 'claude-web-session-expired' to the renderer and clear
 *       the stored key).
 *
 *   setSession({ sessionKey, organizationId })   main.js calls this at startup after decrypting the
 *                                                 stored key (safeStorage) and after login/selectOrg.
 *   getSession() → { sessionKey: boolean(has), organizationId }   never returns the key itself.
 *
 *   login({ onSessionKey, timeoutMs }) → Promise<{ success, error?, organizationId?, organizations? }>
 *       Opens a visible login window titled `Claude Login (<name>) - <url>` (navigation restricted to claude.ai +
 *       OAuth IdPs), waits for the `sessionKey` cookie, validates it against /api/organizations, picks a default
 *       org (team first), stores everything in instance state and calls onSessionKey(sessionKey, { organizationId,
 *       organizations }) so main.js can persist the key (safeStorage) and the org id (the account's organizationId).
 *   logout() → Promise<true>          clears instance state, the partition's claude.ai cookies and cached storage.
 *   listOrgs() → Promise<[{ id, name, isTeam }]>    chat-capable orgs (cached from the last validation).
 *   selectOrg(id) → Promise<true>     switches the active org (main.js persists the account's organizationId).
 * ---------------------------------------------------------------------------------------------
 */

const crypto = require('node:crypto');
const { normalizeClaude } = require('./normalize');

const DEFAULT_ID = 'claude';
const DEFAULT_NAME = 'Claude';
const source = 'claude_web';

const CLAUDE_ORIGIN = 'https://claude.ai';
const PARTITION = 'persist:claude-web'; // isolate claude.ai cookies from the widget's own pages (account 1)
const PER_REQUEST_TIMEOUT_MS = 15000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
// Same etiquette as the Claude Code source (ARCHITECTURE §5/§6): at most one real claude.ai poll per 60 s per
// account regardless of settings.refreshInterval or manual refreshes — a poll inside the floor returns the previous
// snapshot unchanged. The original widget's observed cadence against claude.ai was exactly 60 s (research §8.6).
const USAGE_FLOOR_MS = 60 * 1000;

/** Body signatures that mean "you are not logged in / Cloudflare stopped us" (order matters). */
const BLOCKED_SIGNATURES = [
  { pattern: 'Just a moment', code: 'CloudflareBlocked' },
  { pattern: 'Enable JavaScript and cookies to continue', code: 'CloudflareChallenge' },
  { pattern: '<html', code: 'UnexpectedHTML' },
];

const ALLOWED_LOGIN_DOMAINS = ['claude.ai', 'anthropic.com', 'accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com'];

/** The Electron session partition of an account: account 1 keeps the 1.0.x partition (and its sign-in). */
function partitionFor(id) {
  return id === DEFAULT_ID ? PARTITION : `persist:claude-web-${id}`;
}

// Instance state: the session, the org cache and the request floor. main.js owns persistence.
const freshFloor = () => ({ at: 0, result: null });
const freshState = () => ({ sessionKey: null, organizationId: null, organizations: [], floor: freshFloor() });

// ---------------------------------------------------------------------------
// Electron access (lazy)
// ---------------------------------------------------------------------------

function electron() {
  // eslint-disable-next-line global-require
  return require('electron');
}

function webSession(partition) {
  return electron().session.fromPartition(partition);
}

/** Honest Chromium UA: Electron's default minus the "Electron/x.y" token that Cloudflare keys on. */
function chromeUserAgent() {
  const chrome = (process.versions && process.versions.chrome) || '120.0.0.0';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

async function setSessionCookie(partition, sessionKey) {
  await webSession(partition).cookies.set({
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

/** §4 identity hash: sha256(uuid) hex, first 16 — the raw org uuid never leaves the provider. */
function identityHash(uuid) {
  return typeof uuid === 'string' && uuid ? crypto.createHash('sha256').update(uuid).digest('hex').slice(0, 16) : null;
}

/**
 * §4 identity of a claude.ai sign-in: the selected org (hashed); there is no account uuid on this path. A personal
 * org is one whose /api/organizations entry has no `raven_type` and no 'raven' capability (Team / Enterprise orgs
 * carry one) — null when the entry is not cached.
 */
function webIdentity(organizationId, org) {
  let personalOrg = null;
  if (org && typeof org === 'object') {
    const caps = Array.isArray(org.capabilities) ? org.capabilities : [];
    personalOrg = !org.raven_type && !caps.includes('raven');
  }
  return { account: null, org: identityHash(organizationId), personalOrg };
}

// ---------------------------------------------------------------------------
// Hidden-window fetch
// ---------------------------------------------------------------------------

/**
 * Load each URL in turn in ONE hidden window and return per-URL settled results —
 * `[{ ok, value } | { ok: false, code, message }]` in input order. Unlike the original
 * fetchMultipleViaWindow, one failing URL does not reject the batch (that bug logged users out when
 * an extended endpoint served an HTML error page). The window is always closed. `partition` is the
 * account's session (default: account 1's).
 */
function fetchJsonViaWindow(urls, { partition = PARTITION, timeoutMs = PER_REQUEST_TIMEOUT_MS, log = () => {} } = {}) {
  const { BrowserWindow } = electron();
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 800, height: 600, show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition },
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
// Orgs (pure)
// ---------------------------------------------------------------------------

function mapOrgs(data) {
  if (!Array.isArray(data)) return [];
  return data
    .filter((org) => org && Array.isArray(org.capabilities) && org.capabilities.includes('chat')) // excludes API-only orgs
    .map((org) => ({ id: org.uuid || org.id, name: org.name, isTeam: org.raven_type === 'team', raw: org }));
}

const publicOrgs = (orgs) => orgs.map(({ id: oid, name: n, isTeam }) => ({ id: oid, name: n, isTeam }));

// ---------------------------------------------------------------------------
// Snapshot builders
// ---------------------------------------------------------------------------

function makeSnapshot(self, { status, error = null, plan = null, account = null, updatedAt = 0, windows = [], extra = null, identity = null, raw = null }) {
  return { id: self.id, name: self.name, status, error, source, plan, account, updatedAt, windows, extra, credits: null, identity, raw: raw || {} };
}

function failure(code, message, { self, lastGood, authRequired = false, raw = null }) {
  const hasLastGood = Boolean(lastGood && Array.isArray(lastGood.windows) && lastGood.windows.length);
  const status = authRequired ? 'auth_required' : hasLastGood ? 'stale' : 'error';
  return makeSnapshot(self, {
    status, error: { code, message },
    plan: hasLastGood ? lastGood.plan : null,
    account: hasLastGood ? lastGood.account : null,
    updatedAt: hasLastGood ? lastGood.updatedAt : 0,
    windows: hasLastGood ? lastGood.windows : [],
    extra: hasLastGood ? lastGood.extra : null,
    identity: hasLastGood && lastGood.identity ? lastGood.identity : null,
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function createClaudeWebProvider({ id = DEFAULT_ID, name = DEFAULT_NAME, partition = partitionFor(id), getOrganizationId = null } = {}) {
  const currentName = () => {
    if (typeof name !== 'function') return name;
    try { return name() || DEFAULT_NAME; } catch { return DEFAULT_NAME; }
  };
  const self = { id, get name() { return currentName(); } };
  let state = freshState();

  /** Org to poll: this instance's → the caller's fallback → (account 1 only) the legacy settings key. */
  function organizationIdFor(settings) {
    if (state.organizationId) return state.organizationId;
    if (typeof getOrganizationId === 'function') {
      try {
        const fromCaller = getOrganizationId();
        if (fromCaller) return String(fromCaller);
      } catch { /* fall through */ }
    }
    return id === DEFAULT_ID ? settings.claudeOrganizationId || null : null;
  }

  // -------------------------------------------------------------------------
  // Session / org management
  // -------------------------------------------------------------------------

  function setSession({ sessionKey = null, organizationId = null } = {}) {
    state.sessionKey = sessionKey || null;
    state.organizationId = organizationId || null;
    state.floor = freshFloor(); // a new session/org must not replay the previous session's snapshot
  }

  function getSession() {
    return { sessionKey: Boolean(state.sessionKey), organizationId: state.organizationId, organizations: state.organizations.slice() };
  }

  /** Validate the current cookie by listing orgs; caches them. Throws on a dead session. `fetchJson`: test hook. */
  async function loadOrgs({ log = () => {}, fetchJson = fetchJsonViaWindow } = {}) {
    if (!state.sessionKey) throw new Error('Missing credentials');
    if (fetchJson === fetchJsonViaWindow) await setSessionCookie(partition, state.sessionKey);
    const [res] = await fetchJson([`${CLAUDE_ORIGIN}/api/organizations`], { log, partition });
    if (!res || !res.ok) throw new Error((res && (res.message || res.code)) || 'claude.ai request failed');
    const orgs = mapOrgs(res.value);
    if (!orgs.length) {
      if (res.value && res.value.error) throw new Error(res.value.error.message || String(res.value.error));
      throw new Error('No chat-enabled organizations found');
    }
    state.organizations = orgs;
    return orgs;
  }

  async function listOrgs(opts) {
    if (state.organizations.length) return publicOrgs(state.organizations);
    return publicOrgs(await loadOrgs(opts));
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
    const ses = webSession(partition);
    const titleFor = (url) => `Claude Login (${self.name}) - ${url}`;
    return new Promise((resolve) => {
      let done = false;
      const loginWin = new BrowserWindow({
        width: 1000, height: 700, title: titleFor(`${CLAUDE_ORIGIN}/login`),
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition },
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
        loginWin.setTitle(titleFor(url));
      });
      loginWin.webContents.on('did-navigate', (_e, url) => loginWin.setTitle(titleFor(url)));
      loginWin.webContents.on('did-navigate-in-page', (_e, url) => loginWin.setTitle(titleFor(url)));
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
          const organizations = publicOrgs(orgs);
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
      const ses = webSession(partition);
      const cookies = await ses.cookies.get({ url: CLAUDE_ORIGIN });
      for (const c of cookies) await ses.cookies.remove(CLAUDE_ORIGIN, c.name).catch(() => {});
      await ses.clearStorageData({ storages: ['localstorage', 'sessionstorage', 'cachestorage'], origin: CLAUDE_ORIGIN }).catch(() => {});
    } catch { /* electron unavailable (tests) — state is cleared regardless */ }
    return true;
  }

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  async function fetchSnapshot({ settings, now = Date.now, log = () => {}, lastGood = null, fetchJson = fetchJsonViaWindow } = {}) {
    settings = settings || {}; // default params do not cover an explicit null
    const ctx = { self, lastGood };
    try {
      const sessionKey = state.sessionKey;
      const organizationId = organizationIdFor(settings);
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
      if (fetchJson === fetchJsonViaWindow) await setSessionCookie(partition, sessionKey);

      const expanded = Boolean(settings.expandedOpen && settings.expandedOpen[id]);
      const compactSpend = Boolean(settings.compactMode && settings.compactSpendOpen);
      const extended = expanded || compactSpend;

      const base = `${CLAUDE_ORIGIN}/api/organizations/${encodeURIComponent(organizationId)}`;
      const urls = [`${base}/usage`];
      if (extended) urls.push(`${base}/overage_spend_limit`, `${base}/prepaid/credits`);

      const results = await fetchJson(urls, { log, partition });
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
      return remember(makeSnapshot(self, {
        status: 'ok', plan: norm.plan, account: norm.account, updatedAt: now(),
        windows: norm.windows, extra: norm.extra, identity: webIdentity(organizationId, org), raw: { usage, overage, prepaid },
      }));
    } catch (e) {
      log(`[claude-web] unexpected error: ${e && e.message}`);
      return failure('network', `Unexpected error: ${e && e.message}`, ctx);
    }
  }

  return {
    id,
    get name() { return currentName(); },
    source,
    partition,
    fetchSnapshot,
    setSession, getSession, login, logout, listOrgs, selectOrg,
    /** Test hook. */
    resetState() { state = freshState(); },
  };
}

// Account 1 — the 1.0.x module surface main.js and the tests use, on the 1.0.x partition.
const defaultProvider = createClaudeWebProvider();

module.exports = {
  id: defaultProvider.id,
  name: DEFAULT_NAME,
  source,
  partition: defaultProvider.partition,
  fetchSnapshot: defaultProvider.fetchSnapshot,
  setSession: defaultProvider.setSession,
  getSession: defaultProvider.getSession,
  login: defaultProvider.login,
  logout: defaultProvider.logout,
  listOrgs: defaultProvider.listOrgs,
  selectOrg: defaultProvider.selectOrg,
  resetState: defaultProvider.resetState,
  createClaudeWebProvider,
  partitionFor,
  parseBody, isSessionDeadCode, mapOrgs, chromeUserAgent, fetchJsonViaWindow,
  identityHash,
  PARTITION,
  USAGE_FLOOR_MS,
};
