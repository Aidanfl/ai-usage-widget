'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const codex = require('../src/main/providers/codex.js');
const claude = require('../src/main/providers/claude.js');
const claudeWeb = require('../src/main/providers/claude-web.js');

// --- helpers ----------------------------------------------------------------

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const makeJwt = (claims) => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.SIG`;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aiuw-prov-'));

const NOW = 1788700000000; // 2026-09-06T01:46:40Z
const now = () => NOW;
const SETTINGS = { tokenAutoRefresh: true, expandedOpen: { claude: false, codex: false }, providers: { claude: true, codex: true }, claudeSource: 'claude_code' };
const NO_REFRESH = { ...SETTINGS, tokenAutoRefresh: false };

function response(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: new Map(), text: async () => text, json: async () => JSON.parse(text) };
}

/** Route-based fake fetch: handler(url, init, calls) → response | Error. Records every call. */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    const r = await handler(url, init, calls);
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  fn.count = (substr) => calls.filter((c) => c.url.includes(substr)).length;
  return fn;
}

/**
 * Codex auth.json fixture. Like the Claude helper below, the file's mtime is pinned relative to the fake clock
 * (default 2 min ago) because the provider refuses to refresh when auth.json was written < 30 s ago (the Codex
 * CLI/desktop app is probably on it). `accessToken` replaces the generated JWT when a specific bearer is needed.
 */
function writeCodexAuth(dir, {
  expSecondsFromNow = 864000, accessToken = null, refreshToken = 'rt-old', accountId = 'acct-1', authMode = 'chatgpt', includeAccountId = true,
  mtime = NOW - 120000,
} = {}) {
  const auth = fixture('codex-auth.json');
  auth.auth_mode = authMode;
  auth.tokens.access_token = accessToken || makeJwt({ exp: Math.floor(NOW / 1000) + expSecondsFromNow, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-from-jwt' } });
  auth.tokens.id_token = makeJwt({ email: 'x@example.com' });
  auth.tokens.refresh_token = refreshToken;
  if (includeAccountId) auth.tokens.account_id = accountId; else delete auth.tokens.account_id;
  const p = path.join(dir, 'auth.json');
  fs.writeFileSync(p, JSON.stringify(auth, null, 2) + '\n');
  if (mtime != null) fs.utimesSync(p, new Date(mtime), new Date(mtime));
  return p;
}

/**
 * Claude credentials fixture. The file's mtime is pinned relative to the fake clock (default 2 min ago) because
 * the provider refuses to refresh when the file was written < 30 s ago (a live Claude Code is probably on it).
 */
function writeClaudeCreds(dir, {
  expiresAt = NOW + 3600 * 1000, accessToken = 'sk-ant-oat01-old', refreshToken = 'sk-ant-ort01-FAKE-REFRESH-TOKEN',
  refreshTokenExpiresAt = 4133980800000, scopes = ['user:inference', 'user:profile'], mtime = NOW - 120000, extraOauth = {},
} = {}) {
  const creds = fixture('claude-credentials.json');
  creds.claudeAiOauth.accessToken = accessToken;
  creds.claudeAiOauth.refreshToken = refreshToken;
  creds.claudeAiOauth.expiresAt = expiresAt;
  if (refreshTokenExpiresAt === undefined) delete creds.claudeAiOauth.refreshTokenExpiresAt;
  else creds.claudeAiOauth.refreshTokenExpiresAt = refreshTokenExpiresAt;
  if (scopes === undefined) delete creds.claudeAiOauth.scopes; else creds.claudeAiOauth.scopes = scopes;
  Object.assign(creds.claudeAiOauth, extraOauth);
  const p = path.join(dir, '.credentials.json');
  fs.writeFileSync(p, JSON.stringify(creds));
  if (mtime != null) fs.utimesSync(p, new Date(mtime), new Date(mtime));
  return p;
}
const lockDirFor = (credentialsPath) => path.join(path.dirname(credentialsPath), '.oauth_refresh.lock');
/** Lock options that make the "held" path return immediately instead of polling for 7.5 s. */
const NO_WAIT_LOCK = { sleep: async () => {}, totalWaitMs: 0 };
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_LEGACY_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLAUDE_CREDITS_URL = claude.creditsUrl('00000000-0000-0000-0000-000000000002'); // org uuid of the profile fixture
const CREDITS_PAYLOAD = {
  amount: 17481, currency: 'USD', balance: { money: null, credits: { amount_minor: 17481, exponent: 2 } }, balance_credits: 174,
  tranches: [{ remaining_amount_minor_units: 17480, currency: 'USD', expires_at: null, granted_amount_minor_units: 25000 }],
  promo_tranches: [], next_expires_at: null,
};
const later = (seconds) => () => NOW + seconds * 1000;

const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const codexRoutes = ({ usage = fixture('codex-usage-weekly-only.json'), usageStatus = 200, acceptToken = null, refreshReply = null } = {}) => (url, init) => {
  if (url === CODEX_TOKEN_URL) return refreshReply || response(200, { access_token: makeJwt({ exp: Math.floor(NOW / 1000) + 864000 }), refresh_token: 'rt-new' });
  if (url === codex.USAGE_URL) {
    const bearer = (init.headers.Authorization || '').replace('Bearer ', '');
    if (acceptToken && bearer !== acceptToken) return response(401, { detail: 'Unauthorized' });
    return response(usageStatus, usageStatus === 200 ? usage : { detail: `status ${usageStatus}` });
  }
  return response(404, 'nope');
};

const DEFAULT_REFRESH_REPLY = () => response(200, {
  access_token: 'sk-ant-oat01-new', refresh_token: 'sk-ant-ort01-new', expires_in: 28800, refresh_token_expires_in: 86400,
  scope: 'user:inference user:profile user:sessions:claude_code', account: { uuid: 'acct-uuid', email_address: 'tester@example.com' },
});
const claudeRoutes = ({
  usage = fixture('claude-usage.json'), usageStatus = 200, usageBody = null, usageHeaders = {}, acceptToken = null, refreshReply = null,
  platformStatus = null, profileStatus = 200, creditsStatus = 200, credits = CREDITS_PAYLOAD,
} = {}) => (url, init) => {
  if (url === CLAUDE_TOKEN_URL && platformStatus != null) return response(platformStatus, 'nope');
  if (url.endsWith('/v1/oauth/token')) return (typeof refreshReply === 'function' ? refreshReply() : refreshReply) || DEFAULT_REFRESH_REPLY();
  const bearer = (init.headers.Authorization || '').replace('Bearer ', '');
  if (acceptToken && bearer !== acceptToken) return response(401, { error: { type: 'authentication_error', message: 'invalid token' } });
  if (url === claude.USAGE_URL) {
    const r = response(usageStatus, usageBody != null ? usageBody : (usageStatus === 200 ? usage : { error: { message: `status ${usageStatus}` } }));
    r.headers = new Map(Object.entries(usageHeaders));
    return r;
  }
  if (url === claude.PROFILE_URL) return response(profileStatus, profileStatus === 200 ? fixture('claude-profile.json') : {});
  if (url.endsWith('/prepaid/credits')) return response(creditsStatus, creditsStatus === 200 ? credits : { error: { message: 'nope' } });
  return response(404, 'nope');
};

test.beforeEach(() => {
  codex.resetState(); claude.resetState(); claudeWeb.resetState();
  claude.setCliVersion('2.1.263'); // never spawn the real CLI from a unit test
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

test('codex: happy path → status ok, one weekly window, plan/account/credits, correct headers', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir);
  const fetch = fakeFetch(codexRoutes());
  const snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { authPath } });

  assert.equal(snap.id, 'codex'); assert.equal(snap.name, 'Codex'); assert.equal(snap.source, 'codex_auth_file');
  assert.equal(snap.status, 'ok');
  assert.equal(snap.error, null);
  assert.equal(snap.plan, 'Business');
  assert.equal(snap.account, 'tester@example.com');
  assert.equal(snap.updatedAt, NOW);
  assert.deepEqual(snap.windows.map((w) => [w.key, w.label, w.percent]), [['primary', 'Weekly Limit', 99]]);
  assert.equal(snap.extra, null);
  assert.equal(snap.credits.hasCredits, false);
  assert.ok(snap.raw.usage, 'raw payload retained');
  assert.equal(snap.skipNextCycle, undefined);

  assert.equal(fetch.calls.length, 1);
  const h = fetch.calls[0].headers;
  assert.ok(h.Authorization.startsWith('Bearer '));
  assert.equal(h['ChatGPT-Account-Id'], 'acct-1');
  assert.equal(h.Accept, 'application/json');
  assert.match(h['User-Agent'], /^ai-usage-widget\/\d+\.\d+\.\d+ \((Windows|macOS|Linux)\)$/);
  assert.ok(!/codex_cli_rs|Codex Desktop/.test(h['User-Agent']), 'truthful UA');
  assert.ok(fetch.calls[0].init.signal, 'abort signal attached for the 15 s timeout');
});

test('codex: account id falls back to the JWT claim when tokens.account_id is missing', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir, { includeAccountId: false });
  const fetch = fakeFetch(codexRoutes());
  const snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { authPath } });
  assert.equal(snap.status, 'ok');
  assert.equal(fetch.calls[0].headers['ChatGPT-Account-Id'], 'acct-from-jwt');
});

test('codex: no auth.json → auth_required / no_credentials with the sign-in message; nothing fetched', async () => {
  const dir = tmpDir();
  const fetch = fakeFetch(codexRoutes());
  const snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { authPath: path.join(dir, 'auth.json') } });
  assert.equal(snap.status, 'auth_required');
  assert.deepEqual(snap.error, { code: 'no_credentials', message: 'Sign in to Codex with ChatGPT to see usage' });
  assert.deepEqual(snap.windows, []);
  assert.equal(fetch.calls.length, 0);
});

test('codex: apikey auth mode → auth_required / no_credentials', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir, { authMode: 'apikey' });
  const snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch: fakeFetch(codexRoutes()), now, paths: { authPath } });
  assert.equal(snap.status, 'auth_required');
  assert.equal(snap.error.code, 'no_credentials');
});

test('codex: unparseable auth.json → error / parse (no last good) — stale when last good exists', async () => {
  const dir = tmpDir();
  const authPath = path.join(dir, 'auth.json');
  fs.writeFileSync(authPath, '{ nope');
  const fetch = fakeFetch(codexRoutes());
  const snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { authPath } });
  assert.equal(snap.status, 'error');
  assert.equal(snap.error.code, 'parse');
  const lastGood = { plan: 'Plus', account: 'a@b', updatedAt: 1, windows: [{ key: 'primary' }], credits: { hasCredits: true } };
  const snap2 = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { authPath }, lastGood });
  assert.equal(snap2.status, 'stale');
  assert.equal(snap2.plan, 'Plus');
  assert.deepEqual(snap2.windows, lastGood.windows);
});

test('codex: lapsed JWT (exp + 61 s) + refresh disabled → auth_required / token_expired, no network, file untouched', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir, { expSecondsFromNow: -61 }); // past the 60 s grace
  const fetch = fakeFetch(codexRoutes());
  const snap = await codex.fetchSnapshot({ settings: NO_REFRESH, fetch, now, paths: { authPath } });
  assert.equal(snap.status, 'auth_required');
  assert.equal(snap.error.code, 'token_expired');
  assert.equal(fetch.calls.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(authPath, 'utf8')).tokens.refresh_token, 'rt-old', 'file never written when refresh is off');
});

test('codex: lapsed JWT (exp + 61 s) + refresh enabled → refresh (exact CLI body), atomic write-back, new bearer, then ok', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir, { expSecondsFromNow: -61 });
  const fetch = fakeFetch(codexRoutes());
  const snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { authPath } });
  assert.equal(snap.status, 'ok');
  assert.deepEqual(fetch.calls.map((c) => c.url), [CODEX_TOKEN_URL, codex.USAGE_URL]);
  assert.equal(fetch.calls[0].init.method, 'POST');
  assert.deepEqual(fetch.calls[0].body, { client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', grant_type: 'refresh_token', refresh_token: 'rt-old' });
  assert.equal(fetch.calls[0].headers['Content-Type'], 'application/json');
  assert.match(fetch.calls[0].headers['User-Agent'], /^ai-usage-widget\//, 'truthful UA on the token call too');
  const onDisk = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  assert.equal(fetch.calls[1].headers.Authorization, `Bearer ${onDisk.tokens.access_token}`, 'usage uses the refreshed token');
  assert.equal(onDisk.tokens.refresh_token, 'rt-new');
  assert.equal(onDisk.last_refresh, new Date(NOW).toISOString());
  assert.equal(onDisk.OPENAI_API_KEY, null, 'other keys preserved');
  assert.deepEqual(fs.readdirSync(dir), ['auth.json'], 'no temp file left behind');
});

test('codex: a token close to expiry (−2 min) or just past it (< 60 s grace) is used as-is — NEVER refreshed proactively', async () => {
  const fetch = fakeFetch(codexRoutes());
  let authPath = writeCodexAuth(tmpDir(), { expSecondsFromNow: 120 }); // inside the CLI/desktop's own 5-min refresh window
  const before = fs.readFileSync(authPath, 'utf8');
  let snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { authPath } });
  assert.equal(snap.status, 'ok');
  assert.deepEqual(fetch.calls.map((c) => c.url), [codex.USAGE_URL], 'no refresh at exp − 2 min');
  assert.equal(fetch.calls[0].headers.Authorization, `Bearer ${JSON.parse(before).tokens.access_token}`, 'the current token is used as-is');
  assert.equal(fs.readFileSync(authPath, 'utf8'), before, 'file untouched');

  codex.resetState();
  authPath = writeCodexAuth(tmpDir(), { expSecondsFromNow: -30 });
  snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { authPath } });
  assert.equal(snap.status, 'ok');
  assert.equal(fetch.count(CODEX_TOKEN_URL), 0, 'no refresh inside the 60 s grace after exp');

  // The grace boundary itself counts as lapsed.
  codex.resetState();
  authPath = writeCodexAuth(tmpDir(), { expSecondsFromNow: -60 });
  snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { authPath } });
  assert.equal(snap.status, 'ok');
  assert.equal(fetch.count(CODEX_TOKEN_URL), 1, 'refresh once now ≥ exp + 60 s');
  assert.equal(codex.EXPIRY_GRACE_MS, 60000);
});

test('codex: 401 → refresh once → retry ok; refresh disabled → auth_required / http_401', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir);
  const goodToken = makeJwt({ exp: Math.floor(NOW / 1000) + 864000, marker: 'fresh' });
  const fetch = fakeFetch(codexRoutes({ acceptToken: goodToken, refreshReply: response(200, { access_token: goodToken }) }));
  const snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { authPath } });
  assert.equal(snap.status, 'ok');
  assert.deepEqual(fetch.calls.map((c) => c.url), [codex.USAGE_URL, CODEX_TOKEN_URL, codex.USAGE_URL]);
  assert.equal(fetch.calls[2].headers.Authorization, `Bearer ${goodToken}`);

  codex.resetState(); // the 30 s request floor would otherwise replay the previous snapshot
  const dir2 = tmpDir();
  const authPath2 = writeCodexAuth(dir2);
  const fetch2 = fakeFetch(codexRoutes({ acceptToken: 'something-else' }));
  const snap2 = await codex.fetchSnapshot({ settings: NO_REFRESH, fetch: fetch2, now, paths: { authPath: authPath2 } });
  assert.equal(snap2.status, 'auth_required');
  assert.equal(snap2.error.code, 'http_401');
  assert.equal(fetch2.count(CODEX_TOKEN_URL), 0);
});

test('codex: 401 but auth.json changed in the meantime → retry with the new token, no token endpoint call', async () => {
  const dir = tmpDir();
  const oldToken = makeJwt({ exp: Math.floor(NOW / 1000) + 864000, marker: 'old' });
  const theirs = makeJwt({ exp: Math.floor(NOW / 1000) + 864000, marker: 'desktop' });
  const authPath = writeCodexAuth(dir, { accessToken: oldToken });
  const fetch = fakeFetch((url, init) => {
    if (url === codex.USAGE_URL && init.headers.Authorization === `Bearer ${oldToken}`) {
      writeCodexAuth(dir, { accessToken: theirs, refreshToken: 'rt-desktop', mtime: NOW - 1000 }); // the desktop app rotated
      return response(401, { detail: 'Unauthorized' });
    }
    return codexRoutes({ acceptToken: theirs })(url, init);
  });
  const snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { authPath } });
  assert.equal(snap.status, 'ok');
  assert.equal(fetch.count(CODEX_TOKEN_URL), 0, 'their rotation is used; our single-use refresh token is never sent');
  assert.deepEqual(fetch.calls.map((c) => c.headers.Authorization), [`Bearer ${oldToken}`, `Bearer ${theirs}`]);
  assert.equal(JSON.parse(fs.readFileSync(authPath, 'utf8')).tokens.refresh_token, 'rt-desktop', 'file untouched');
});

test('codex: 401 and refresh still rejected → auth_required / http_401 (never loops)', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir);
  const fetch = fakeFetch(codexRoutes({ acceptToken: 'never', refreshReply: response(200, { access_token: makeJwt({ exp: 9999999999 }) }) }));
  const snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { authPath } });
  assert.equal(snap.status, 'auth_required');
  assert.equal(snap.error.code, 'http_401');
  assert.equal(fetch.calls.length, 3, 'usage, refresh, usage — then stop');
});

test('codex: permanent refresh failure (invalid_grant) → auth_required / refresh_failed, parked 30 min or until auth.json changes', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir, { expSecondsFromNow: -61 });
  const fetch = fakeFetch(codexRoutes({ refreshReply: response(400, { error: { code: 'invalid_grant' } }) }));
  const snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { authPath } });
  assert.equal(snap.status, 'auth_required');
  assert.equal(snap.error.code, 'refresh_failed');
  assert.match(snap.error.message, /codex login/);
  assert.equal(fetch.count(CODEX_TOKEN_URL), 1);
  assert.equal(fetch.count(codex.USAGE_URL), 0, 'a lapsed token is never sent to wham/usage');
  assert.equal(JSON.parse(fs.readFileSync(authPath, 'utf8')).tokens.refresh_token, 'rt-old', 'file untouched on failure');

  let snap2 = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now: later(60), paths: { authPath } });
  assert.equal(snap2.status, 'auth_required');
  assert.equal(snap2.error.code, 'refresh_failed');
  assert.match(snap2.error.message, /codex login/);
  assert.equal(fetch.count(CODEX_TOKEN_URL), 1, 'no second refresh attempt inside the park');
  snap2 = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now: later(11 * 60), paths: { authPath } });
  assert.equal(snap2.status, 'auth_required');
  assert.equal(fetch.count(CODEX_TOKEN_URL), 1, 'still parked once the 10-min spacing alone would allow it');

  // 31 minutes later the permanent park expires and we try again (still rejected).
  await codex.fetchSnapshot({ settings: SETTINGS, fetch, now: later(31 * 60), paths: { authPath } });
  assert.equal(fetch.count(CODEX_TOKEN_URL), 2);

  // The user runs `codex login` (new refresh token, new mtime) → the park is released as soon as the spacing allows.
  writeCodexAuth(dir, { expSecondsFromNow: -61, refreshToken: 'rt-fresh', mtime: NOW + 41 * 60000 });
  await codex.fetchSnapshot({ settings: SETTINGS, fetch, now: later(42 * 60), paths: { authPath } });
  assert.equal(fetch.count(CODEX_TOKEN_URL), 3, 'released before the 30-min park would have elapsed');
  assert.equal(fetch.calls[fetch.calls.length - 1].body.refresh_token, 'rt-fresh');
});

test('codex: 403 / 429 / 5xx / non-JSON / network map to the contract codes, stale keeps last good', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir);
  const lastGood = { plan: 'Team', account: 'x', updatedAt: 5, windows: [{ key: 'primary', percent: 1 }], credits: null };

  // Each poll steps 31 s so the request floor never replays the previous result.
  let snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch: fakeFetch(codexRoutes({ usageStatus: 403 })), now, paths: { authPath }, lastGood });
  assert.equal(snap.status, 'auth_required'); assert.equal(snap.error.code, 'http_403'); assert.equal(snap.error.message, 'status 403');

  snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch: fakeFetch(codexRoutes({ usageStatus: 429 })), now: later(31), paths: { authPath }, lastGood });
  assert.equal(snap.status, 'stale'); assert.equal(snap.error.code, 'http_429'); assert.equal(snap.skipNextCycle, true);
  assert.deepEqual(snap.windows, lastGood.windows); assert.equal(snap.updatedAt, 5);

  codex.resetState(); // the 429 parks the provider for ≥ 60 s (see the dedicated 429 test); clear it for the remaining codes
  snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch: fakeFetch(codexRoutes({ usageStatus: 503 })), now: later(62), paths: { authPath } });
  assert.equal(snap.status, 'error'); assert.equal(snap.error.code, 'http_5xx');

  snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch: fakeFetch(() => response(200, '<html>oops</html>')), now: later(93), paths: { authPath }, lastGood });
  assert.equal(snap.status, 'stale'); assert.equal(snap.error.code, 'parse');

  snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch: fakeFetch(() => new Error('ENOTFOUND chatgpt.com')), now: later(124), paths: { authPath }, lastGood });
  assert.equal(snap.status, 'stale'); assert.equal(snap.error.code, 'network'); assert.equal(snap.plan, 'Team');

  snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch: fakeFetch(() => new Error('ENOTFOUND')), now: later(155), paths: { authPath } });
  assert.equal(snap.status, 'error'); assert.equal(snap.error.code, 'network');
});

test('codex: auth.json written < 30 s ago → refresh deferred (the CLI/desktop is on it); stale with last good; allowed once 30 s old', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir, { expSecondsFromNow: -61, mtime: NOW - 10000 });
  const fetch = fakeFetch(codexRoutes());
  let snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { authPath } });
  assert.equal(snap.status, 'error');
  assert.equal(snap.error.code, 'token_expired');
  assert.match(snap.error.message, /just written/);
  assert.equal(fetch.calls.length, 0);
  const lastGood = { plan: 'Pro', account: 'x', updatedAt: 5, windows: [{ key: 'primary', percent: 1 }], credits: null };
  snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { authPath }, lastGood });
  assert.equal(snap.status, 'stale', 'deferred refresh keeps last good, never auth_required');
  assert.deepEqual(snap.windows, lastGood.windows);
  assert.equal(fetch.calls.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(authPath, 'utf8')).tokens.refresh_token, 'rt-old', 'file untouched');
  // 30 s after the write the refresh goes ahead.
  snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now: later(20), paths: { authPath } });
  assert.equal(snap.status, 'ok');
  assert.deepEqual(fetch.calls.map((c) => c.url), [CODEX_TOKEN_URL, codex.USAGE_URL]);
  assert.equal(codex.FRESH_FILE_MS, 30000);
});

test('codex: at most one refresh attempt per 10 min from this process', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir);
  const goodToken = makeJwt({ exp: Math.floor(NOW / 1000) + 864000, marker: 'fresh' });
  // 1st cycle: 401 → refresh succeeds (attempt #1).
  let fetch = fakeFetch(codexRoutes({ acceptToken: goodToken, refreshReply: response(200, { access_token: goodToken, refresh_token: 'rt-new' }) }));
  let snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { authPath } });
  assert.equal(snap.status, 'ok');
  assert.equal(fetch.count(CODEX_TOKEN_URL), 1);
  assert.equal(JSON.parse(fs.readFileSync(authPath, 'utf8')).tokens.refresh_token, 'rt-new');
  const lastGood = snap;
  fs.utimesSync(authPath, new Date(NOW), new Date(NOW)); // the write-back's real mtime, pinned on the fake clock
  // 5 min later the new token is rejected again (401) → refresh must be deferred, not attempted.
  fetch = fakeFetch(codexRoutes({ acceptToken: 'nobody' }));
  snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now: later(300), paths: { authPath }, lastGood });
  assert.equal(snap.status, 'stale');
  assert.equal(snap.error.code, 'token_expired');
  assert.match(snap.error.message, /next attempt in 5 min/);
  assert.equal(fetch.count(CODEX_TOKEN_URL), 0);
  assert.equal(fetch.count(codex.USAGE_URL), 1, 'the 401 itself is not retried without a refresh');
  // 10 min + after the first attempt → allowed again.
  snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now: later(601), paths: { authPath }, lastGood });
  assert.equal(fetch.count(CODEX_TOKEN_URL), 1);
  assert.equal(snap.error.code, 'http_401', 'refreshed token still rejected → sign-in required');
  assert.equal(codex.REFRESH_SPACING_MS, 10 * 60000);
});

test('codex: transient refresh failure (5xx) → stale / refresh_failed keeping last good; retried after the spacing; error (not auth_required) without last good', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir, { expSecondsFromNow: -61 });
  const lastGood = { plan: 'Pro', account: 'x', updatedAt: 5, windows: [{ key: 'primary', percent: 1 }], credits: null };
  const fetch = fakeFetch(codexRoutes({ refreshReply: response(503, 'down') }));
  let snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { authPath }, lastGood });
  assert.equal(snap.status, 'stale', 'transient failures keep last good');
  assert.equal(snap.error.code, 'refresh_failed');
  assert.match(snap.error.message, /retrying in 10 min/, 'the 1-min back-off is dominated by the 10-min attempt spacing');
  assert.deepEqual(snap.windows, lastGood.windows);
  assert.equal(fetch.count(CODEX_TOKEN_URL), 1);
  assert.equal(fetch.count(codex.USAGE_URL), 0, 'a lapsed token is never sent to wham/usage');
  snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now: later(300), paths: { authPath }, lastGood });
  assert.equal(snap.status, 'stale');
  assert.equal(fetch.count(CODEX_TOKEN_URL), 1, 'no retry inside the spacing');
  await codex.fetchSnapshot({ settings: SETTINGS, fetch, now: later(601), paths: { authPath }, lastGood });
  assert.equal(fetch.count(CODEX_TOKEN_URL), 2, 'retried once the spacing allows');
  assert.equal(JSON.parse(fs.readFileSync(authPath, 'utf8')).tokens.refresh_token, 'rt-old', 'file untouched');

  codex.resetState();
  snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now: later(1300), paths: { authPath } });
  assert.equal(snap.status, 'error', 'a server hiccup never asks the user to sign in again');
  assert.equal(snap.error.code, 'refresh_failed');
});

test('codex: 30 s floor between real usage requests — even a manual refresh returns the previous snapshot', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir);
  const fetch = fakeFetch(codexRoutes());
  const first = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { authPath } });
  assert.equal(first.status, 'ok');
  assert.equal(fetch.count(codex.USAGE_URL), 1);
  const again = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now: later(15), paths: { authPath }, lastGood: first });
  assert.equal(fetch.count(codex.USAGE_URL), 1, 'no request inside 30 s');
  assert.equal(again.status, 'ok');
  assert.equal(again.updatedAt, first.updatedAt, 'previous updatedAt kept');
  assert.deepEqual(again.windows, first.windows);
  await codex.fetchSnapshot({ settings: { ...SETTINGS, refreshInterval: '15' }, fetch, now: later(29), paths: { authPath }, lastGood: first });
  assert.equal(fetch.count(codex.USAGE_URL), 1, 'settings.refreshInterval cannot lower the floor');
  const third = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now: later(30), paths: { authPath }, lastGood: first });
  assert.equal(fetch.count(codex.USAGE_URL), 2);
  assert.equal(third.updatedAt, NOW + 30000);
  assert.equal(codex.USAGE_FLOOR_MS, 30000);

  // A 429's scheduler hint belongs to the cycle that saw it — the floor replay drops it.
  codex.resetState();
  const fetch429 = fakeFetch(codexRoutes({ usageStatus: 429 }));
  const hit = await codex.fetchSnapshot({ settings: SETTINGS, fetch: fetch429, now, paths: { authPath }, lastGood: first });
  assert.equal(hit.skipNextCycle, true);
  const replay = await codex.fetchSnapshot({ settings: SETTINGS, fetch: fetch429, now: later(10), paths: { authPath }, lastGood: first });
  assert.equal(replay.error.code, 'http_429'); assert.equal(replay.skipNextCycle, undefined);
  assert.equal(fetch429.count(codex.USAGE_URL), 1);
});

test('codex: 429 → parked (no request before the back-off), Retry-After honoured (≥ 60 s, ≤ 24 h), else 1 → 2 → 4 → 10 → 10 min; success resets', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir);
  const lastGood = { plan: 'Pro', account: 'x', updatedAt: 5, windows: [{ key: 'primary', percent: 1 }], credits: null };
  const fetch = fakeFetch(codexRoutes({ usageStatus: 429 }));
  const at = (s) => codex.fetchSnapshot({ settings: SETTINGS, fetch, now: later(s), paths: { authPath }, lastGood });

  let snap = await at(0);
  assert.equal(snap.status, 'stale'); assert.equal(snap.error.code, 'http_429'); assert.equal(snap.skipNextCycle, true);
  assert.equal(snap.error.message, `Codex rate limited, retrying at ${codex.hhmm(NOW + 60000)}`);
  snap = await at(45);
  assert.equal(fetch.count(codex.USAGE_URL), 1, 'parked: no request before the back-off elapses (the 30 s floor alone is not enough)');
  assert.equal(snap.status, 'stale'); assert.equal(snap.error.code, 'http_429'); assert.equal(snap.skipNextCycle, undefined);
  assert.deepEqual(snap.windows, lastGood.windows);

  const schedule = [1, 2, 4, 10, 10]; // minutes after each successive 429
  let t = 0;
  for (let i = 1; i < schedule.length; i++) {
    t += schedule[i - 1] * 60;
    snap = await at(t);
    assert.equal(fetch.count(codex.USAGE_URL), i + 1, `request #${i + 1} at +${t}s`);
    assert.equal(snap.error.message, `Codex rate limited, retrying at ${codex.hhmm(NOW + t * 1000 + schedule[i] * 60000)}`);
  }
  assert.deepEqual(codex.RATE_LIMIT_STEPS_MS, [60000, 120000, 240000, 600000]);

  // Retry-After wins over the schedule, floored at 60 s and capped at 24 h.
  const withHeader = (value) => fakeFetch((url, init) => {
    const r = codexRoutes({ usageStatus: 429 })(url, init);
    r.headers = new Map([['retry-after', value]]);
    return r;
  });
  codex.resetState();
  const fetch2 = withHeader('180');
  snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch: fetch2, now, paths: { authPath }, lastGood });
  assert.equal(snap.error.message, `Codex rate limited, retrying at ${codex.hhmm(NOW + 180000)}`);
  await codex.fetchSnapshot({ settings: SETTINGS, fetch: fetch2, now: later(179), paths: { authPath }, lastGood });
  assert.equal(fetch2.count(codex.USAGE_URL), 1);
  await codex.fetchSnapshot({ settings: SETTINGS, fetch: fetch2, now: later(180), paths: { authPath }, lastGood });
  assert.equal(fetch2.count(codex.USAGE_URL), 2);
  codex.resetState();
  snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch: withHeader('5'), now, paths: { authPath }, lastGood });
  assert.equal(snap.error.message, `Codex rate limited, retrying at ${codex.hhmm(NOW + 60000)}`, 'never inside 60 s');
  codex.resetState();
  snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch: withHeader('999999999'), now, paths: { authPath }, lastGood });
  assert.equal(codex._state().rateLimit.until, NOW + codex.RATE_LIMIT_MAX_MS, 'a bogus Retry-After is capped at a day');
  assert.equal(codex.RATE_LIMIT_MAX_MS, 24 * 3600 * 1000);

  // A success clears the schedule; a lapsed token is not refreshed while parked either.
  codex.resetState();
  let status = 429;
  const fetch4 = fakeFetch((url, init) => codexRoutes({ usageStatus: status })(url, init));
  await codex.fetchSnapshot({ settings: SETTINGS, fetch: fetch4, now, paths: { authPath }, lastGood });
  status = 200;
  snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch: fetch4, now: later(60), paths: { authPath }, lastGood });
  assert.equal(snap.status, 'ok');
  status = 429;
  snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch: fetch4, now: later(120), paths: { authPath }, lastGood });
  assert.equal(snap.error.message, `Codex rate limited, retrying at ${codex.hhmm(NOW + 180000)}`, 'schedule restarted at 1 min');
  writeCodexAuth(dir, { expSecondsFromNow: -61 });
  await codex.fetchSnapshot({ settings: SETTINGS, fetch: fetch4, now: later(150), paths: { authPath }, lastGood });
  assert.equal(fetch4.count(CODEX_TOKEN_URL), 0, 'no token refresh while parked');
});

test('codex: a token-endpoint response whose body cannot be read is a transient refresh failure (back-off recorded), never an unexpected error', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir, { expSecondsFromNow: -61 });
  const lastGood = { plan: 'Pro', account: 'x', updatedAt: 5, windows: [{ key: 'primary', percent: 1 }], credits: null };
  const cut = { ok: true, status: 200, headers: new Map(), text: async () => { throw Object.assign(new Error('terminated'), { code: 'UND_ERR_SOCKET' }); } };
  const fetch = fakeFetch(codexRoutes({ refreshReply: cut }));
  const snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { authPath }, lastGood });
  assert.equal(snap.status, 'stale');
  assert.equal(snap.error.code, 'refresh_failed');
  assert.match(snap.error.message, /retrying in 10 min/);
  assert.equal(fetch.count(CODEX_TOKEN_URL), 1);
  assert.equal(fetch.count(codex.USAGE_URL), 0);
  assert.equal(codex._state().refreshBackoff.state().failures, 1, 'the attempt is counted by the back-off');
  assert.equal(JSON.parse(fs.readFileSync(authPath, 'utf8')).tokens.refresh_token, 'rt-old', 'file untouched');
  await codex.fetchSnapshot({ settings: SETTINGS, fetch, now: later(300), paths: { authPath }, lastGood });
  assert.equal(fetch.count(CODEX_TOKEN_URL), 1, 'no retry inside the spacing');
});

test('codex: `codex logout` during a refresh → the new tokens are NOT written back (no resurrected auth.json); auth_required', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir, { expSecondsFromNow: -61 });
  const fetch = fakeFetch((url, init) => {
    if (url === CODEX_TOKEN_URL) fs.unlinkSync(authPath); // the user signs out while our request is in flight
    return codexRoutes()(url, init);
  });
  const snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { authPath } });
  assert.equal(snap.status, 'auth_required');
  assert.equal(snap.error.code, 'refresh_failed');
  assert.equal(fetch.count(codex.USAGE_URL), 0, 'the minted token is not used either');
  assert.deepEqual(fs.readdirSync(dir), [], 'auth.json stays gone, no temp file');
  const snap2 = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now: later(31), paths: { authPath } });
  assert.equal(snap2.error.code, 'no_credentials');
});

test('codex: request timeout aborts via AbortController → network error mentioning timeout', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir);
  const fetch = fakeFetch((url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { authPath }, timeoutMs: 20 });
  assert.equal(snap.status, 'error');
  assert.equal(snap.error.code, 'network');
  assert.match(snap.error.message, /timed out/);
});

test('codex: blocked payload surfaces severity blocked + credits.limitReached', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir);
  const snap = await codex.fetchSnapshot({ settings: SETTINGS, fetch: fakeFetch(codexRoutes({ usage: fixture('codex-usage-blocked.json') })), now, paths: { authPath } });
  assert.equal(snap.status, 'ok');
  assert.ok(snap.windows.every((w) => w.severity === 'blocked'));
  assert.equal(snap.credits.limitReached, true);
});

test('codex: fetchSnapshot never throws even with hostile inputs', async () => {
  const snap = await codex.fetchSnapshot({ settings: null, fetch: () => { throw new TypeError('boom'); }, now, paths: { authPath: path.join(tmpDir(), 'x.json') } });
  assert.equal(snap.status, 'auth_required');
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir);
  const snap2 = await codex.fetchSnapshot({ settings: SETTINGS, fetch: () => { throw new TypeError('boom'); }, now, paths: { authPath } });
  assert.equal(snap2.status, 'error');
  assert.equal(snap2.error.code, 'network');
});

// ---------------------------------------------------------------------------
// Claude (Claude Code credentials)
// ---------------------------------------------------------------------------

test('claude: happy path → ok, session/weekly/weekly_fable (+note), plan, account, extra incl. prepaid credits, Claude Code headers', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir);
  const fetch = fakeFetch(claudeRoutes());
  const snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath } });

  assert.equal(snap.id, 'claude'); assert.equal(snap.name, 'Claude'); assert.equal(snap.source, 'claude_code');
  assert.equal(snap.status, 'ok');
  assert.equal(snap.error, null);
  assert.deepEqual(snap.windows.map((w) => w.key), ['session', 'weekly', 'weekly_fable']);
  assert.deepEqual(snap.windows.map((w) => w.note), [null, null, "Percent of Fable's 50% share of the weekly limit"]);
  assert.equal(snap.plan, 'Max 20x');
  assert.equal(snap.account, 'Tester');
  assert.equal(snap.updatedAt, NOW);
  assert.equal(snap.extra.usedMinor, 7519);
  assert.equal(snap.extra.balanceMinor, 17481, 'prepaid credits fetched on first fill even with the panel collapsed');
  assert.equal(snap.extra.paidMinor, 17480);
  assert.equal(snap.extra.promoMinor, 0);
  assert.equal(snap.credits, null);
  assert.ok(snap.raw.usage && snap.raw.profile && snap.raw.credits);

  assert.deepEqual(fetch.calls.map((c) => c.url), [claude.USAGE_URL, claude.PROFILE_URL, CLAUDE_CREDITS_URL]);
  for (const call of fetch.calls) {
    const h = call.headers;
    assert.equal(h.Authorization, 'Bearer sk-ant-oat01-old');
    assert.equal(h['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(h.Accept, 'application/json');
    assert.equal(h['Content-Type'], 'application/json');
    assert.equal(h['User-Agent'], 'claude-cli/2.1.263 (external, cli)');
    assert.equal(h['x-api-key'], undefined, 'never send x-api-key');
    assert.ok(call.init.signal, 'abort signal attached');
  }
});

test('claude: User-Agent version comes from `claude --version` (detected once, 3 s cap, semver parsed) with a fallback', async () => {
  assert.equal(claude.parseCliVersion('2.1.263 (Claude Code)'), '2.1.263');
  assert.equal(claude.parseCliVersion('claude 3.0.12\n'), '3.0.12');
  assert.equal(claude.parseCliVersion(''), null);
  assert.equal(claude.userAgentFor('2.1.263'), 'claude-cli/2.1.263 (external, cli)');
  assert.equal(claude.USER_AGENT_FALLBACK, 'claude-cli/2.1.263 (external, cli)');

  const seen = [];
  const okExec = (cmd, opts, cb) => { seen.push({ cmd, opts }); cb(null, '2.1.300 (Claude Code)\n', ''); };
  assert.equal(await claude.detectCliVersion({ exec: okExec }), '2.1.300');
  assert.equal(seen[0].cmd, 'claude --version');
  assert.equal(seen[0].opts.timeout, 3000);
  assert.equal(seen[0].opts.windowsHide, true);

  const failExec = (cmd, opts, cb) => cb(Object.assign(new Error('not found'), { code: 'ENOENT' }), '', '');
  assert.equal(await claude.detectCliVersion({ exec: failExec }), '2.1.263', 'fallback when the CLI is missing');
  const throwingExec = () => { throw new Error('spawn failed'); };
  assert.equal(await claude.detectCliVersion({ exec: throwingExec }), '2.1.263');
  const silentExec = () => {}; // never calls back
  assert.equal(await claude.detectCliVersion({ exec: silentExec, timeoutMs: 10 }), '2.1.263', 'guard timer resolves the fallback');

  claude.setCliVersion('9.9.9');
  assert.equal(await claude.getUserAgent(), 'claude-cli/9.9.9 (external, cli)');
});

test('claude: profile is fetched at most once per hour per token', async () => {
  const dir = tmpDir();
  const FAR = NOW + 10 * 3600 * 1000; // keep the token valid for the whole test so no refresh interferes
  const credentialsPath = writeClaudeCreds(dir, { expiresAt: FAR });
  const fetch = fakeFetch(claudeRoutes());
  await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath } });
  await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: () => NOW + 30 * 60000, paths: { credentialsPath } });
  assert.equal(fetch.count('/api/oauth/usage'), 2);
  assert.equal(fetch.count('/api/oauth/profile'), 1, 'cached');
  const snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: () => NOW + 61 * 60000, paths: { credentialsPath } });
  assert.equal(fetch.count('/api/oauth/profile'), 2, 'refetched after an hour');
  assert.equal(snap.account, 'Tester');
  // A new token invalidates the cache.
  writeClaudeCreds(dir, { accessToken: 'sk-ant-oat01-other', expiresAt: FAR });
  await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: () => NOW + 62 * 60000, paths: { credentialsPath } });
  assert.equal(fetch.count('/api/oauth/profile'), 3);
});

test('claude: profile failure is non-fatal (plan still from credentials; credits skipped without an org uuid)', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir);
  const fetch = fakeFetch(claudeRoutes({ profileStatus: 500 }));
  const snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath } });
  assert.equal(snap.status, 'ok');
  assert.equal(snap.plan, 'Max 20x');
  assert.equal(snap.account, null);
  assert.equal(snap.extra.balanceMinor, null);
  assert.equal(fetch.count('/prepaid/credits'), 0);
});

test('claude: a failing /profile is not retried on every poll — 5 min between attempts, previous values kept', async () => {
  const dir = tmpDir();
  const FAR = NOW + 10 * 3600 * 1000;
  const credentialsPath = writeClaudeCreds(dir, { expiresAt: FAR });
  let profileStatus = 200;
  const fetch = fakeFetch((url, init) => {
    if (url === claude.PROFILE_URL && profileStatus === 'throw') return new Error('socket hang up');
    return claudeRoutes({ profileStatus })(url, init);
  });
  // First poll succeeds; an hour later the hourly refetch fails → old profile kept, next attempt 5 min later (not 60 s).
  let snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath } });
  assert.equal(snap.account, 'Tester');
  profileStatus = 500;
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: later(61 * 60), paths: { credentialsPath } });
  assert.equal(fetch.count('/api/oauth/profile'), 2);
  assert.equal(snap.account, 'Tester', 'previous profile kept');
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: later(62 * 60), paths: { credentialsPath } });
  assert.equal(fetch.count('/api/oauth/profile'), 2, 'not hammered on the next poll');
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: later(66 * 60), paths: { credentialsPath } });
  assert.equal(fetch.count('/api/oauth/profile'), 3, 'retried after 5 min');
  assert.equal(claude.PROFILE_RETRY_MS, 5 * 60000);

  // A token with no profile yet: a 403 (setup token) / network failure is spaced the same way.
  claude.resetState(); claude.setCliVersion('2.1.263');
  profileStatus = 403;
  await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath } });
  await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: later(61), paths: { credentialsPath } });
  await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: later(122), paths: { credentialsPath } });
  assert.equal(fetch.count('/api/oauth/profile'), 4, 'one attempt, then parked');
  profileStatus = 'throw';
  await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: later(301), paths: { credentialsPath } });
  assert.equal(fetch.count('/api/oauth/profile'), 5);
  await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: later(362), paths: { credentialsPath } });
  assert.equal(fetch.count('/api/oauth/profile'), 5, 'a thrown request is spaced too');
  profileStatus = 200;
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: later(602), paths: { credentialsPath } });
  assert.equal(fetch.count('/api/oauth/profile'), 6);
  assert.equal(snap.account, 'Tester');
});

test('claude: Claude Code /logout during a refresh → the new tokens are NOT written back (no resurrected credentials); auth_required', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir, { expiresAt: NOW - 61 * 1000 });
  // Variant 1: the whole file is removed while the token request is in flight.
  const fetch = fakeFetch((url, init) => {
    if (url === CLAUDE_TOKEN_URL) fs.unlinkSync(credentialsPath);
    return claudeRoutes()(url, init);
  });
  let snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath } });
  assert.equal(snap.status, 'auth_required');
  assert.equal(snap.error.code, 'refresh_failed');
  assert.equal(fetch.count('/api/oauth/usage'), 0, 'the minted token is not used either');
  assert.deepEqual(fs.readdirSync(dir), [], 'file stays gone, lock released, no temp file');

  // Variant 2: /logout rewrites the file without the claudeAiOauth block (mcpOAuth kept).
  claude.resetState(); claude.setCliVersion('2.1.263');
  const dir2 = tmpDir();
  const credentialsPath2 = writeClaudeCreds(dir2, { expiresAt: NOW - 61 * 1000 });
  const loggedOut = '{"mcpOAuth":{"srv":{"accessToken":"mcp"}}}';
  const fetch2 = fakeFetch((url, init) => {
    if (url === CLAUDE_TOKEN_URL) fs.writeFileSync(credentialsPath2, loggedOut);
    return claudeRoutes()(url, init);
  });
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch: fetch2, now, paths: { credentialsPath: credentialsPath2 } });
  assert.equal(snap.status, 'auth_required');
  assert.equal(fs.readFileSync(credentialsPath2, 'utf8'), loggedOut, 'the logged-out file is left exactly as Claude Code wrote it');
  assert.deepEqual(fs.readdirSync(dir2), ['.credentials.json']);
});

test('claude: a bogus Retry-After (far beyond a day) is capped at 24 h instead of parking the provider until restart', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir, { expiresAt: NOW + 10 * 3600 * 1000 });
  const lastGood = { plan: 'Pro', account: 'p', updatedAt: 9, windows: [{ key: 'session' }], extra: null };
  let snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch: fakeFetch(claudeRoutes({ usageStatus: 429, usageHeaders: { 'retry-after': '999999999' } })), now, paths: { credentialsPath }, lastGood });
  assert.equal(snap.error.code, 'http_429');
  assert.equal(claude._state().rateLimit.until, NOW + claude.RATE_LIMIT_MAX_MS);
  assert.equal(claude.RATE_LIMIT_MAX_MS, 24 * 3600 * 1000);
  claude.resetState(); claude.setCliVersion('2.1.263');
  const farFuture = new Date(NOW + 400 * 24 * 3600 * 1000).toUTCString();
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch: fakeFetch(claudeRoutes({ usageStatus: 429, usageHeaders: { 'retry-after': farFuture } })), now, paths: { credentialsPath }, lastGood });
  assert.equal(claude._state().rateLimit.until, NOW + claude.RATE_LIMIT_MAX_MS, 'HTTP-date form capped too');
  // A realistic 2 h Retry-After is still honoured in full.
  claude.resetState(); claude.setCliVersion('2.1.263');
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch: fakeFetch(claudeRoutes({ usageStatus: 429, usageHeaders: { 'retry-after': '7200' } })), now, paths: { credentialsPath }, lastGood });
  assert.equal(claude._state().rateLimit.until, NOW + 7200 * 1000);
});

test('claude: prepaid credits — only when expanded / compact spend row open / first fill; ≤ 1 per 5 min; failures keep previous values; tranche mapping', async () => {
  const dir = tmpDir();
  const FAR = NOW + 10 * 3600 * 1000;
  const credentialsPath = writeClaudeCreds(dir, { expiresAt: FAR });
  const credits = {
    amount: 2500, currency: 'USD',
    promo_tranches: [{ remaining_amount_minor_units: 500, expires_at: '2026-10-01T00:00:00Z' }],
    tranches: [{ remaining_amount_minor_units: 1700, expires_at: '2027-01-01T00:00:00Z' }, { remaining_amount_minor_units: 300, expires_at: '2026-10-01T00:00:00Z' }],
    next_expires_at: '2026-10-01T00:00:00Z',
  };
  let creditsStatus = 200;
  const fetch = fakeFetch((url, init) => claudeRoutes({ credits, creditsStatus })(url, init));
  const collapsed = { ...SETTINGS, expandedOpen: { claude: false, codex: false } };
  const expanded = { ...SETTINGS, expandedOpen: { claude: true, codex: false } };

  // First fill happens even when collapsed.
  let snap = await claude.fetchSnapshot({ settings: collapsed, fetch, now, paths: { credentialsPath } });
  assert.equal(fetch.count('/prepaid/credits'), 1);
  assert.equal(snap.extra.balanceMinor, 2500);
  assert.equal(snap.extra.promoMinor, 500);
  assert.equal(snap.extra.paidMinor, 2000);
  assert.equal(snap.extra.nextExpiresAt, '2026-10-01T00:00:00.000Z');
  assert.equal(snap.extra.nextExpiryMinor, 800, 'promo 500 + paid 300 both expire at next_expires_at');

  // Collapsed afterwards → no more credit requests, values persist.
  snap = await claude.fetchSnapshot({ settings: collapsed, fetch, now: later(120), paths: { credentialsPath } });
  assert.equal(fetch.count('/prepaid/credits'), 1);
  assert.equal(snap.extra.balanceMinor, 2500, 'previous values carried');

  // Expanded but inside the 5-min window since the last credits fetch → still no request.
  await claude.fetchSnapshot({ settings: expanded, fetch, now: later(200), paths: { credentialsPath } });
  assert.equal(fetch.count('/prepaid/credits'), 1);
  // Expanded and > 5 min later → request. A failing endpoint is non-fatal and keeps the old numbers.
  creditsStatus = 503;
  snap = await claude.fetchSnapshot({ settings: expanded, fetch, now: later(720), paths: { credentialsPath } });
  assert.equal(fetch.count('/prepaid/credits'), 2);
  assert.equal(snap.status, 'ok');
  assert.equal(snap.extra.balanceMinor, 2500, 'failure keeps previous values');
  // The failed attempt also counts towards the 5-min cap.
  await claude.fetchSnapshot({ settings: expanded, fetch, now: later(900), paths: { credentialsPath } });
  assert.equal(fetch.count('/prepaid/credits'), 2);
  // Compact mode with the spend row open behaves like expanded (undefined compactSpendOpen → false).
  await claude.fetchSnapshot({ settings: { ...collapsed, compactMode: true }, fetch, now: later(1100), paths: { credentialsPath } });
  assert.equal(fetch.count('/prepaid/credits'), 2);
  creditsStatus = 200;
  await claude.fetchSnapshot({ settings: { ...collapsed, compactMode: true, compactSpendOpen: true }, fetch, now: later(1200), paths: { credentialsPath } });
  assert.equal(fetch.count('/prepaid/credits'), 3);
});

test('claude: no credentials file / missing claudeAiOauth → auth_required / no_credentials', async () => {
  const dir = tmpDir();
  const fetch = fakeFetch(claudeRoutes());
  let snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath: path.join(dir, '.credentials.json') } });
  assert.equal(snap.status, 'auth_required'); assert.equal(snap.error.code, 'no_credentials');
  fs.writeFileSync(path.join(dir, '.credentials.json'), '{"somethingElse":{}}');
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath: path.join(dir, '.credentials.json') } });
  assert.equal(snap.status, 'auth_required'); assert.equal(snap.error.code, 'no_credentials');
  assert.equal(fetch.calls.length, 0);
});

test('claude: a token close to expiry (−2 min) or just past it (< 60 s grace) is used as-is — NEVER refreshed proactively', async () => {
  const dir = tmpDir();
  const fetch = fakeFetch(claudeRoutes());
  let credentialsPath = writeClaudeCreds(dir, { expiresAt: NOW + 2 * 60000 });
  let snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath } });
  assert.equal(snap.status, 'ok');
  assert.equal(fetch.count('/v1/oauth/token'), 0, 'no refresh at expiresAt − 2 min');
  assert.equal(fetch.calls[0].headers.Authorization, 'Bearer sk-ant-oat01-old');

  claude.resetState(); claude.setCliVersion('2.1.263');
  credentialsPath = writeClaudeCreds(tmpDir(), { expiresAt: NOW - 30000 });
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath } });
  assert.equal(snap.status, 'ok');
  assert.equal(fetch.count('/v1/oauth/token'), 0, 'no refresh inside the 60 s grace after expiresAt');
  assert.ok(!fs.existsSync(lockDirFor(credentialsPath)));
});

test('claude: lapsed token + refresh disabled → auth_required / token_expired, no network, file untouched', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir, { expiresAt: NOW - 61 * 1000 });
  const before = fs.readFileSync(credentialsPath, 'utf8');
  const fetch = fakeFetch(claudeRoutes());
  const snap = await claude.fetchSnapshot({ settings: NO_REFRESH, fetch, now, paths: { credentialsPath } });
  assert.equal(snap.status, 'auth_required');
  assert.equal(snap.error.code, 'token_expired');
  assert.equal(fetch.calls.length, 0);
  assert.equal(fs.readFileSync(credentialsPath, 'utf8'), before);
});

test('claude: lapsed token + refresh enabled → lock, platform.claude.com POST with scope, key-preserving compact write-back, new bearer', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir, { expiresAt: NOW - 61 * 1000, extraOauth: { profile: { p: 1 }, tokenAccount: { uuid: 'x' } } });
  const fetch = fakeFetch(claudeRoutes({ acceptToken: 'sk-ant-oat01-new' }));
  const snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath } });
  assert.equal(snap.status, 'ok');
  assert.equal(fetch.calls[0].url, CLAUDE_TOKEN_URL, 'platform.claude.com first');
  assert.equal(fetch.calls[0].init.method, 'POST');
  assert.deepEqual(fetch.calls[0].body, {
    grant_type: 'refresh_token', refresh_token: 'sk-ant-ort01-FAKE-REFRESH-TOKEN', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    scope: 'user:inference user:profile',
  });
  assert.equal(fetch.calls[0].headers['Content-Type'], 'application/json');
  assert.equal(fetch.calls[0].headers.Accept, 'application/json');
  assert.equal(fetch.calls[0].headers['User-Agent'], 'claude-cli/2.1.263 (external, cli)');
  assert.equal(fetch.calls[0].headers['anthropic-beta'], undefined, 'no anthropic-beta on the token call');
  assert.equal(fetch.calls[1].headers.Authorization, 'Bearer sk-ant-oat01-new');

  const text = fs.readFileSync(credentialsPath, 'utf8');
  assert.ok(!text.includes('\n'), 'compact like Claude Code');
  const onDisk = JSON.parse(text);
  assert.equal(onDisk.claudeAiOauth.accessToken, 'sk-ant-oat01-new');
  assert.equal(onDisk.claudeAiOauth.refreshToken, 'sk-ant-ort01-new');
  assert.equal(onDisk.claudeAiOauth.expiresAt, NOW + 28800 * 1000);
  assert.equal(onDisk.claudeAiOauth.refreshTokenExpiresAt, NOW + 86400 * 1000, 'refresh_token_expires_in mapped');
  assert.deepEqual(onDisk.claudeAiOauth.scopes, ['user:inference', 'user:profile', 'user:sessions:claude_code']);
  assert.equal(onDisk.claudeAiOauth.rateLimitTier, 'default_claude_max_20x');
  assert.equal(onDisk.claudeAiOauth.subscriptionType, 'max');
  assert.deepEqual(onDisk.claudeAiOauth.profile, { p: 1 });
  assert.deepEqual(onDisk.claudeAiOauth.tokenAccount, { uuid: 'x' });
  assert.deepEqual(onDisk.otherKey, { keep: 'me' });
  assert.deepEqual(fs.readdirSync(dir), ['.credentials.json'], 'lock released and no temp file left behind');
});

test('claude: token endpoint falls back to console.anthropic.com only when platform.claude.com gives no answer (404/5xx/network)', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir, { expiresAt: NOW - 61 * 1000 });
  const fetch = fakeFetch(claudeRoutes({ platformStatus: 404, acceptToken: 'sk-ant-oat01-new' }));
  const snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath } });
  assert.equal(snap.status, 'ok');
  assert.deepEqual(fetch.calls.slice(0, 3).map((c) => c.url), [CLAUDE_TOKEN_URL, CLAUDE_LEGACY_TOKEN_URL, claude.USAGE_URL]);

  claude.resetState(); claude.setCliVersion('2.1.263');
  const credentialsPath2 = writeClaudeCreds(tmpDir(), { expiresAt: NOW - 61 * 1000 });
  const fetch2 = fakeFetch(claudeRoutes({ refreshReply: response(400, { error: 'invalid_grant' }) }));
  await claude.fetchSnapshot({ settings: SETTINGS, fetch: fetch2, now, paths: { credentialsPath: credentialsPath2 } });
  assert.deepEqual(fetch2.calls.map((c) => c.url), [CLAUDE_TOKEN_URL], 'a definitive 400 is not retried on the legacy host');
});

test('claude: 401 before local expiry → re-read; unchanged file → one refresh → retry ok', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir, { expiresAt: NOW + 3 * 3600 * 1000 });
  const fetch = fakeFetch(claudeRoutes({ acceptToken: 'sk-ant-oat01-new' }));
  const snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath } });
  assert.equal(snap.status, 'ok');
  assert.deepEqual(fetch.calls.slice(0, 3).map((c) => c.url), [claude.USAGE_URL, CLAUDE_TOKEN_URL, claude.USAGE_URL]);
  assert.equal(fetch.calls[2].headers.Authorization, 'Bearer sk-ant-oat01-new');
  assert.equal(JSON.parse(fs.readFileSync(credentialsPath, 'utf8')).claudeAiOauth.accessToken, 'sk-ant-oat01-new');
});

test('claude: 401 but the file changed in the meantime → retry with the new token, no token endpoint call', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir);
  const fetch = fakeFetch((url, init) => {
    if (url === claude.USAGE_URL && (init.headers.Authorization || '').endsWith('sk-ant-oat01-old')) {
      writeClaudeCreds(dir, { accessToken: 'sk-ant-oat01-theirs', mtime: NOW - 1000 }); // Claude Code rotated
      return response(401, { error: { type: 'authentication_error', message: 'invalid token' } });
    }
    return claudeRoutes({ acceptToken: 'sk-ant-oat01-theirs' })(url, init);
  });
  const snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath } });
  assert.equal(snap.status, 'ok');
  assert.equal(fetch.count('/v1/oauth/token'), 0);
  assert.deepEqual(fetch.calls.slice(0, 2).map((c) => c.headers.Authorization), ['Bearer sk-ant-oat01-old', 'Bearer sk-ant-oat01-theirs']);
});

test('claude: 401 persisting after a refresh → auth_required / http_401 with the sign-in message; refresh disabled → same, no token call', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir);
  const fetch = fakeFetch(claudeRoutes({ acceptToken: 'never-matches' }));
  const snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath } });
  assert.equal(snap.status, 'auth_required');
  assert.equal(snap.error.code, 'http_401');
  assert.equal(snap.error.message, 'Claude Code sign-in expired - run claude to sign in again');
  assert.equal(fetch.count('/api/oauth/usage'), 2, 'usage, refresh, usage — then stop');
  assert.equal(fetch.count('/v1/oauth/token'), 1);

  claude.resetState(); claude.setCliVersion('2.1.263');
  const credentialsPath2 = writeClaudeCreds(tmpDir());
  const fetch2 = fakeFetch(claudeRoutes({ acceptToken: 'never-matches' }));
  const snap2 = await claude.fetchSnapshot({ settings: NO_REFRESH, fetch: fetch2, now, paths: { credentialsPath: credentialsPath2 } });
  assert.equal(snap2.status, 'auth_required'); assert.equal(snap2.error.code, 'http_401');
  assert.equal(fetch2.count('/v1/oauth/token'), 0);
});

test('claude: refresh lock held by another process → give up this cycle (no token call, lock left alone, stale token_expired)', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir, { expiresAt: NOW - 61 * 1000 });
  const lock = lockDirFor(credentialsPath);
  fs.mkdirSync(lock);
  fs.utimesSync(lock, new Date(NOW), new Date(NOW)); // mtime "now" on the fake clock → genuinely held
  const fetch = fakeFetch(claudeRoutes());
  const lastGood = { plan: 'Max 20x', account: 'p', updatedAt: 9, windows: [{ key: 'session' }], extra: null };
  const snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath }, lastGood, lockOptions: NO_WAIT_LOCK });
  assert.equal(snap.status, 'stale');
  assert.equal(snap.error.code, 'token_expired');
  assert.match(snap.error.message, /refresh lock/);
  assert.equal(fetch.calls.length, 0);
  assert.ok(fs.existsSync(lock), 'someone else\'s lock is never removed');
  assert.deepEqual(snap.windows, lastGood.windows);
});

test('claude: a stale refresh lock (> 60 s old) is taken over and released', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir, { expiresAt: NOW - 61 * 1000 });
  const lock = lockDirFor(credentialsPath);
  fs.mkdirSync(lock);
  const old = new Date(NOW - 120000); // 2 min old on the fake clock → abandoned (Claude Code crashed mid-refresh)
  fs.utimesSync(lock, old, old);
  const fetch = fakeFetch(claudeRoutes({ acceptToken: 'sk-ant-oat01-new' }));
  const snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath }, lockOptions: NO_WAIT_LOCK });
  assert.equal(snap.status, 'ok');
  assert.equal(fetch.count('/v1/oauth/token'), 1);
  assert.ok(!fs.existsSync(lock), 'lock released after the refresh');
});

test('claude: credentials written < 30 s ago → refresh deferred (Claude Code is on it)', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir, { expiresAt: NOW - 61 * 1000, mtime: NOW - 10000 });
  const fetch = fakeFetch(claudeRoutes());
  const snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath } });
  assert.equal(snap.status, 'error');
  assert.equal(snap.error.code, 'token_expired');
  assert.match(snap.error.message, /just written/);
  assert.equal(fetch.calls.length, 0);
});

test('claude: at most one refresh attempt per 10 min from this process', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir, { expiresAt: NOW + 3 * 3600 * 1000 });
  // 1st cycle: 401 → refresh succeeds (attempt #1).
  let fetch = fakeFetch(claudeRoutes({ acceptToken: 'sk-ant-oat01-new' }));
  let snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath } });
  assert.equal(snap.status, 'ok');
  assert.equal(fetch.count('/v1/oauth/token'), 1);
  // 5 min later the new token is rejected again (401) → refresh must be deferred, not attempted.
  writeClaudeCreds(dir, { accessToken: 'sk-ant-oat01-new', refreshToken: 'sk-ant-ort01-new', expiresAt: NOW + 3 * 3600 * 1000, mtime: NOW });
  fetch = fakeFetch(claudeRoutes({ acceptToken: 'nobody' }));
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: later(300), paths: { credentialsPath } });
  assert.equal(snap.error.code, 'token_expired');
  assert.match(snap.error.message, /next attempt in 5 min/);
  assert.equal(fetch.count('/v1/oauth/token'), 0);
  // 10 min + after the first attempt → allowed again.
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: later(601), paths: { credentialsPath } });
  assert.equal(fetch.count('/v1/oauth/token'), 1);
});

test('claude: expired refreshTokenExpiresAt → auth_required without touching the network', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir, { expiresAt: NOW - 61 * 1000, refreshTokenExpiresAt: NOW - 1 });
  const fetch = fakeFetch(claudeRoutes());
  const snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath } });
  assert.equal(snap.status, 'auth_required');
  assert.equal(snap.error.code, 'token_expired');
  assert.match(snap.error.message, /sign in again/);
  assert.equal(fetch.calls.length, 0);
});

test('claude: invalid_grant → auth_required, refresh parked 24 h or until the credentials file changes', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir, { expiresAt: NOW - 61 * 1000 });
  const fetch = fakeFetch(claudeRoutes({ refreshReply: response(400, { error: 'invalid_grant' }) }));
  const snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath } });
  assert.equal(snap.status, 'auth_required');
  assert.equal(snap.error.code, 'refresh_failed');
  assert.match(snap.error.message, /sign in again/);
  assert.equal(fetch.count('/v1/oauth/token'), 1);

  let snap2 = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: later(11 * 60), paths: { credentialsPath } });
  assert.equal(snap2.status, 'auth_required'); assert.equal(snap2.error.code, 'refresh_failed');
  assert.equal(fetch.count('/v1/oauth/token'), 1, 'no retry inside the 24 h park');
  snap2 = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: later(23 * 3600), paths: { credentialsPath } });
  assert.equal(fetch.count('/v1/oauth/token'), 1);
  // The user signs in again (new refresh token, new mtime) → the park is released immediately.
  writeClaudeCreds(dir, { expiresAt: NOW - 61 * 1000, refreshToken: 'sk-ant-ort01-fresh', mtime: NOW + 23 * 3600 * 1000 - 120000 });
  await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: later(23 * 3600 + 61), paths: { credentialsPath } });
  assert.equal(fetch.count('/v1/oauth/token'), 2);
  assert.equal(fetch.calls[fetch.calls.length - 1].body.refresh_token, 'sk-ant-ort01-fresh');
});

test('claude: transient refresh failure (5xx on both hosts) → stale refresh_failed, back-off 60 s → 30 min (spacing permitting)', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir, { expiresAt: NOW - 61 * 1000 });
  const lastGood = { plan: 'Max 20x', account: 'p', updatedAt: 9, windows: [{ key: 'session' }], extra: null };
  const fetch = fakeFetch(claudeRoutes({ refreshReply: response(503, 'down') }));
  let snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath }, lastGood });
  assert.equal(snap.status, 'stale', 'transient failures keep last good');
  assert.equal(snap.error.code, 'refresh_failed');
  assert.match(snap.error.message, /retrying in 10 min/, 'the 60 s retry is dominated by the 10-min attempt spacing');
  assert.equal(fetch.count('/v1/oauth/token'), 2, 'both hosts tried once');
  // 10 min later the retry happens; a second failure parks for 30 min.
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: later(601), paths: { credentialsPath }, lastGood });
  assert.equal(fetch.count('/v1/oauth/token'), 4);
  assert.match(snap.error.message, /retrying in 30 min/);
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: later(601 + 20 * 60), paths: { credentialsPath }, lastGood });
  assert.equal(fetch.count('/v1/oauth/token'), 4, 'still parked');
  assert.match(snap.error.message, /retrying in 10 min/);
  await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: later(601 + 30 * 60 + 1), paths: { credentialsPath }, lastGood });
  assert.equal(fetch.count('/v1/oauth/token'), 6, 'retried after 30 min');
});

test('claude: 60 s floor between real usage requests — even a manual refresh returns the previous snapshot', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir);
  const fetch = fakeFetch(claudeRoutes());
  const first = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath } });
  assert.equal(first.status, 'ok');
  const usageCalls = fetch.count('/api/oauth/usage');
  const again = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: later(30), paths: { credentialsPath }, lastGood: first });
  assert.equal(fetch.count('/api/oauth/usage'), usageCalls, 'no request inside 60 s');
  assert.equal(again.status, 'ok');
  assert.equal(again.updatedAt, first.updatedAt, 'previous updatedAt kept');
  assert.deepEqual(again.windows, first.windows);
  await claude.fetchSnapshot({ settings: { ...SETTINGS, refreshInterval: '15' }, fetch, now: later(59), paths: { credentialsPath }, lastGood: first });
  assert.equal(fetch.count('/api/oauth/usage'), usageCalls, 'settings.refreshInterval cannot lower the floor');
  const third = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: later(60), paths: { credentialsPath }, lastGood: first });
  assert.equal(fetch.count('/api/oauth/usage'), usageCalls + 1);
  assert.equal(third.updatedAt, NOW + 60000);
});

test('claude: 429 → stale + skip, message "Rate limited, retrying at hh:mm", back-off 5 → 10 → 20 → 30 → 30 min, Retry-After honoured (≥ 60 s)', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir, { expiresAt: NOW + 10 * 3600 * 1000 });
  const lastGood = { plan: 'Pro', account: 'p', updatedAt: 9, windows: [{ key: 'session' }], extra: { enabled: false } };
  const fetch = fakeFetch(claudeRoutes({ usageStatus: 429, usageBody: { error: { message: 'Rate limited. Please try again later.', type: 'rate_limit_error' } } }));
  const at = (s) => claude.fetchSnapshot({ settings: SETTINGS, fetch, now: later(s), paths: { credentialsPath }, lastGood });

  let snap = await at(0);
  assert.equal(snap.status, 'stale'); assert.equal(snap.error.code, 'http_429'); assert.equal(snap.skipNextCycle, true);
  assert.equal(snap.error.message, `Rate limited, retrying at ${claude.hhmm(NOW + 5 * 60000)}`);
  assert.deepEqual(snap.windows, lastGood.windows); assert.deepEqual(snap.extra, { enabled: false });
  assert.equal(fetch.count('/api/oauth/usage'), 1);

  snap = await at(61);
  assert.equal(fetch.count('/api/oauth/usage'), 1, 'parked: no request before the back-off elapses');
  assert.equal(snap.status, 'stale'); assert.equal(snap.error.code, 'http_429');
  assert.equal(snap.skipNextCycle, undefined);

  const schedule = [5, 10, 20, 30, 30]; // minutes after each successive 429
  let t = 0;
  for (let i = 1; i < schedule.length; i++) {
    t += schedule[i - 1] * 60;
    snap = await at(t);
    assert.equal(fetch.count('/api/oauth/usage'), i + 1, `request #${i + 1} at +${t}s`);
    assert.equal(snap.error.message, `Rate limited, retrying at ${claude.hhmm(NOW + t * 1000 + schedule[i] * 60000)}`);
  }

  // Retry-After header wins over the schedule, but never below 60 s.
  claude.resetState(); claude.setCliVersion('2.1.263');
  const fetch2 = fakeFetch(claudeRoutes({ usageStatus: 429, usageHeaders: { 'retry-after': '120' } }));
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch: fetch2, now, paths: { credentialsPath }, lastGood });
  assert.equal(snap.error.message, `Rate limited, retrying at ${claude.hhmm(NOW + 120000)}`);
  await claude.fetchSnapshot({ settings: SETTINGS, fetch: fetch2, now: later(119), paths: { credentialsPath }, lastGood });
  assert.equal(fetch2.count('/api/oauth/usage'), 1);
  await claude.fetchSnapshot({ settings: SETTINGS, fetch: fetch2, now: later(120), paths: { credentialsPath }, lastGood });
  assert.equal(fetch2.count('/api/oauth/usage'), 2);

  claude.resetState(); claude.setCliVersion('2.1.263');
  const fetch3 = fakeFetch(claudeRoutes({ usageStatus: 429, usageHeaders: { 'retry-after': '5' } }));
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch: fetch3, now, paths: { credentialsPath }, lastGood });
  assert.equal(snap.error.message, `Rate limited, retrying at ${claude.hhmm(NOW + 60000)}`, 'never retry a 429 inside 60 s');

  // A success clears the schedule.
  claude.resetState(); claude.setCliVersion('2.1.263');
  let status = 429;
  const fetch4 = fakeFetch((url, init) => claudeRoutes({ usageStatus: status })(url, init));
  await claude.fetchSnapshot({ settings: SETTINGS, fetch: fetch4, now, paths: { credentialsPath }, lastGood });
  status = 200;
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch: fetch4, now: later(5 * 60), paths: { credentialsPath }, lastGood });
  assert.equal(snap.status, 'ok');
  status = 429;
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch: fetch4, now: later(10 * 60), paths: { credentialsPath }, lastGood });
  assert.equal(snap.error.message, `Rate limited, retrying at ${claude.hhmm(NOW + 15 * 60000)}`, 'schedule restarted at 5 min');
});

test('claude: in-band error — a 200 body without any usage key is a parse failure that keeps last good', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir);
  const lastGood = { plan: 'Pro', account: 'p', updatedAt: 9, windows: [{ key: 'session' }], extra: null };
  let snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch: fakeFetch(claudeRoutes({ usageBody: { type: 'error', error: { message: 'nope' } } })), now, paths: { credentialsPath }, lastGood });
  assert.equal(snap.status, 'stale'); assert.equal(snap.error.code, 'parse');
  assert.deepEqual(snap.windows, lastGood.windows);
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch: fakeFetch(claudeRoutes({ usageBody: { type: 'error' } })), now: later(61), paths: { credentialsPath } });
  assert.equal(snap.status, 'error'); assert.equal(snap.error.code, 'parse');
  // A body that has at least one of the known keys (even null) is a real, if degraded, payload.
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch: fakeFetch(claudeRoutes({ usageBody: { five_hour: null, limits: [] } })), now: later(122), paths: { credentialsPath } });
  assert.equal(snap.status, 'ok'); assert.deepEqual(snap.windows, []);
});

test('claude: 403 with a scope message → auth_required / http_403 about user:profile, parked until the credentials change', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir);
  const fetch = fakeFetch(claudeRoutes({ usageStatus: 403, usageBody: { error: { type: 'permission_error', message: "OAuth token does not meet scope requirement 'user:profile'" } } }));
  let snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath } });
  assert.equal(snap.status, 'auth_required'); assert.equal(snap.error.code, 'http_403');
  assert.match(snap.error.message, /user:profile/);
  assert.equal(fetch.count('/api/oauth/usage'), 1);
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: later(61), paths: { credentialsPath } });
  assert.equal(snap.status, 'auth_required'); assert.equal(snap.error.code, 'http_403');
  assert.equal(fetch.count('/api/oauth/usage'), 1, 'no retry while the credentials are unchanged');
  writeClaudeCreds(dir, { accessToken: 'sk-ant-oat01-with-scope', mtime: NOW });
  await claude.fetchSnapshot({ settings: SETTINGS, fetch, now: later(122), paths: { credentialsPath } });
  assert.equal(fetch.count('/api/oauth/usage'), 2, 'retried after the file changed');

  // A 403 without a scope message is reported with the body message and retried normally.
  claude.resetState(); claude.setCliVersion('2.1.263');
  const fetch2 = fakeFetch(claudeRoutes({ usageStatus: 403 }));
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch: fetch2, now, paths: { credentialsPath } });
  assert.equal(snap.status, 'auth_required'); assert.equal(snap.error.code, 'http_403'); assert.equal(snap.error.message, 'status 403');
  await claude.fetchSnapshot({ settings: SETTINGS, fetch: fetch2, now: later(61), paths: { credentialsPath } });
  assert.equal(fetch2.count('/api/oauth/usage'), 2);
});

test('claude: parse error in credentials → error/parse; network → stale with last good; 5xx → error', async () => {
  const dir = tmpDir();
  const credentialsPath = path.join(dir, '.credentials.json');
  fs.writeFileSync(credentialsPath, '{"claudeAiOauth":');
  let snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch: fakeFetch(claudeRoutes()), now, paths: { credentialsPath } });
  assert.equal(snap.status, 'error'); assert.equal(snap.error.code, 'parse');

  writeClaudeCreds(dir);
  const lastGood = { plan: 'Pro', account: 'p', updatedAt: 9, windows: [{ key: 'session' }], extra: { enabled: false } };
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch: fakeFetch(() => new Error('ECONNRESET')), now, paths: { credentialsPath }, lastGood });
  assert.equal(snap.status, 'stale'); assert.equal(snap.error.code, 'network'); assert.deepEqual(snap.windows, lastGood.windows);
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch: fakeFetch(claudeRoutes({ usageStatus: 500 })), now: later(61), paths: { credentialsPath } });
  assert.equal(snap.status, 'error'); assert.equal(snap.error.code, 'http_5xx');
  snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch: fakeFetch(() => response(200, '<html>oops</html>')), now: later(122), paths: { credentialsPath }, lastGood });
  assert.equal(snap.status, 'stale'); assert.equal(snap.error.code, 'parse');
});

test('claude: request timeout aborts via AbortController → network error mentioning timeout', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir);
  const fetch = fakeFetch((url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const snap = await claude.fetchSnapshot({ settings: SETTINGS, fetch, now, paths: { credentialsPath }, timeoutMs: 20 });
  assert.equal(snap.status, 'error');
  assert.equal(snap.error.code, 'network');
  assert.match(snap.error.message, /timed out/);
});

test('claude: no token ever appears in a log line or an error message across refresh, 401, 403, 429, parse and network paths', async () => {
  const TOKENS = /sk-ant-o[ar]t01-[A-Za-z0-9-]+/;
  const lines = [];
  const log = (...a) => lines.push(a.join(' '));
  log.debug = log; log.warn = log; log.error = log; log.info = log;
  const messages = [];
  const run = async (settings, fetch, opts = {}) => {
    const snap = await claude.fetchSnapshot({ settings, fetch, now: opts.now || now, paths: { credentialsPath: opts.credentialsPath }, log, lastGood: opts.lastGood || null, lockOptions: NO_WAIT_LOCK });
    if (snap.error) messages.push(snap.error.message);
    assert.ok(!('claudeAiOauth' in (snap.raw || {})) && !JSON.stringify(snap).match(TOKENS), 'snapshot carries no token');
    return snap;
  };
  // lapsed → refresh ok; lapsed → invalid_grant; lapsed → 5xx on both hosts; 401 twice; 403 scope; 429; torn file; network.
  await run(SETTINGS, fakeFetch(claudeRoutes({ acceptToken: 'sk-ant-oat01-new' })), { credentialsPath: writeClaudeCreds(tmpDir(), { expiresAt: NOW - 61000 }) });
  claude.resetState(); claude.setCliVersion('2.1.263');
  await run(SETTINGS, fakeFetch(claudeRoutes({ refreshReply: response(400, { error: 'invalid_grant', error_description: 'token sk-ant-ort01-FAKE-REFRESH-TOKEN was revoked' }) })), { credentialsPath: writeClaudeCreds(tmpDir(), { expiresAt: NOW - 61000 }) });
  claude.resetState(); claude.setCliVersion('2.1.263');
  await run(SETTINGS, fakeFetch(claudeRoutes({ refreshReply: response(503, 'down') })), { credentialsPath: writeClaudeCreds(tmpDir(), { expiresAt: NOW - 61000 }) });
  claude.resetState(); claude.setCliVersion('2.1.263');
  await run(SETTINGS, fakeFetch(claudeRoutes({ acceptToken: 'never' })), { credentialsPath: writeClaudeCreds(tmpDir()) });
  claude.resetState(); claude.setCliVersion('2.1.263');
  await run(SETTINGS, fakeFetch(claudeRoutes({ usageStatus: 403, usageBody: { error: { message: 'scope user:profile missing for sk-ant-oat01-old' } } })), { credentialsPath: writeClaudeCreds(tmpDir()) });
  claude.resetState(); claude.setCliVersion('2.1.263');
  await run(SETTINGS, fakeFetch(claudeRoutes({ usageStatus: 429 })), { credentialsPath: writeClaudeCreds(tmpDir()) });
  claude.resetState(); claude.setCliVersion('2.1.263');
  const torn = path.join(tmpDir(), '.credentials.json');
  fs.writeFileSync(torn, '{"claudeAiOauth":{"accessToken":sk-ant-oat01-SECRET,"refreshToken":"sk-ant-ort01-SECRET"}}');
  await run(SETTINGS, fakeFetch(claudeRoutes()), { credentialsPath: torn });
  claude.resetState(); claude.setCliVersion('2.1.263');
  await run(SETTINGS, fakeFetch(() => new Error('connect ECONNREFUSED')), { credentialsPath: writeClaudeCreds(tmpDir()) });

  assert.ok(lines.length > 0 && messages.length > 0, 'the scenarios produced logs and error messages');
  for (const l of lines) assert.ok(!TOKENS.test(l) && !/SECRET/.test(l), `token in log line: ${l}`);
  for (const m of messages) assert.ok(!TOKENS.test(m) && !/SECRET/.test(m), `token in error message: ${m}`);
});

test('claude: fetchSnapshot never throws even with hostile inputs', async () => {
  const snap = await claude.fetchSnapshot({ settings: null, fetch: () => { throw new TypeError('boom'); }, now, paths: { credentialsPath: path.join(tmpDir(), 'x.json') } });
  assert.equal(snap.status, 'auth_required');
  const credentialsPath = writeClaudeCreds(tmpDir());
  const snap2 = await claude.fetchSnapshot({ settings: SETTINGS, fetch: () => { throw new TypeError('boom'); }, now, paths: { credentialsPath } });
  assert.equal(snap2.status, 'error');
  assert.equal(snap2.error.code, 'network');
});

// ---------------------------------------------------------------------------
// Claude web (claude.ai session) — pure parts + injected window fetch
// ---------------------------------------------------------------------------

test('claude-web: module loads without Electron and exposes the §13 surface', () => {
  assert.equal(claudeWeb.id, 'claude'); assert.equal(claudeWeb.name, 'Claude'); assert.equal(claudeWeb.source, 'claude_web');
  for (const fn of ['fetchSnapshot', 'login', 'logout', 'listOrgs', 'selectOrg', 'setSession', 'getSession']) assert.equal(typeof claudeWeb[fn], 'function', fn);
});

test('claude-web: parseBody classifies Cloudflare / HTML / JSON / API errors', () => {
  assert.equal(claudeWeb.parseBody('<!DOCTYPE html><html>Just a moment...</html>').code, 'CloudflareBlocked');
  assert.equal(claudeWeb.parseBody('Enable JavaScript and cookies to continue').code, 'CloudflareChallenge');
  assert.equal(claudeWeb.parseBody('<html><body>500</body></html>').code, 'UnexpectedHTML');
  assert.equal(claudeWeb.parseBody('not json').code, 'InvalidJSON');
  const api = claudeWeb.parseBody('{"error":{"type":"permission_error","message":"nope"}}');
  assert.equal(api.code, 'ApiError');
  assert.equal(claudeWeb.isSessionDeadCode(api.code, api.apiError), true);
  assert.equal(claudeWeb.isSessionDeadCode('Timeout'), false);
  assert.deepEqual(claudeWeb.parseBody('{"five_hour":{"utilization":1}}'), { ok: true, value: { five_hour: { utilization: 1 } } });
  assert.deepEqual(claudeWeb.parseBody('[{"uuid":"a"}]').value, [{ uuid: 'a' }]);
});

test('claude-web: mapOrgs keeps chat-capable orgs and flags teams', () => {
  const orgs = claudeWeb.mapOrgs([
    { uuid: 'a', name: 'API only', capabilities: ['api'] },
    { uuid: 'b', name: 'Personal', capabilities: ['chat', 'claude_pro'], raven_type: null },
    { id: 'c', name: 'Team', capabilities: ['chat'], raven_type: 'team' },
  ]);
  assert.deepEqual(orgs.map(({ id, name, isTeam }) => ({ id, name, isTeam })), [
    { id: 'b', name: 'Personal', isTeam: false }, { id: 'c', name: 'Team', isTeam: true },
  ]);
  assert.deepEqual(claudeWeb.mapOrgs({ error: 'x' }), []);
});

test('claude-web: no session → auth_required / no_credentials without touching Electron', async () => {
  const snap = await claudeWeb.fetchSnapshot({ settings: SETTINGS, now, fetchJson: async () => { throw new Error('should not be called'); } });
  assert.equal(snap.status, 'auth_required');
  assert.equal(snap.error.code, 'no_credentials');
  assert.equal(snap.source, 'claude_web');
});

test('claude-web: usage only when collapsed; extended endpoints when expanded; a failing extended endpoint is not fatal', async () => {
  claudeWeb.setSession({ sessionKey: 'sk-ant-sid01-FAKE', organizationId: 'org-1' });
  const seen = [];
  const fetchJson = async (urls) => {
    seen.push(urls);
    return urls.map((u) => {
      if (u.endsWith('/usage')) return { ok: true, value: fixture('claude-usage.json') };
      if (u.endsWith('/overage_spend_limit')) return { ok: false, code: 'UnexpectedHTML', message: '<html>500' }; // the original's logout bug
      if (u.endsWith('/prepaid/credits')) return { ok: true, value: { amount: 1234, currency: 'USD', tranches: [{ remaining_amount_minor_units: 1234, expires_at: '2027-01-01T00:00:00Z' }], next_expires_at: '2027-01-01T00:00:00Z' } };
      return { ok: false, code: 'LoadFailed', message: 'x' };
    });
  };
  let snap = await claudeWeb.fetchSnapshot({ settings: SETTINGS, now, fetchJson });
  assert.equal(snap.status, 'ok');
  assert.deepEqual(seen[0], ['https://claude.ai/api/organizations/org-1/usage']);
  assert.deepEqual(snap.windows.map((w) => w.key), ['session', 'weekly', 'weekly_fable']);
  assert.equal(snap.extra.balanceMinor, null);

  // Each poll steps 60 s so the request floor never replays the previous result.
  snap = await claudeWeb.fetchSnapshot({ settings: { ...SETTINGS, expandedOpen: { claude: true, codex: false } }, now: later(60), fetchJson });
  assert.equal(snap.status, 'ok', 'HTML from an extended endpoint must not log the user out');
  assert.equal(seen[1].length, 3);
  assert.equal(snap.extra.balanceMinor, 1234);
  assert.equal(snap.extra.paidMinor, 1234);
  assert.equal(snap.extra.nextExpiryMinor, 1234);

  snap = await claudeWeb.fetchSnapshot({ settings: { ...SETTINGS, compactMode: true, compactSpendOpen: true }, now: later(120), fetchJson });
  assert.equal(seen[2].length, 3, 'compact spend row open also fetches extended data');
});

test('claude-web: 60 s floor between real claude.ai polls — manual refresh / refreshInterval cannot lower it; a session change clears it', async () => {
  claudeWeb.setSession({ sessionKey: 'sk-ant-sid01-FAKE', organizationId: 'org-1' });
  let calls = 0;
  const fetchJson = async (urls) => { calls++; return urls.map(() => ({ ok: true, value: fixture('claude-usage.json') })); };
  const first = await claudeWeb.fetchSnapshot({ settings: SETTINGS, now, fetchJson });
  assert.equal(first.status, 'ok'); assert.equal(calls, 1);
  const again = await claudeWeb.fetchSnapshot({ settings: { ...SETTINGS, refreshInterval: '15' }, now: later(30), fetchJson, lastGood: first });
  assert.equal(calls, 1, 'no hidden-window load inside 60 s');
  assert.equal(again.status, 'ok'); assert.equal(again.updatedAt, first.updatedAt, 'previous snapshot returned unchanged');
  await claudeWeb.fetchSnapshot({ settings: SETTINGS, now: later(59), fetchJson });
  assert.equal(calls, 1);
  const third = await claudeWeb.fetchSnapshot({ settings: SETTINGS, now: later(60), fetchJson });
  assert.equal(calls, 2); assert.equal(third.updatedAt, NOW + 60000);
  assert.equal(claudeWeb.USAGE_FLOOR_MS, 60000);

  // A failed poll is floored too (no retry storm), but a new session / org is polled at once — a fresh login must not
  // keep showing the previous session's "log in" result for a minute.
  const dead = async () => { calls++; return [{ ok: false, code: 'CloudflareBlocked', message: 'Just a moment' }]; };
  let snap = await claudeWeb.fetchSnapshot({ settings: SETTINGS, now: later(120), fetchJson: dead });
  assert.equal(snap.status, 'auth_required'); assert.equal(calls, 3);
  snap = await claudeWeb.fetchSnapshot({ settings: SETTINGS, now: later(130), fetchJson });
  assert.equal(snap.status, 'auth_required'); assert.equal(calls, 3, 'the failure is replayed inside the floor');
  claudeWeb.setSession({ sessionKey: 'sk-ant-sid01-NEW', organizationId: 'org-1' });
  snap = await claudeWeb.fetchSnapshot({ settings: SETTINGS, now: later(131), fetchJson });
  assert.equal(snap.status, 'ok'); assert.equal(calls, 4, 'setSession clears the floor');
  await claudeWeb.selectOrg('org-2');
  await claudeWeb.fetchSnapshot({ settings: SETTINGS, now: later(132), fetchJson });
  assert.equal(calls, 5, 'selectOrg clears the floor');
});

test('claude-web: settings.claudeOrganizationId is the org fallback; dead session → auth_required/http_401; timeout → network', async () => {
  claudeWeb.setSession({ sessionKey: 'sk-ant-sid01-FAKE' });
  const urlsSeen = [];
  let snap = await claudeWeb.fetchSnapshot({ settings: { ...SETTINGS, claudeOrganizationId: 'org-9' }, now, fetchJson: async (urls) => { urlsSeen.push(...urls); return [{ ok: true, value: fixture('claude-usage.json') }]; } });
  assert.equal(snap.status, 'ok');
  assert.equal(urlsSeen[0], 'https://claude.ai/api/organizations/org-9/usage');

  // Each poll steps 60 s so the request floor never replays the previous result.
  const lastGood = { plan: null, account: null, updatedAt: 3, windows: [{ key: 'session' }], extra: null };
  snap = await claudeWeb.fetchSnapshot({ settings: { ...SETTINGS, claudeOrganizationId: 'org-9' }, now: later(60), lastGood, fetchJson: async () => [{ ok: false, code: 'CloudflareBlocked', message: 'Just a moment' }] });
  assert.equal(snap.status, 'auth_required'); assert.equal(snap.error.code, 'http_401'); assert.deepEqual(snap.windows, lastGood.windows);

  snap = await claudeWeb.fetchSnapshot({ settings: { ...SETTINGS, claudeOrganizationId: 'org-9' }, now: later(120), lastGood, fetchJson: async () => [{ ok: false, code: 'Timeout', message: 'Request timeout' }] });
  assert.equal(snap.status, 'stale'); assert.equal(snap.error.code, 'network');

  snap = await claudeWeb.fetchSnapshot({ settings: { ...SETTINGS, claudeOrganizationId: 'org-9' }, now: later(180), fetchJson: async () => [{ ok: true, value: { unrelated: true } }] });
  assert.equal(snap.status, 'error'); assert.equal(snap.error.code, 'parse');

  await claudeWeb.logout();
  assert.deepEqual(claudeWeb.getSession(), { sessionKey: false, organizationId: null, organizations: [] });
  await claudeWeb.selectOrg('org-2');
  assert.equal(claudeWeb.getSession().organizationId, 'org-2');
});
