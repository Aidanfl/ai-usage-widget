'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const t = require('../src/main/providers/tokens.js');

// --- helpers ----------------------------------------------------------------

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
/** Synthetic (unsigned) JWT — decodeJwt never verifies signatures. */
const makeJwt = (claims) => `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(claims)}.FAKESIG`;

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aiuw-tokens-'));
const noSleep = async () => {};

/** Minimal Response-like object for the injected fetch. */
function response(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers: new Map(Object.entries(headers)), text: async () => text, json: async () => JSON.parse(text) };
}

/** Fake fetch that records calls and replies from a queue (or a function). */
function fakeFetch(replies) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const next = typeof replies === 'function' ? replies(url, init, calls.length) : replies.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

// --- JWT ----------------------------------------------------------------------

test('decodeJwt / jwtExpiryMs on a synthetic JWT', () => {
  const claims = { exp: 1789500358, iat: 1788636358, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } };
  const jwt = makeJwt(claims);
  assert.deepEqual(t.decodeJwt(jwt), claims);
  assert.equal(t.jwtExpiryMs(jwt), 1789500358 * 1000);
  assert.equal(t.jwtExpiryMs(makeJwt({ sub: 'x' })), null);
  assert.equal(t.decodeJwt('not.a-jwt'), null);
  assert.equal(t.decodeJwt('garbage'), null);
  assert.equal(t.decodeJwt(''), null);
  assert.equal(t.decodeJwt(null), null);
  assert.equal(t.decodeJwt(42), null);
  // Payload that decodes to JSON but not an object
  assert.equal(t.decodeJwt(`x.${Buffer.from('"str"').toString('base64url')}.y`), null);
});

// --- readJsonFile -------------------------------------------------------------

test('readJsonFile: missing → null, valid → object, persistent parse error → throws code parse after one retry', async () => {
  const dir = tmpDir();
  assert.equal(await t.readJsonFile(path.join(dir, 'missing.json')), null);

  const good = path.join(dir, 'good.json');
  fs.writeFileSync(good, '{"a":1}\n');
  assert.deepEqual(await t.readJsonFile(good), { a: 1 });
  assert.deepEqual(await t.readJsonText(good), { data: { a: 1 }, text: '{"a":1}\n' });

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{"a":');
  let sleeps = 0;
  await assert.rejects(
    () => t.readJsonFile(bad, { sleep: async () => { sleeps++; } }),
    (e) => e.code === 'parse',
  );
  assert.equal(sleeps, 1, 'retried exactly once');
});

test('readJsonFile: a file that becomes valid between attempts is returned (writer mid-write)', async () => {
  const dir = tmpDir();
  const p = path.join(dir, 'mid.json');
  fs.writeFileSync(p, '{"a":');
  const data = await t.readJsonFile(p, { sleep: async () => { fs.writeFileSync(p, '{"a":2}'); } });
  assert.deepEqual(data, { a: 2 });
});

// --- writeJsonAtomic ----------------------------------------------------------

test('writeJsonAtomic: round-trip, pretty by default, compact with indent 0, no temp files left behind', async () => {
  const dir = tmpDir();
  const p = path.join(dir, 'out.json');
  const obj = { tokens: { a: 1 }, nested: { list: [1, 2, 3] } };
  await t.writeJsonAtomic(p, obj);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), obj);
  assert.equal(fs.readFileSync(p, 'utf8'), JSON.stringify(obj, null, 2) + '\n');
  await t.writeJsonAtomic(p, { b: 2 }, { indent: 0 });
  assert.equal(fs.readFileSync(p, 'utf8'), '{"b":2}');
  assert.deepEqual(fs.readdirSync(dir), ['out.json'], 'temp file renamed away');
});

test('writeJsonAtomic: retries EPERM/EBUSY on rename with back-off and succeeds', async () => {
  const dir = tmpDir();
  const p = path.join(dir, 'locked.json');
  let failures = 0;
  const delays = [];
  const fakeFs = {
    writeFile: fsp.writeFile,
    rm: fsp.rm,
    rename: async (a, b) => {
      if (failures < 3) { failures++; const e = new Error('EPERM'); e.code = failures === 2 ? 'EBUSY' : 'EPERM'; throw e; }
      return fsp.rename(a, b);
    },
  };
  await t.writeJsonAtomic(p, { ok: true }, { fs: fakeFs, sleep: async (ms) => { delays.push(ms); } });
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { ok: true });
  assert.deepEqual(delays, [50, 100, 200]);
  assert.deepEqual(fs.readdirSync(dir), ['locked.json']);
});

test('writeJsonAtomic: gives up after 6 retries, removes the temp file, rethrows', async () => {
  const dir = tmpDir();
  const p = path.join(dir, 'never.json');
  let attempts = 0;
  const delays = [];
  const fakeFs = {
    writeFile: fsp.writeFile,
    rm: fsp.rm,
    rename: async () => { attempts++; const e = new Error('EPERM'); e.code = 'EPERM'; throw e; },
  };
  await assert.rejects(() => t.writeJsonAtomic(p, { x: 1 }, { fs: fakeFs, sleep: async (ms) => { delays.push(ms); } }), (e) => e.code === 'EPERM');
  assert.equal(attempts, 7, '1 try + 6 retries');
  assert.deepEqual(delays, [50, 100, 200, 400, 800, 1000]);
  assert.deepEqual(fs.readdirSync(dir), [], 'temp file cleaned up');
});

test('writeJsonAtomic: non-retryable error is thrown immediately', async () => {
  const dir = tmpDir();
  const fakeFs = { writeFile: fsp.writeFile, rm: fsp.rm, rename: async () => { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; } };
  let slept = false;
  await assert.rejects(() => t.writeJsonAtomic(path.join(dir, 'x.json'), {}, { fs: fakeFs, sleep: async () => { slept = true; } }), (e) => e.code === 'ENOSPC');
  assert.equal(slept, false);
});

test('detectIndent', () => {
  assert.equal(t.detectIndent('{"a":1}'), 0);
  assert.equal(t.detectIndent('{\n  "a": 1\n}\n'), '  ');
  assert.equal(t.detectIndent('{\n\t"a": 1\n}'), '\t');
  assert.equal(t.detectIndent(undefined), 2);
});

// --- refreshCodexTokens --------------------------------------------------------

function writeCodexAuth(dir, overrides = {}) {
  const auth = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: 'old-id', access_token: 'old-access', refresh_token: 'old-refresh', account_id: 'acct-1' },
    last_refresh: '2026-09-05T19:25:59.234092400Z',
    extra_key_kept: { yes: true },
    ...overrides,
  };
  const p = path.join(dir, 'auth.json');
  fs.writeFileSync(p, JSON.stringify(auth, null, 2) + '\n');
  return p;
}

test('refreshCodexTokens: success rotates tokens, preserves other keys, writes RFC-3339 last_refresh, sends the exact CLI body', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir);
  const fetch = fakeFetch([response(200, { id_token: 'new-id', access_token: 'new-access', refresh_token: 'new-refresh' })]);
  const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);
  const r = await t.refreshCodexTokens({ fetch, authPath, now: () => NOW, expectedRefreshToken: 'old-refresh' });
  assert.equal(r.ok, true);
  assert.equal(r.persisted, true);
  assert.equal(r.tokens.access_token, 'new-access');

  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, 'https://auth.openai.com/oauth/token');
  assert.equal(fetch.calls[0].init.method, 'POST');
  assert.equal(fetch.calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(fetch.calls[0].body, { client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', grant_type: 'refresh_token', refresh_token: 'old-refresh' });
  assert.ok(fetch.calls[0].init.signal, 'request carries an abort signal');

  const onDisk = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  assert.deepEqual(onDisk.tokens, { id_token: 'new-id', access_token: 'new-access', refresh_token: 'new-refresh', account_id: 'acct-1' });
  assert.equal(onDisk.last_refresh, '2026-09-06T12:00:00.000Z');
  assert.deepEqual(onDisk.extra_key_kept, { yes: true });
  assert.equal(onDisk.auth_mode, 'chatgpt');
  assert.equal(onDisk.OPENAI_API_KEY, null);
  assert.ok(fs.readFileSync(authPath, 'utf8').includes('\n  "tokens"'), 'pretty formatting preserved');
});

test('refreshCodexTokens: missing refresh_token / id_token in the reply keep the old values', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir);
  const fetch = fakeFetch([response(200, { access_token: 'new-access' })]);
  const r = await t.refreshCodexTokens({ fetch, authPath });
  assert.equal(r.ok, true);
  const onDisk = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  assert.equal(onDisk.tokens.access_token, 'new-access');
  assert.equal(onDisk.tokens.refresh_token, 'old-refresh');
  assert.equal(onDisk.tokens.id_token, 'old-id');
});

test('refreshCodexTokens: guarded reload — token on disk differs from the one we loaded → no network call', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir, { tokens: { access_token: 'theirs', refresh_token: 'their-refresh', account_id: 'acct-1' } });
  const fetch = fakeFetch([]);
  const r = await t.refreshCodexTokens({ fetch, authPath, expectedRefreshToken: 'old-refresh' });
  assert.equal(r.ok, true);
  assert.equal(r.rotatedByOther, true);
  assert.equal(r.tokens.access_token, 'theirs');
  assert.equal(fetch.calls.length, 0);
});

test('refreshCodexTokens: another process rotates while our request is in flight → our result is dropped, theirs is used', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir);
  const fetch = fakeFetch(() => {
    // Simulate the Codex desktop app rotating the file mid-request.
    writeCodexAuth(dir, { tokens: { access_token: 'desktop-access', refresh_token: 'desktop-refresh', account_id: 'acct-1' } });
    return response(200, { access_token: 'ours', refresh_token: 'ours-refresh' });
  });
  const r = await t.refreshCodexTokens({ fetch, authPath, expectedRefreshToken: 'old-refresh' });
  assert.equal(r.ok, true);
  assert.equal(r.rotatedByOther, true);
  assert.equal(r.tokens.access_token, 'desktop-access');
  assert.equal(JSON.parse(fs.readFileSync(authPath, 'utf8')).tokens.refresh_token, 'desktop-refresh', 'file untouched');
});

test('refreshCodexTokens: permanent vs transient classification', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir);
  const cases = [
    [response(400, { error: { code: 'invalid_grant', message: 'bad' } }), true, 'invalid_grant'],
    [response(400, { error: 'refresh_token_reused' }), true, 'refresh_token_reused'],
    [response(400, { code: 'refresh_token_expired' }), true, 'refresh_token_expired'],
    [response(400, { error: 'refresh_token_invalidated' }), true, 'refresh_token_invalidated'],
    [response(401, 'Unauthorized'), true, 'http_401'],
    [response(400, { error: 'some_unknown_thing' }), false, 'some_unknown_thing'],   // unknown 400 → transient (openusage lesson)
    [response(500, '<html>WAF</html>'), false, 'http_500'],
    [response(503, ''), false, 'http_503'],
    [Object.assign(new Error('ECONNRESET'), { name: 'TypeError' }), false, 'network'],
    [Object.assign(new Error('aborted'), { name: 'AbortError' }), false, 'network'],
    [response(200, { not_a_token: true }), true, 'no_access_token'],
    [response(200, 'not json'), false, 'parse'],
  ];
  for (const [reply, permanent, code] of cases) {
    const fetch = fakeFetch([reply]);
    const r = await t.refreshCodexTokens({ fetch, authPath });
    assert.equal(r.ok, false, `ok for ${code}`);
    assert.equal(r.permanent, permanent, `permanent for ${code}`);
    assert.equal(r.error.code, code);
    assert.equal(JSON.parse(fs.readFileSync(authPath, 'utf8')).tokens.refresh_token, 'old-refresh', 'file untouched on failure');
  }
});

test('refreshCodexTokens: no refresh token / missing file', async () => {
  const dir = tmpDir();
  const r1 = await t.refreshCodexTokens({ fetch: fakeFetch([]), authPath: path.join(dir, 'nope.json') });
  assert.equal(r1.ok, false); assert.equal(r1.permanent, true); assert.equal(r1.error.code, 'no_refresh_token');
  const authPath = writeCodexAuth(dir, { tokens: { access_token: 'x', account_id: 'a' } });
  const r2 = await t.refreshCodexTokens({ fetch: fakeFetch([]), authPath });
  assert.equal(r2.ok, false); assert.equal(r2.permanent, true);
});

// --- refreshClaudeTokens --------------------------------------------------------

const PLATFORM_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CONSOLE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const NOW = 1788700000000;
/** Lock options for tests: no real sleeping, and "held" gives up at once. */
const NO_WAIT = { sleep: async () => {}, totalWaitMs: 0 };

function writeClaudeCreds(dir, oauthOverrides = {}, { compact = true, topLevel = {} } = {}) {
  const creds = {
    claudeAiOauth: {
      accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1000,
      refreshTokenExpiresAt: 4133980800000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x',
      profile: { display_name: 'T' }, clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', tokenAccount: { uuid: 'acct', emailAddress: 't@example.com' },
      ...oauthOverrides,
    },
    mcpOAuth: { someServer: { accessToken: 'mcp-token' } },
    somethingElse: { keep: 'me' },
    ...topLevel,
  };
  const p = path.join(dir, '.credentials.json');
  fs.writeFileSync(p, compact ? JSON.stringify(creds) : JSON.stringify(creds, null, 2) + '\n');
  return p;
}
const lockDirFor = (credentialsPath) => path.join(path.dirname(credentialsPath), '.oauth_refresh.lock');

test('refreshClaudeTokens: platform.claude.com POST with scope + Claude Code headers; write-back overrides the token fields and preserves every other key, compact, via <target>.tmp.<8hex>', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir);
  const seenTmp = [];
  const watcher = fs.watch(dir, (ev, file) => { if (file && /\.tmp\./.test(file)) seenTmp.push(file); });
  const fetch = fakeFetch([response(200, {
    access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 28800, refresh_token_expires_in: 118000,
    scope: 'user:inference user:profile user:sessions:claude_code', account: { uuid: 'acct', email_address: 't@example.com' },
  })]);
  const r = await t.refreshClaudeTokens({ fetch, credentialsPath, now: () => NOW, expectedRefreshToken: 'old-refresh', expectedAccessToken: 'old-access', userAgent: 'claude-cli/2.1.263 (external, cli)' });
  watcher.close();
  assert.equal(r.ok, true);
  assert.equal(r.persisted, true);
  assert.equal(r.oauth.accessToken, 'new-access');
  assert.deepEqual(r.account, { uuid: 'acct', email_address: 't@example.com' });

  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, PLATFORM_TOKEN_URL);
  assert.equal(fetch.calls[0].init.method, 'POST');
  assert.deepEqual(fetch.calls[0].init.headers, { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'claude-cli/2.1.263 (external, cli)' });
  assert.deepEqual(fetch.calls[0].body, {
    grant_type: 'refresh_token', refresh_token: 'old-refresh', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', scope: 'user:inference user:profile',
  });
  assert.ok(fetch.calls[0].init.signal, 'request carries an abort signal');

  const text = fs.readFileSync(credentialsPath, 'utf8');
  assert.ok(!text.includes('\n'), 'stays single-line like Claude Code writes it');
  const onDisk = JSON.parse(text);
  assert.deepEqual(onDisk.claudeAiOauth, {
    accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: NOW + 28800 * 1000, refreshTokenExpiresAt: NOW + 118000 * 1000,
    scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x',
    profile: { display_name: 'T' }, clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', tokenAccount: { uuid: 'acct', emailAddress: 't@example.com' },
  });
  assert.deepEqual(onDisk.mcpOAuth, { someServer: { accessToken: 'mcp-token' } });
  assert.deepEqual(onDisk.somethingElse, { keep: 'me' });
  assert.deepEqual(fs.readdirSync(dir), ['.credentials.json'], 'temp file renamed away, lock directory removed');
  // fs.watch is best-effort on Windows; when it did report the staging file, it must have Claude Code's shape.
  for (const f of seenTmp) assert.match(f, /^\.credentials\.json\.tmp\.[0-9a-f]{8}$/);
  assert.match(path.basename(t.claudeTempPath(credentialsPath)), /^\.credentials\.json\.tmp\.[0-9a-f]{8}$/);
});

test('refreshClaudeTokens: missing refresh_token / refresh_token_expires_in / scope in the reply keep the old values; no scopes on disk → default scope list', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir, { scopes: undefined });
  const fetch = fakeFetch([response(200, { access_token: 'a', expires_in: 60 })]);
  const r = await t.refreshClaudeTokens({ fetch, credentialsPath, now: () => NOW });
  assert.equal(r.ok, true);
  assert.equal(fetch.calls[0].body.scope, t.CLAUDE_DEFAULT_SCOPES.join(' '));
  const onDisk = JSON.parse(fs.readFileSync(credentialsPath, 'utf8')).claudeAiOauth;
  assert.equal(onDisk.accessToken, 'a');
  assert.equal(onDisk.refreshToken, 'old-refresh', 'no rotation when the reply lacks refresh_token');
  assert.equal(onDisk.refreshTokenExpiresAt, 4133980800000, 'kept');
  assert.equal(onDisk.scopes, undefined, 'not invented');
  assert.equal(onDisk.expiresAt, NOW + 60000);
});

test('refreshClaudeTokens: falls back to console.anthropic.com on 404 / 405 / 5xx / network, never on a definitive 4xx', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir);
  for (const first of [response(404, 'not found'), response(405, 'nope'), response(502, 'bad gateway'), new Error('ENOTFOUND')]) {
    const fetch = fakeFetch([first, response(200, { access_token: 'via-console', expires_in: 60 })]);
    const r = await t.refreshClaudeTokens({ fetch, credentialsPath });
    assert.equal(r.ok, true, `fallback after ${first.status || first.message}`);
    assert.deepEqual(fetch.calls.map((c) => c.url), [PLATFORM_TOKEN_URL, CONSOLE_TOKEN_URL]);
    assert.equal(r.oauth.accessToken, 'via-console');
  }
  const fetch = fakeFetch([response(400, { error: 'invalid_grant', error_description: 'Refresh token revoked' })]);
  const r = await t.refreshClaudeTokens({ fetch, credentialsPath });
  assert.equal(r.ok, false);
  assert.equal(r.permanent, true);
  assert.equal(r.error.code, 'invalid_grant');
  assert.equal(r.error.message, 'Refresh token revoked');
  assert.equal(fetch.calls.length, 1, 'no alias attempt after a definitive answer');
  assert.ok(!fs.existsSync(lockDirFor(credentialsPath)), 'lock released on failure too');
});

test('refreshClaudeTokens: network failure on both hosts is transient; guarded reload (refresh OR access token changed) skips the network', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir);
  const fetch = fakeFetch([new Error('ENOTFOUND'), new Error('ENOTFOUND')]);
  const r = await t.refreshClaudeTokens({ fetch, credentialsPath });
  assert.equal(r.ok, false); assert.equal(r.permanent, false); assert.equal(r.error.code, 'network');
  assert.equal(fetch.calls.length, 2);

  const fetch2 = fakeFetch([]);
  const r2 = await t.refreshClaudeTokens({ fetch: fetch2, credentialsPath, expectedRefreshToken: 'different' });
  assert.equal(r2.ok, true); assert.equal(r2.rotatedByOther, true); assert.equal(fetch2.calls.length, 0);
  const r3 = await t.refreshClaudeTokens({ fetch: fetch2, credentialsPath, expectedRefreshToken: 'old-refresh', expectedAccessToken: 'not-what-is-on-disk' });
  assert.equal(r3.ok, true); assert.equal(r3.rotatedByOther, true); assert.equal(r3.oauth.accessToken, 'old-access'); assert.equal(fetch2.calls.length, 0);
});

test('refreshClaudeTokens: under the lock the file is re-read — tokens landed by another process while we waited win', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir);
  const fetch = fakeFetch([]);
  // A fake fs whose mkdir "waits" for the lock and, while waiting, the other process lands fresh tokens.
  const lockFs = {
    ...fsp,
    mkdir: async (p) => {
      writeClaudeCreds(dir, { accessToken: 'theirs', refreshToken: 'their-refresh' });
      return fsp.mkdir(p);
    },
  };
  const r = await t.refreshClaudeTokens({ fetch, credentialsPath, expectedRefreshToken: 'old-refresh', expectedAccessToken: 'old-access', lockOptions: { fs: lockFs } });
  assert.equal(r.ok, true);
  assert.equal(r.rotatedByOther, true);
  assert.equal(r.oauth.accessToken, 'theirs');
  assert.equal(fetch.calls.length, 0, 'no token endpoint call');
  assert.ok(!fs.existsSync(lockDirFor(credentialsPath)), 'lock released');
});

test('refreshClaudeTokens: another process rotates while our request is in flight → our result is dropped, theirs is used', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir);
  const fetch = fakeFetch(() => {
    writeClaudeCreds(dir, { accessToken: 'cc-access', refreshToken: 'cc-refresh' });
    return response(200, { access_token: 'ours', refresh_token: 'ours-refresh', expires_in: 10 });
  });
  const r = await t.refreshClaudeTokens({ fetch, credentialsPath, expectedRefreshToken: 'old-refresh' });
  assert.equal(r.ok, true);
  assert.equal(r.rotatedByOther, true);
  assert.equal(r.oauth.accessToken, 'cc-access');
  assert.equal(JSON.parse(fs.readFileSync(credentialsPath, 'utf8')).claudeAiOauth.refreshToken, 'cc-refresh', 'file untouched');
});

test('refreshClaudeTokens: lock held by a live process → lockHeld, no network, lock left in place; stale lock (> 60 s) → taken over', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir);
  const lock = lockDirFor(credentialsPath);
  fs.mkdirSync(lock);
  const fetch = fakeFetch([]);
  const r = await t.refreshClaudeTokens({ fetch, credentialsPath, lockOptions: NO_WAIT });
  assert.equal(r.ok, false);
  assert.equal(r.lockHeld, true);
  assert.equal(r.permanent, false);
  assert.equal(r.error.code, 'lock_held');
  assert.equal(fetch.calls.length, 0);
  assert.ok(fs.existsSync(lock), 'never removes a live lock');

  const old = new Date(Date.now() - 61000);
  fs.utimesSync(lock, old, old);
  const fetch2 = fakeFetch([response(200, { access_token: 'after-takeover', expires_in: 10 })]);
  const r2 = await t.refreshClaudeTokens({ fetch: fetch2, credentialsPath, lockOptions: NO_WAIT });
  assert.equal(r2.ok, true);
  assert.equal(r2.oauth.accessToken, 'after-takeover');
  assert.ok(!fs.existsSync(lock), 'released after use');
  // lock: false skips the lock entirely (callers that already hold it).
  fs.mkdirSync(lock);
  const r3 = await t.refreshClaudeTokens({ fetch: fakeFetch([response(200, { access_token: 'x', expires_in: 10 })]), credentialsPath, lock: false });
  assert.equal(r3.ok, true);
  assert.ok(fs.existsSync(lock));
});

test('refreshClaudeTokens: pretty-printed credential files are rewritten compact (Claude Code style)', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir, {}, { compact: false });
  const fetch = fakeFetch([response(200, { access_token: 'a', expires_in: 10 })]);
  await t.refreshClaudeTokens({ fetch, credentialsPath });
  const text = fs.readFileSync(credentialsPath, 'utf8');
  assert.ok(!text.includes('\n'));
  assert.deepEqual(JSON.parse(text).somethingElse, { keep: 'me' });
});

test('refreshClaudeTokens: no refresh token / missing file / non-JSON reply / 2xx without a token', async () => {
  const dir = tmpDir();
  const r1 = await t.refreshClaudeTokens({ fetch: fakeFetch([]), credentialsPath: path.join(dir, 'nope.json') });
  assert.equal(r1.ok, false); assert.equal(r1.permanent, true); assert.equal(r1.error.code, 'no_refresh_token');
  const credentialsPath = writeClaudeCreds(dir, { refreshToken: undefined });
  const r2 = await t.refreshClaudeTokens({ fetch: fakeFetch([]), credentialsPath });
  assert.equal(r2.ok, false); assert.equal(r2.permanent, true);
  writeClaudeCreds(dir);
  const r3 = await t.refreshClaudeTokens({ fetch: fakeFetch([response(200, 'not json')]), credentialsPath });
  assert.equal(r3.ok, false); assert.equal(r3.permanent, false); assert.equal(r3.error.code, 'parse');
  const r4 = await t.refreshClaudeTokens({ fetch: fakeFetch([response(200, { nope: 1 })]), credentialsPath });
  assert.equal(r4.ok, false); assert.equal(r4.permanent, true); assert.equal(r4.error.code, 'no_access_token');
  assert.equal(JSON.parse(fs.readFileSync(credentialsPath, 'utf8')).claudeAiOauth.accessToken, 'old-access', 'file untouched on failure');
  assert.ok(!fs.existsSync(lockDirFor(credentialsPath)));
});

// --- acquireLock ------------------------------------------------------------------

/** In-memory fs for the lock helper: a Set of existing lock paths + their mtimes, with a fake clock. */
function fakeLockFs(clock, { existing = null, mtimeMs = null } = {}) {
  const dirs = new Map();
  if (existing) dirs.set(existing, mtimeMs == null ? clock.now() : mtimeMs);
  const fsx = {
    calls: [],
    mkdir: async (p) => { fsx.calls.push(['mkdir', p]); if (dirs.has(p)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); dirs.set(p, clock.now()); },
    stat: async (p) => { if (!dirs.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { mtimeMs: dirs.get(p) }; },
    rm: async (p) => { fsx.calls.push(['rm', p]); dirs.delete(p); },
    utimes: async (p, a, m) => { fsx.calls.push(['utimes', p]); if (dirs.has(p)) dirs.set(p, m.getTime()); },
    has: (p) => dirs.has(p),
    release: (p) => dirs.delete(p),
  };
  return fsx;
}
function fakeClock(start = 1000000) {
  const c = { t: start, now: () => c.t, sleep: async (ms) => { c.t += ms; c.slept.push(ms); }, slept: [] };
  return c;
}

test('acquireLock: free → acquired at once; release() removes it and is idempotent', async () => {
  const clock = fakeClock();
  const fsx = fakeLockFs(clock);
  const r = await t.acquireLock('/cfg/.oauth_refresh.lock', { fs: fsx, now: clock.now, sleep: clock.sleep });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.ok(fsx.has('/cfg/.oauth_refresh.lock'));
  await r.release();
  assert.ok(!fsx.has('/cfg/.oauth_refresh.lock'));
  await r.release(); // no throw
  assert.equal(fsx.calls.filter((c) => c[0] === 'rm').length, 1);
});

test('acquireLock: contended lock is polled every 1–2 s and acquired once released; still held after 7.5 s → give up', async () => {
  const clock = fakeClock();
  const fsx = fakeLockFs(clock, { existing: '/cfg/.oauth_refresh.lock' });
  let polls = 0;
  const sleep = async (ms) => { await clock.sleep(ms); if (++polls === 3) fsx.release('/cfg/.oauth_refresh.lock'); };
  const r = await t.acquireLock('/cfg/.oauth_refresh.lock', { fs: fsx, now: clock.now, sleep, random: () => 0.5 });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 4);
  assert.deepEqual(clock.slept, [1500, 1500, 1500]);
  await r.release();

  const clock2 = fakeClock();
  const fsx2 = fakeLockFs(clock2, { existing: '/cfg/.oauth_refresh.lock' });
  const r2 = await t.acquireLock('/cfg/.oauth_refresh.lock', { fs: fsx2, now: clock2.now, sleep: clock2.sleep, random: () => 0 });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'held');
  assert.ok(clock2.t - 1000000 >= 7500 && clock2.t - 1000000 < 9000, `waited ~7.5 s (${clock2.t - 1000000} ms)`);
  assert.ok(fsx2.has('/cfg/.oauth_refresh.lock'), 'a live lock is never removed');
  assert.equal(t.LOCK_TOTAL_WAIT_MS, 7500);
  assert.equal(t.LOCK_STALE_MS, 60000);
});

test('acquireLock: a lock older than 60 s is stale → removed and taken over without waiting', async () => {
  const clock = fakeClock();
  const fsx = fakeLockFs(clock, { existing: '/cfg/.oauth_refresh.lock', mtimeMs: clock.now() - 60001 });
  const r = await t.acquireLock('/cfg/.oauth_refresh.lock', { fs: fsx, now: clock.now, sleep: clock.sleep });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.deepEqual(clock.slept, []);
  assert.deepEqual(fsx.calls.map((c) => c[0]), ['mkdir', 'rm', 'mkdir']);
  await r.release();
  // Exactly 60 s old is NOT stale yet.
  const fsx2 = fakeLockFs(clock, { existing: '/cfg/.oauth_refresh.lock', mtimeMs: clock.now() - 60000 });
  const r2 = await t.acquireLock('/cfg/.oauth_refresh.lock', { fs: fsx2, now: clock.now, sleep: clock.sleep, totalWaitMs: 0 });
  assert.equal(r2.ok, false); assert.equal(r2.reason, 'held');
});

test('acquireLock: mkdir errors other than EEXIST are reported, never thrown; the held lock is touched every `updateMs`', async () => {
  const clock = fakeClock();
  const fsx = fakeLockFs(clock);
  fsx.mkdir = async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  const r = await t.acquireLock('/missing/.oauth_refresh.lock', { fs: fsx, now: clock.now, sleep: clock.sleep });
  assert.equal(r.ok, false); assert.equal(r.reason, 'error'); assert.equal(r.error.code, 'ENOENT');

  const fsx2 = fakeLockFs(clock);
  const held = await t.acquireLock('/cfg/.oauth_refresh.lock', { fs: fsx2, now: clock.now, sleep: clock.sleep, updateMs: 5 });
  await new Promise((res) => setTimeout(res, 40));
  await held.release();
  assert.ok(fsx2.calls.some((c) => c[0] === 'utimes'), 'mtime refreshed while held');
});

// --- writeJsonAtomic (Claude staging-file options) ----------------------------------

test('writeJsonAtomic: tmpPath + fsync write through <target>.tmp.<8hex>, exclusive create refuses an existing staging file', async () => {
  const dir = tmpDir();
  const p = path.join(dir, '.credentials.json');
  await t.writeJsonAtomic(p, { a: 1 }, { indent: 0, tmpPath: t.claudeTempPath, fsync: true });
  assert.equal(fs.readFileSync(p, 'utf8'), '{"a":1}');
  assert.deepEqual(fs.readdirSync(dir), ['.credentials.json']);

  const fixedTmp = path.join(dir, '.credentials.json.tmp.deadbeef');
  fs.writeFileSync(fixedTmp, 'someone else is writing');
  await assert.rejects(() => t.writeJsonAtomic(p, { b: 2 }, { indent: 0, tmpPath: () => fixedTmp, fsync: true }), (e) => e.code === 'EEXIST');
  await assert.rejects(() => t.writeJsonAtomic(p, { b: 2 }, { indent: 0, tmpPath: () => fixedTmp }), (e) => e.code === 'EEXIST');
  assert.equal(fs.readFileSync(p, 'utf8'), '{"a":1}', 'target untouched');
});

// --- regressions from the adversarial credential review -----------------------------

test('writeJsonAtomic: a failed staging write removes its own temp file (fsync and plain paths); a foreign EEXIST staging file is left alone', async () => {
  const dir = tmpDir();
  const p = path.join(dir, '.credentials.json');
  const enospc = () => Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
  const fsyncFs = {
    ...fsp,
    open: async (tmp, flag, mode) => {
      const fh = await fsp.open(tmp, flag, mode);
      return { writeFile: async () => { throw enospc(); }, sync: () => fh.sync(), close: () => fh.close() };
    },
  };
  await assert.rejects(() => t.writeJsonAtomic(p, { a: 1 }, { fs: fsyncFs, indent: 0, tmpPath: t.claudeTempPath, fsync: true }), (e) => e.code === 'ENOSPC');
  assert.deepEqual(fs.readdirSync(dir), [], 'fsync path: no <target>.tmp.<hex> left behind');

  const plainFs = { ...fsp, writeFile: async (tmp, body, opts) => { await fsp.writeFile(tmp, 'partial', opts); throw enospc(); } };
  await assert.rejects(() => t.writeJsonAtomic(p, { a: 1 }, { fs: plainFs, indent: 0 }), (e) => e.code === 'ENOSPC');
  assert.deepEqual(fs.readdirSync(dir), [], 'plain path: no temp file left behind');

  const foreign = path.join(dir, '.credentials.json.tmp.deadbeef');
  fs.writeFileSync(foreign, 'theirs');
  await assert.rejects(() => t.writeJsonAtomic(p, { a: 1 }, { indent: 0, tmpPath: () => foreign, fsync: true }), (e) => e.code === 'EEXIST');
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'theirs', 'another writer\'s staging file is never removed');
});

test('readJsonText: a parse error never echoes file content (V8 quotes a window of the source text around the error)', async () => {
  const dir = tmpDir();
  const p = path.join(dir, '.credentials.json');
  // An unquoted token is the corruption shape where V8 quotes the surrounding text: `..."essToken":sk-ant-oat"...`.
  fs.writeFileSync(p, '{"claudeAiOauth":{"accessToken":sk-ant-oat01-SECRETSECRETSECRETSECRET,"refreshToken":"x"}}');
  let err = null;
  try { await t.readJsonText(p, { sleep: noSleep }); } catch (e) { err = e; }
  assert.ok(err && err.code === 'parse');
  assert.ok(!/sk-ant|SECRET|essToken/.test(err.message), `message leaks file content: ${err.message}`);
  assert.match(err.message, /^Unparseable JSON in \.credentials\.json: Unexpected token/);
  // Positional messages are kept verbatim; every "… is not valid JSON" shape loses its quoted window.
  assert.equal(t.sanitizeJsonError('Unterminated string in JSON at position 25 (line 1 column 26)'), 'Unterminated string in JSON at position 25 (line 1 column 26)');
  assert.equal(t.sanitizeJsonError('Unexpected token \'s\', "sk-ant-oat01-SECRET" is not valid JSON'), 'Unexpected token \'s\'');
  assert.equal(t.sanitizeJsonError('Unexpected token \'s\', ..."essToken":sk-ant-oat"... is not valid JSON'), 'Unexpected token \'s\'');
  assert.ok(!/sk-ant/.test(t.sanitizeJsonError('Unexpected token \'"\', "..."sk-ant"..." is not valid JSON')));
  assert.equal(t.sanitizeJsonError(undefined), 'invalid JSON');
  // The refresh path surfaces the same sanitised message.
  const r = await t.refreshClaudeTokens({ fetch: fakeFetch([]), credentialsPath: p });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'parse');
  assert.ok(!/sk-ant|SECRET/.test(r.error.message));
});

test('refreshClaudeTokens: a response whose body cannot be read is transient — the refresh token is NOT replayed on the alias host; lock released, file untouched', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir);
  const cut = { ok: true, status: 200, headers: new Map(), text: async () => { throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); } };
  const fetch = fakeFetch([cut, response(200, { access_token: 'must-not-be-used', expires_in: 10 })]);
  const r = await t.refreshClaudeTokens({ fetch, credentialsPath, expectedRefreshToken: 'old-refresh', expectedAccessToken: 'old-access' });
  assert.equal(r.ok, false); assert.equal(r.permanent, false); assert.equal(r.error.code, 'network');
  assert.equal(fetch.calls.length, 1, 'the (possibly consumed) refresh token is not sent to console.anthropic.com');
  assert.equal(JSON.parse(fs.readFileSync(credentialsPath, 'utf8')).claudeAiOauth.accessToken, 'old-access');
  assert.ok(!fs.existsSync(lockDirFor(credentialsPath)), 'lock released');
  assert.deepEqual(fs.readdirSync(dir), ['.credentials.json']);
});

test('refreshClaudeTokens: rename refused (EPERM) → in-place rewrite keeps the rotated refresh token on disk; ENOSPC → never touches the target', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir);
  const eperm = { ...fsp, rename: async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } };
  const logs = [];
  const fetch = fakeFetch([response(200, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 28800 })]);
  const r = await t.refreshClaudeTokens({
    fetch, credentialsPath, now: () => NOW, expectedRefreshToken: 'old-refresh', log: (m) => logs.push(m),
    writeOptions: { fs: eperm, sleep: noSleep },
  });
  assert.equal(r.ok, true); assert.equal(r.persisted, true); assert.equal(r.inPlace, true);
  const text = fs.readFileSync(credentialsPath, 'utf8');
  assert.ok(!text.includes('\n'), 'compact like Claude Code');
  const onDisk = JSON.parse(text);
  assert.equal(onDisk.claudeAiOauth.accessToken, 'new-access');
  assert.equal(onDisk.claudeAiOauth.refreshToken, 'new-refresh', 'the single-use refresh token reached the disk');
  assert.equal(onDisk.claudeAiOauth.expiresAt, NOW + 28800 * 1000);
  assert.deepEqual(onDisk.claudeAiOauth.tokenAccount, { uuid: 'acct', emailAddress: 't@example.com' });
  assert.deepEqual(onDisk.mcpOAuth, { someServer: { accessToken: 'mcp-token' } });
  assert.deepEqual(onDisk.somethingElse, { keep: 'me' });
  assert.deepEqual(fs.readdirSync(dir), ['.credentials.json'], 'staging file removed, lock released');
  assert.ok(logs.some((m) => /in place/.test(m)), 'fallback is logged');
  assert.ok(!logs.some((m) => /new-refresh|new-access|old-refresh|old-access/.test(m)), 'no token in any log line');

  // ENOSPC on the staging write: the in-place path must NOT run (it would truncate the target).
  writeClaudeCreds(dir);
  const enospc = {
    ...fsp,
    open: async (tmp, flag, mode) => {
      const fh = await fsp.open(tmp, flag, mode);
      return { writeFile: async () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); }, sync: () => fh.sync(), close: () => fh.close() };
    },
    writeFile: async () => { throw new Error('in-place write must not be attempted on ENOSPC'); },
  };
  const fetch2 = fakeFetch([response(200, { access_token: 'mem-only', expires_in: 10 })]);
  const r2 = await t.refreshClaudeTokens({ fetch: fetch2, credentialsPath, expectedRefreshToken: 'old-refresh', writeOptions: { fs: enospc, sleep: noSleep } });
  assert.equal(r2.ok, true); assert.equal(r2.persisted, false); assert.equal(r2.inPlace, undefined); assert.equal(r2.error.code, 'write_failed');
  assert.equal(r2.oauth.accessToken, 'mem-only', 'fresh tokens still usable in memory this cycle');
  assert.equal(JSON.parse(fs.readFileSync(credentialsPath, 'utf8')).claudeAiOauth.accessToken, 'old-access', 'target intact');
  assert.deepEqual(fs.readdirSync(dir), ['.credentials.json']);
});

// --- regressions from the credential-safety / network-etiquette review ----------------

test('fetchWithTimeout: the deadline also covers the body — a server that answers and then stalls the body aborts, not hangs', async () => {
  const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
  const stalling = async (url, init) => ({
    ok: true, status: 200, headers: new Map(),
    text: () => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(abortErr()))),
    json: () => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(abortErr()))),
  });
  const res = await t.fetchWithTimeout(stalling, 'https://x', {}, 20);
  await assert.rejects(() => res.text(), (e) => e.name === 'AbortError');
  const res2 = await t.fetchWithTimeout(stalling, 'https://x', {}, 20);
  await assert.rejects(() => res2.json(), (e) => e.name === 'AbortError');
  // A body that arrives in time is returned as-is and the timer no longer fires.
  const quick = async () => ({ ok: true, status: 200, headers: new Map(), text: async () => 'body', json: async () => ({ a: 1 }) });
  const res3 = await t.fetchWithTimeout(quick, 'https://x', {}, 20);
  assert.equal(await res3.text(), 'body');
  const res4 = await t.fetchWithTimeout(quick, 'https://x', {}, 20);
  assert.deepEqual(await res4.json(), { a: 1 });
  // A fetch that rejects before headers still rejects (and clears its timer).
  await assert.rejects(() => t.fetchWithTimeout(async () => { throw new Error('ENOTFOUND'); }, 'https://x', {}, 20), /ENOTFOUND/);
});

test('retryAfterMs / hhmm: delta-seconds, HTTP date, garbage; local HH:MM', () => {
  const now = 1788700000000;
  const withHeader = (v) => ({ headers: new Map([['retry-after', v]]) });
  assert.equal(t.retryAfterMs(withHeader('120'), now), 120000);
  assert.equal(t.retryAfterMs(withHeader('0'), now), 0);
  assert.equal(t.retryAfterMs(withHeader(new Date(now + 90000).toUTCString()), now), 90000);
  assert.equal(t.retryAfterMs(withHeader(new Date(now - 90000).toUTCString()), now), 0, 'a past date is "now"');
  assert.equal(t.retryAfterMs(withHeader('soon'), now), null);
  assert.equal(t.retryAfterMs({ headers: new Map() }, now), null);
  assert.equal(t.retryAfterMs({}, now), null);
  assert.equal(t.retryAfterMs(null, now), null);
  const d = new Date(now);
  assert.equal(t.hhmm(now), `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
});

test('requestMayHaveReachedServer: timeouts and mid-flight drops are ambiguous; DNS / refused / TLS failures are not', () => {
  assert.equal(t.requestMayHaveReachedServer(Object.assign(new Error('aborted'), { name: 'AbortError' })), true);
  assert.equal(t.requestMayHaveReachedServer(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), true);
  assert.equal(t.requestMayHaveReachedServer(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })), true);
  assert.equal(t.requestMayHaveReachedServer(Object.assign(new Error('x'), { code: 'EPIPE' })), true);
  assert.equal(t.requestMayHaveReachedServer(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })), true);
  assert.equal(t.requestMayHaveReachedServer(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) })), false);
  assert.equal(t.requestMayHaveReachedServer(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })), false);
  assert.equal(t.requestMayHaveReachedServer(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('cert'), { code: 'CERT_HAS_EXPIRED' }) })), false);
  assert.equal(t.requestMayHaveReachedServer(new Error('ENOTFOUND')), false);
  assert.equal(t.requestMayHaveReachedServer(null), false);
});

test('refreshClaudeTokens: a timeout / mid-flight drop on platform.claude.com is NOT replayed on console.anthropic.com (the token may be consumed); DNS failure still falls back', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir);
  const before = fs.readFileSync(credentialsPath, 'utf8');
  const ambiguous = [
    Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }),
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }),
  ];
  for (const first of ambiguous) {
    const fetch = fakeFetch([first, response(200, { access_token: 'must-not-be-used', expires_in: 10 })]);
    const r = await t.refreshClaudeTokens({ fetch, credentialsPath, expectedRefreshToken: 'old-refresh', expectedAccessToken: 'old-access' });
    assert.equal(r.ok, false, `${first.name || first.cause.code}`); assert.equal(r.permanent, false); assert.equal(r.error.code, 'network');
    assert.equal(fetch.calls.length, 1, `refresh token not replayed on the alias after ${first.name || first.cause.code}`);
    assert.equal(fetch.calls[0].url, PLATFORM_TOKEN_URL);
    assert.equal(fs.readFileSync(credentialsPath, 'utf8'), before, 'file untouched');
    assert.ok(!fs.existsSync(lockDirFor(credentialsPath)), 'lock released');
  }
  assert.equal((await t.refreshClaudeTokens({ fetch: fakeFetch([ambiguous[0], response(200, { access_token: 'x', expires_in: 10 })]), credentialsPath })).error.message, 'Token refresh timed out');
  // A failure before anything was sent (DNS) still moves on to the alias host.
  const dns = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND platform.claude.com'), { code: 'ENOTFOUND' }) });
  const fetch = fakeFetch([dns, response(200, { access_token: 'via-console', expires_in: 60 })]);
  const r = await t.refreshClaudeTokens({ fetch, credentialsPath });
  assert.equal(r.ok, true);
  assert.deepEqual(fetch.calls.map((c) => c.url), [PLATFORM_TOKEN_URL, CONSOLE_TOKEN_URL]);
});

test('refreshCodexTokens: a response whose body cannot be read is a reported transient failure, never a thrown error; file untouched', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir);
  const cut = { ok: true, status: 200, headers: new Map(), text: async () => { throw Object.assign(new Error('terminated'), { code: 'UND_ERR_SOCKET' }); } };
  const r = await t.refreshCodexTokens({ fetch: fakeFetch([cut]), authPath, expectedRefreshToken: 'old-refresh' });
  assert.equal(r.ok, false); assert.equal(r.permanent, false); assert.equal(r.error.code, 'network');
  assert.match(r.error.message, /could not be read/);
  assert.equal(JSON.parse(fs.readFileSync(authPath, 'utf8')).tokens.refresh_token, 'old-refresh');
  assert.deepEqual(fs.readdirSync(dir), ['auth.json']);
});

test('refreshCodexTokens: rename refused (EPERM/EBUSY) → in-place rewrite keeps the rotated refresh token on disk (pretty format kept); ENOSPC → never touches the target', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir);
  const logs = [];
  const eperm = { ...fsp, rename: async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } };
  const fetch = fakeFetch([response(200, { access_token: 'new-access', refresh_token: 'new-refresh' })]);
  const r = await t.refreshCodexTokens({ fetch, authPath, now: () => NOW, expectedRefreshToken: 'old-refresh', log: (m) => logs.push(m), writeOptions: { fs: eperm, sleep: noSleep } });
  assert.equal(r.ok, true); assert.equal(r.persisted, true); assert.equal(r.inPlace, true);
  const text = fs.readFileSync(authPath, 'utf8');
  assert.ok(text.includes('\n  "tokens"'), 'pretty formatting preserved by the in-place path');
  const onDisk = JSON.parse(text);
  assert.equal(onDisk.tokens.refresh_token, 'new-refresh', 'the single-use refresh token reached the disk');
  assert.equal(onDisk.tokens.access_token, 'new-access');
  assert.equal(onDisk.tokens.account_id, 'acct-1');
  assert.deepEqual(onDisk.extra_key_kept, { yes: true });
  assert.equal(onDisk.last_refresh, new Date(NOW).toISOString());
  assert.deepEqual(fs.readdirSync(dir), ['auth.json'], 'staging file removed');
  assert.ok(logs.some((m) => /in place/.test(m)));
  assert.ok(!logs.some((m) => /new-refresh|new-access|old-refresh|old-access/.test(m)), 'no token in any log line');

  // ENOSPC on the staging write: the in-place path must NOT run (it would truncate the target).
  writeCodexAuth(dir);
  const enospc = {
    ...fsp,
    writeFile: async (p, body, opts) => {
      if (String(p).includes('.tmp')) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      throw new Error('in-place write must not be attempted on ENOSPC');
    },
  };
  const r2 = await t.refreshCodexTokens({ fetch: fakeFetch([response(200, { access_token: 'mem-only' })]), authPath, expectedRefreshToken: 'old-refresh', writeOptions: { fs: enospc, sleep: noSleep } });
  assert.equal(r2.ok, true); assert.equal(r2.persisted, false); assert.equal(r2.inPlace, undefined); assert.equal(r2.error.code, 'write_failed');
  assert.equal(r2.tokens.access_token, 'mem-only');
  assert.equal(JSON.parse(fs.readFileSync(authPath, 'utf8')).tokens.access_token, 'old-access', 'target intact');
  assert.deepEqual(fs.readdirSync(dir), ['auth.json']);
});

test('refreshCodexTokens: auth.json removed / signed out (apikey mode) during the request → permanent signed_out, nothing written', async () => {
  const dir = tmpDir();
  const authPath = writeCodexAuth(dir);
  const fetch = fakeFetch(() => { fs.unlinkSync(authPath); return response(200, { access_token: 'ours', refresh_token: 'ours-refresh' }); });
  const r = await t.refreshCodexTokens({ fetch, authPath, expectedRefreshToken: 'old-refresh' });
  assert.equal(r.ok, false); assert.equal(r.permanent, true); assert.equal(r.error.code, 'signed_out');
  assert.deepEqual(fs.readdirSync(dir), [], 'auth.json is not resurrected, no temp file');

  const apikey = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test', tokens: null, last_refresh: null }, null, 2) + '\n';
  writeCodexAuth(dir);
  const fetch2 = fakeFetch(() => { fs.writeFileSync(authPath, apikey); return response(200, { access_token: 'ours', refresh_token: 'ours-refresh' }); });
  const r2 = await t.refreshCodexTokens({ fetch: fetch2, authPath, expectedRefreshToken: 'old-refresh' });
  assert.equal(r2.ok, false); assert.equal(r2.error.code, 'signed_out');
  assert.equal(fs.readFileSync(authPath, 'utf8'), apikey, 'the API-key file is left exactly as written');
});

test('refreshClaudeTokens: credentials removed / claudeAiOauth block removed during the request → permanent signed_out, nothing written, lock released', async () => {
  const dir = tmpDir();
  const credentialsPath = writeClaudeCreds(dir);
  const fetch = fakeFetch(() => { fs.unlinkSync(credentialsPath); return response(200, { access_token: 'ours', refresh_token: 'ours-refresh', expires_in: 10 }); });
  const r = await t.refreshClaudeTokens({ fetch, credentialsPath, expectedRefreshToken: 'old-refresh' });
  assert.equal(r.ok, false); assert.equal(r.permanent, true); assert.equal(r.error.code, 'signed_out');
  assert.deepEqual(fs.readdirSync(dir), [], 'file not resurrected, no temp file, lock released');

  writeClaudeCreds(dir);
  const loggedOut = '{"mcpOAuth":{"someServer":{"accessToken":"mcp-token"}}}';
  const fetch2 = fakeFetch(() => { fs.writeFileSync(credentialsPath, loggedOut); return response(200, { access_token: 'ours', refresh_token: 'ours-refresh', expires_in: 10 }); });
  const r2 = await t.refreshClaudeTokens({ fetch: fetch2, credentialsPath, expectedRefreshToken: 'old-refresh' });
  assert.equal(r2.ok, false); assert.equal(r2.error.code, 'signed_out');
  assert.equal(fs.readFileSync(credentialsPath, 'utf8'), loggedOut, 'the logged-out file is left as Claude Code wrote it');
  assert.deepEqual(fs.readdirSync(dir), ['.credentials.json']);
});

// --- createBackoff ----------------------------------------------------------------

test('createBackoff: exponential 1→2→4 min capped at 30, permanent parks 30 min, reset clears', () => {
  const b = t.createBackoff();
  const MIN = 60000;
  let now = 1000000;
  assert.equal(b.shouldSkip(now), false);
  b.recordFailure(now); assert.equal(b.remainingMs(now), 1 * MIN);
  b.recordFailure(now); assert.equal(b.remainingMs(now), 2 * MIN);
  b.recordFailure(now); assert.equal(b.remainingMs(now), 4 * MIN);
  for (let i = 0; i < 10; i++) b.recordFailure(now);
  assert.equal(b.remainingMs(now), 30 * MIN, 'capped');
  assert.equal(b.shouldSkip(now + 29 * MIN), true);
  assert.equal(b.shouldSkip(now + 30 * MIN), false);
  b.reset();
  assert.equal(b.shouldSkip(now), false);
  b.recordFailure(now, { permanent: true, error: { code: 'invalid_grant' } });
  assert.equal(b.state().permanent, true);
  assert.equal(b.remainingMs(now), 30 * MIN);
  assert.equal(b.state().lastError.code, 'invalid_grant');
  b.reset();
  assert.deepEqual(b.state(), { failures: 0, nextAllowedAt: 0, permanent: false, lastError: null });
});

test('createBackoff: fixed `steps` schedule (Claude: retry once after 60 s, then 30 min) and a 24 h permanent park', () => {
  const b = t.createBackoff({ steps: [60000, 30 * 60000], permanentMs: 24 * 3600 * 1000 });
  const now = 5000000;
  b.recordFailure(now); assert.equal(b.remainingMs(now), 60000);
  b.recordFailure(now); assert.equal(b.remainingMs(now), 30 * 60000);
  b.recordFailure(now); assert.equal(b.remainingMs(now), 30 * 60000, 'last step repeats');
  b.reset();
  b.recordFailure(now, { permanent: true });
  assert.equal(b.remainingMs(now), 24 * 3600 * 1000);
  assert.equal(b.shouldSkip(now + 24 * 3600 * 1000 - 1), true);
  assert.equal(b.shouldSkip(now + 24 * 3600 * 1000), false);
});

test('classifyRefreshFailure: HTML WAF page on 400 is NOT permanent', () => {
  assert.equal(t.classifyRefreshFailure(400, '<html>blocked</html>').permanent, false);
  assert.equal(t.classifyRefreshFailure(400, '{"error":"invalid_grant"}').permanent, true);
  assert.equal(t.classifyRefreshFailure(401, '').permanent, true);
  assert.equal(t.classifyRefreshFailure(502, '').permanent, false);
});

// --- refresh policy helpers (the shared "never before expiry" rule) -------------------

test('isLapsed: 2 min before expiry and inside the 60 s grace → false; 60 s / 61 s after → true; unknown expiry → false', () => {
  const now = 1788700000000;
  assert.equal(t.isLapsed(now + 2 * 60000, now), false, 'close to expiry is NOT lapsed — the owning CLI refreshes ahead of us');
  assert.equal(t.isLapsed(now, now), false, 'exactly at expiry: inside the grace');
  assert.equal(t.isLapsed(now - 59000, now), false, '59 s past: inside the grace');
  assert.equal(t.isLapsed(now - 60000, now), true, 'grace boundary');
  assert.equal(t.isLapsed(now - 61000, now), true);
  assert.equal(t.isLapsed(now - 61000, now, 120000), false, 'custom grace');
  assert.equal(t.isLapsed(now - 121000, now, 120000), true);
  for (const bad of [null, undefined, NaN, 'soon', 0, -1]) assert.equal(t.isLapsed(bad, now), false, `unknown expiry ${bad} → use the token as-is`);
  // JWT exp is in seconds; jwtExpiryMs converts and the same rule applies.
  assert.equal(t.isLapsed(t.jwtExpiryMs(makeJwt({ exp: Math.floor(now / 1000) - 61 })), now), true);
  assert.equal(t.isLapsed(t.jwtExpiryMs(makeJwt({ exp: Math.floor(now / 1000) + 120 })), now), false);
  assert.equal(t.isLapsed(t.jwtExpiryMs(makeJwt({ sub: 'no exp' })), now), false);
});

test('refreshGate: a file written < 30 s ago (or with a future mtime) and an attempt < 10 min ago defer; unknown age / no attempt do not', () => {
  const now = 1788700000000;
  assert.deepEqual(t.refreshGate({ nowMs: now }), { ok: true });
  assert.deepEqual(t.refreshGate({ nowMs: now, mtimeMs: null, lastAttemptAt: 0 }), { ok: true });
  // (b) fresh file
  assert.deepEqual(t.refreshGate({ nowMs: now, mtimeMs: now - 10000 }), { ok: false, reason: 'fresh_file', retryAt: now + 20000 });
  assert.deepEqual(t.refreshGate({ nowMs: now, mtimeMs: now - 29999 }), { ok: false, reason: 'fresh_file', retryAt: now + 1 });
  assert.deepEqual(t.refreshGate({ nowMs: now, mtimeMs: now - 30000 }), { ok: true }, 'exactly 30 s old is old enough');
  assert.deepEqual(t.refreshGate({ nowMs: now, mtimeMs: now + 5000 }), { ok: false, reason: 'fresh_file', retryAt: now + 35000 }, 'future mtime (clock skew) counts as just written');
  assert.deepEqual(t.refreshGate({ nowMs: now, mtimeMs: NaN }), { ok: true }, 'unparseable age does not block');
  // (c) spacing
  assert.deepEqual(t.refreshGate({ nowMs: now, lastAttemptAt: now - 5 * 60000 }), { ok: false, reason: 'spacing', retryAt: now + 5 * 60000 });
  assert.deepEqual(t.refreshGate({ nowMs: now, lastAttemptAt: now - 10 * 60000 }), { ok: true }, 'exactly 10 min → allowed');
  assert.deepEqual(t.refreshGate({ nowMs: now, lastAttemptAt: now - 10 * 60000 + 1 }), { ok: false, reason: 'spacing', retryAt: now + 1 });
  // spacing is reported first (it is the longer wait); custom windows
  assert.equal(t.refreshGate({ nowMs: now, lastAttemptAt: now - 1000, mtimeMs: now - 1000 }).reason, 'spacing');
  assert.deepEqual(t.refreshGate({ nowMs: now, lastAttemptAt: now - 1000, spacingMs: 500 }), { ok: true });
  assert.deepEqual(t.refreshGate({ nowMs: now, mtimeMs: now - 1000, freshFileMs: 500 }), { ok: true });
});

test('fileMtimeMs: real file → its mtime in ms; missing file / stat error → null, never throws', async () => {
  const dir = tmpDir();
  const p = path.join(dir, 'auth.json');
  fs.writeFileSync(p, '{}');
  const pinned = new Date(1788700000000 - 120000);
  fs.utimesSync(p, pinned, pinned);
  const got = await t.fileMtimeMs(p);
  assert.ok(typeof got === 'number' && Math.abs(got - pinned.getTime()) < 1, `mtime ${got} ≈ ${pinned.getTime()}`);
  assert.equal(await t.fileMtimeMs(path.join(dir, 'missing.json')), null);
  assert.equal(await t.fileMtimeMs(p, { fs: { stat: async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } } }), null);
});
