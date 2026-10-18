'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');

const keychain = require('../src/main/providers/keychain.js');

// --- helpers ----------------------------------------------------------------

const HOME = path.resolve('/home/tester'); // C:\home\tester on Windows — every expectation is built from it
const NO_ENV = {};
const BASE = 'Claude Code-credentials';
const suffixed = (dir) => `${BASE}-${crypto.createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8)}`;
const sha16 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

const ITEM = { claudeAiOauth: { accessToken: 'sk-ant-oat01-KEYCHAIN-FAKE', refreshToken: 'sk-ant-ort01-KEYCHAIN-FAKE', expiresAt: 4102444800000, scopes: ['user:inference', 'user:profile'] } };

/**
 * Fake child_process.execFile: `items[service]` is the JSON text the item holds (string), an { exit } / { killed } /
 * { spawn } failure, or absent (= exit 44, errSecItemNotFound). Records every call.
 */
function fakeExecFile(items = {}) {
  const calls = [];
  const fn = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    const service = args[args.indexOf('-s') + 1];
    const item = Object.prototype.hasOwnProperty.call(items, service) ? items[service] : { exit: 44 };
    setImmediate(() => {
      if (typeof item === 'string') return cb(null, `${item}\n`, '');
      if (item.never) return undefined; // never calls back
      if (item.killed) return cb(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null }), '', '');
      if (item.spawn) return cb(Object.assign(new Error(`spawn ${file} ${item.spawn}`), { code: item.spawn }), '', '');
      return cb(Object.assign(new Error('Command failed'), { code: item.exit }), '', 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.');
    });
  };
  fn.calls = calls;
  fn.services = () => calls.map((c) => c.args[c.args.indexOf('-s') + 1]);
  return fn;
}

// ---------------------------------------------------------------------------
// resolveConfigDir
// ---------------------------------------------------------------------------

test('keychain: resolveConfigDir — default folder, CLAUDE_CONFIG_DIR, ~ expansion, path.resolve, trailing separators', () => {
  const r = (dir, env = NO_ENV) => keychain.resolveConfigDir(dir, { env, home: HOME });
  assert.equal(r(''), path.join(HOME, '.claude'), "'' without CLAUDE_CONFIG_DIR → <home>/.claude");
  assert.equal(r('   '), path.join(HOME, '.claude'), 'blank counts as empty');
  assert.equal(r(null), path.join(HOME, '.claude'), 'a non-string counts as empty');
  assert.equal(r('', { CLAUDE_CONFIG_DIR: `  ${path.join(HOME, 'cfg')}  ` }), path.join(HOME, 'cfg'), "'' → the trimmed env folder");
  assert.equal(r('', { CLAUDE_CONFIG_DIR: '   ' }), path.join(HOME, '.claude'), 'a blank env is unset');
  assert.equal(r(path.join(HOME, 'typed'), { CLAUDE_CONFIG_DIR: path.join(HOME, 'cfg') }), path.join(HOME, 'typed'), 'a typed folder beats the env');

  assert.equal(r('~'), HOME);
  assert.equal(r('~/.claude-2'), path.join(HOME, '.claude-2'));
  assert.equal(r('~\\.claude-2'), path.join(HOME, '.claude-2'), "the Windows form '~\\' is expanded too");
  assert.equal(r('  ~/.claude-2  '), path.join(HOME, '.claude-2'), 'trimmed before expansion');
  assert.equal(r('', { CLAUDE_CONFIG_DIR: '~/.claude-env' }), path.join(HOME, '.claude-env'));

  assert.equal(r(`${path.join(HOME, '.claude-2')}${path.sep}`), path.join(HOME, '.claude-2'), 'trailing separator stripped');
  assert.equal(r(`${path.join(HOME, '.claude-2')}${path.sep}${path.sep}`), path.join(HOME, '.claude-2'));
  assert.equal(r('~/.claude-2/'), path.join(HOME, '.claude-2'));
  assert.equal(r(`${HOME}${path.sep}a${path.sep}..${path.sep}.claude-2`), path.join(HOME, '.claude-2'), 'normalised by path.resolve');
  assert.equal(r('relative-folder'), path.resolve('relative-folder'), 'a relative folder is made absolute');
  const root = path.parse(HOME).root;
  assert.equal(r(root), root, 'the filesystem root keeps its separator');
});

// ---------------------------------------------------------------------------
// Service naming
// ---------------------------------------------------------------------------

test('keychain: service naming matches Claude Code — "Claude Code-credentials" + "-" + sha256(NFC(folder)) first 8 hex', () => {
  // Cross-checked against Claude Code 2.1.302 on the owner's Mac: the folder /Users/aidan/.claude-1 (started with
  // CLAUDE_CONFIG_DIR="$HOME/.claude-1") is the Keychain item "Claude Code-credentials-61b6c2d5".
  assert.equal(keychain.serviceName('/Users/aidan/.claude-1'), 'Claude Code-credentials-61b6c2d5');
  assert.equal(keychain.serviceName('/x'), suffixed('/x'));
  assert.equal(keychain.SERVICE_BASE, BASE);
});

test('keychain: serviceCandidates — the literal item for /Users/aidan/.claude-1, typed or via CLAUDE_CONFIG_DIR', { skip: process.platform === 'win32' && 'POSIX home folder' }, () => {
  const opts = { env: NO_ENV, home: '/Users/aidan' };
  assert.deepEqual(keychain.serviceCandidates('~/.claude-1', opts), ['Claude Code-credentials-61b6c2d5']);
  assert.deepEqual(keychain.serviceCandidates('/Users/aidan/.claude-1/', opts), ['Claude Code-credentials-61b6c2d5']);
  assert.deepEqual(keychain.serviceCandidates('', { env: { CLAUDE_CONFIG_DIR: '/Users/aidan/.claude-1' }, home: '/Users/aidan' }),
    ['Claude Code-credentials-61b6c2d5', 'Claude Code-credentials']);
});

test('keychain: serviceCandidates — default, env set, explicit ~/.claude (both, unsuffixed first), any other folder, trailing slash', () => {
  const c = (dir, env = NO_ENV) => keychain.serviceCandidates(dir, { env, home: HOME });
  const DEFAULT_DIR = path.join(HOME, '.claude');

  assert.deepEqual(c(''), [BASE], "'' without CLAUDE_CONFIG_DIR → the unsuffixed item only");
  const envDir = path.join(HOME, 'cfg');
  assert.deepEqual(c('', { CLAUDE_CONFIG_DIR: envDir }), [suffixed(envDir), BASE], "'' with CLAUDE_CONFIG_DIR → its item first, then the default");
  assert.deepEqual(c('', { CLAUDE_CONFIG_DIR: `${envDir}${path.sep}` }), [suffixed(envDir), BASE], 'env folder resolved before hashing');

  // A Claude Code started WITH CLAUDE_CONFIG_DIR pointing at ~/.claude uses the suffixed name; without, the plain one.
  assert.deepEqual(c('~/.claude'), [BASE, suffixed(DEFAULT_DIR)]);
  assert.deepEqual(c(DEFAULT_DIR), [BASE, suffixed(DEFAULT_DIR)]);
  assert.deepEqual(c(`${DEFAULT_DIR}${path.sep}`), [BASE, suffixed(DEFAULT_DIR)], 'trailing separator stripped before comparing / hashing');
  assert.notEqual(suffixed(DEFAULT_DIR), BASE);

  const other = path.join(HOME, '.claude-2');
  assert.deepEqual(c('~/.claude-2'), [suffixed(other)], 'any other folder → its suffixed item only');
  assert.deepEqual(c(other), [suffixed(other)]);
  assert.deepEqual(c(`${other}${path.sep}`), [suffixed(other)]);
  assert.deepEqual(c('~/.claude-2', { CLAUDE_CONFIG_DIR: envDir }), [suffixed(other)], 'a typed folder ignores the env');
  assert.notEqual(c('~/.claude-2')[0], c('~/.claude-3')[0], 'different folders, different items');
});

test('keychain: serviceCandidates hashes the NFC form — an NFD-typed folder finds the same item', () => {
  const nfc = path.join(HOME, 'Caf\u00e9-claude');
  const nfd = path.join(HOME, 'Cafe\u0301-claude');
  assert.notEqual(nfc, nfd, 'the fixture really differs byte-wise');
  const expected = `${BASE}-${crypto.createHash('sha256').update(nfc).digest('hex').slice(0, 8)}`;
  assert.deepEqual(keychain.serviceCandidates(nfd, { env: NO_ENV, home: HOME }), [expected]);
  assert.deepEqual(keychain.serviceCandidates(nfc, { env: NO_ENV, home: HOME }), [expected]);
  assert.equal(keychain.serviceName(nfd), expected);
  assert.notEqual(expected, `${BASE}-${crypto.createHash('sha256').update(nfd).digest('hex').slice(0, 8)}`, 'hashing the raw NFD bytes would miss the item');
});

// ---------------------------------------------------------------------------
// readCredentials
// ---------------------------------------------------------------------------

test('keychain: readCredentials runs /usr/bin/security find-generic-password -s <service> -w without a shell → { creds, service, stamp }', async () => {
  const execFile = fakeExecFile({ [BASE]: JSON.stringify(ITEM) });
  const r = await keychain.readCredentials('', { execFile, env: NO_ENV, home: HOME });
  assert.deepEqual(r.creds, ITEM);
  assert.equal(r.service, BASE);
  assert.equal(r.stamp, sha16(ITEM.claudeAiOauth.accessToken), 'stamp = short sha256 of the access token');
  assert.ok(!r.stamp.includes('KEYCHAIN-FAKE'));

  assert.equal(execFile.calls.length, 1, 'the first candidate was found: nothing else is tried');
  const call = execFile.calls[0];
  assert.equal(call.file, '/usr/bin/security');
  assert.deepEqual(call.args, ['find-generic-password', '-s', BASE, '-w']);
  assert.equal(call.opts.shell, undefined, 'no shell');
  assert.equal(call.opts.timeout, 8000, 'default 8 s timeout');
  assert.equal(keychain.READ_TIMEOUT_MS, 8000);

  // A different token gives a different stamp (the provider's change detection).
  const other = { claudeAiOauth: { ...ITEM.claudeAiOauth, accessToken: 'sk-ant-oat01-OTHER-FAKE' } };
  const r2 = await keychain.readCredentials('', { execFile: fakeExecFile({ [BASE]: JSON.stringify(other) }), env: NO_ENV, home: HOME });
  assert.notEqual(r2.stamp, r.stamp);
  const t = await keychain.readCredentials('', { execFile: fakeExecFile({ [BASE]: JSON.stringify(ITEM) }), env: NO_ENV, home: HOME, timeoutMs: 1234 });
  assert.equal(t.service, BASE);
});

test('keychain: exit 44 (not found) falls through to the next candidate; all missing → not_found', async () => {
  const DEFAULT_DIR = path.join(HOME, '.claude');
  // ~/.claude typed: the unsuffixed item is missing, the suffixed one (a CLAUDE_CONFIG_DIR launch) holds the login.
  let execFile = fakeExecFile({ [suffixed(DEFAULT_DIR)]: JSON.stringify(ITEM) });
  const r = await keychain.readCredentials('~/.claude', { execFile, env: NO_ENV, home: HOME });
  assert.equal(r.service, suffixed(DEFAULT_DIR));
  assert.deepEqual(execFile.services(), [BASE, suffixed(DEFAULT_DIR)], 'tried in order');

  // '' with CLAUDE_CONFIG_DIR set: its item is missing → the default item is used.
  const envDir = path.join(HOME, 'cfg');
  execFile = fakeExecFile({ [BASE]: JSON.stringify(ITEM) });
  const r2 = await keychain.readCredentials('', { execFile, env: { CLAUDE_CONFIG_DIR: envDir }, home: HOME });
  assert.equal(r2.service, BASE);
  assert.deepEqual(execFile.services(), [suffixed(envDir), BASE]);

  execFile = fakeExecFile({});
  await assert.rejects(keychain.readCredentials('~/.claude', { execFile, env: NO_ENV, home: HOME }), (e) => e.code === 'not_found');
  assert.equal(execFile.calls.length, 2, 'every candidate tried before giving up');
  await assert.rejects(keychain.readCredentials('~/.claude-2', { execFile: fakeExecFile({}), env: NO_ENV, home: HOME }), { code: 'not_found' });
});

test('keychain: unparseable item → parse (output never quoted, no further candidates); hex output is decoded', async () => {
  const DEFAULT_DIR = path.join(HOME, '.claude');
  const garbage = '{"claudeAiOauth":{"accessToken":sk-ant-oat01-SECRET';
  const execFile = fakeExecFile({ [BASE]: garbage, [suffixed(DEFAULT_DIR)]: JSON.stringify(ITEM) });
  await assert.rejects(keychain.readCredentials('~/.claude', { execFile, env: NO_ENV, home: HOME }), (e) => {
    assert.equal(e.code, 'parse');
    assert.ok(!/SECRET|sk-ant/.test(e.message), 'the item text is never quoted');
    return true;
  });
  assert.equal(execFile.calls.length, 1, 'a broken item is reported, not skipped');
  await assert.rejects(keychain.readCredentials('', { execFile: fakeExecFile({ [BASE]: '[1,2]' }), env: NO_ENV, home: HOME }), { code: 'parse' }, 'a non-object is not credentials');

  // `security -w` prints non-printable data as hex — Claude Code writes the item with `-X <hex>`.
  const withAccent = { claudeAiOauth: { ...ITEM.claudeAiOauth }, mcpOAuth: { 'caf\u00e9': {} } };
  const hex = Buffer.from(JSON.stringify(withAccent), 'utf8').toString('hex');
  const r = await keychain.readCredentials('', { execFile: fakeExecFile({ [BASE]: hex }), env: NO_ENV, home: HOME });
  assert.deepEqual(r.creds, withAccent);
  await assert.rejects(keychain.readCredentials('', { execFile: fakeExecFile({ [BASE]: 'abc' }), env: NO_ENV, home: HOME }), { code: 'parse' }, 'odd-length hex is not decoded');
});

test('keychain: timeout / other failures → keychain_error, never not_found, no further candidates', async () => {
  const DEFAULT_DIR = path.join(HOME, '.claude');
  const fallback = { [suffixed(DEFAULT_DIR)]: JSON.stringify(ITEM) };

  // execFile's own timeout killed the child.
  let execFile = fakeExecFile({ [BASE]: { killed: true }, ...fallback });
  await assert.rejects(keychain.readCredentials('~/.claude', { execFile, env: NO_ENV, home: HOME }), (e) => e.code === 'keychain_error' && e.timedOut === true);
  assert.equal(execFile.calls.length, 1);

  // An execFile that never calls back is cut off by the guard timer.
  execFile = fakeExecFile({ [BASE]: { never: true } });
  const started = Date.now();
  await assert.rejects(keychain.readCredentials('', { execFile, env: NO_ENV, home: HOME, timeoutMs: 10 }), (e) => e.code === 'keychain_error' && e.timedOut === true);
  assert.ok(Date.now() - started < 2000, 'guard fires shortly after the timeout');

  // A locked keychain / no user interaction (exit 36 / 51) is an error, not "no login".
  execFile = fakeExecFile({ [BASE]: { exit: 51 }, ...fallback });
  await assert.rejects(keychain.readCredentials('~/.claude', { execFile, env: NO_ENV, home: HOME }), (e) => {
    assert.equal(e.code, 'keychain_error');
    assert.equal(e.timedOut, undefined);
    assert.equal(e.message, 'security exited with 51');
    assert.ok(!/could not be found/.test(e.message), 'stderr is never quoted');
    return true;
  });
  assert.equal(execFile.calls.length, 1);

  await assert.rejects(keychain.readCredentials('', { execFile: fakeExecFile({ [BASE]: { spawn: 'ENOENT' } }), env: NO_ENV, home: HOME }),
    (e) => e.code === 'keychain_error' && e.message === 'security could not run (ENOENT)');
  const throwing = () => { throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }); };
  await assert.rejects(keychain.readCredentials('', { execFile: throwing, env: NO_ENV, home: HOME }), (e) => e.code === 'keychain_error' && /EAGAIN/.test(e.message));
});
