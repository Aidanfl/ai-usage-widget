'use strict';

/**
 * keychain.js — READ-ONLY access to the Claude Code login that macOS keeps in the login Keychain
 * (the `claude_keychain` source of claude.js). On macOS Claude Code does not write `.credentials.json`;
 * each config folder's OAuth tokens live in one generic-password item instead.
 *
 *   resolveConfigDir(configDir, { env, home }) → absolute folder
 *       '' → trimmed env.CLAUDE_CONFIG_DIR, else <home>/.claude; '~', '~/' and '~\' expanded; path.resolve;
 *       trailing separators stripped. claude.js uses it for the `.credentials.json` path as well.
 *   serviceName(dir) → 'Claude Code-credentials-<sha256(NFC(dir)) first 8 hex>'
 *   serviceCandidates(configDir, { env, home }) → service names to try, in order
 *   readCredentials(configDir, { execFile, env, home, timeoutMs }) → Promise<{ creds, service, stamp }>
 *       reads every candidate, the latest-expiring token wins; rejects with err.code 'not_found' | 'parse' |
 *       'keychain_error' (err.timedOut on a timeout)
 *
 * Item naming (verified in the Claude Code 2.1.302 binary): service `Claude Code-credentials`, plus
 * `-<sha256(CLAUDE_CONFIG_DIR.normalize('NFC')).hex.slice(0, 8)>` whenever Claude Code was started WITH
 * CLAUDE_CONFIG_DIR — even when that names ~/.claude itself — account = $USER. Claude Code hashes the variable
 * EXACTLY as set (no resolve, no trailing-slash strip), so a folder is tried as typed (~ expanded, as a shell would),
 * then tidied, then tidied with a trailing separator. A folder that resolves to ~/.claude can hold either name; the
 * unsuffixed one is tried first.
 *
 * Nothing here writes to the Keychain, and nothing here logs or quotes `security`'s output: it is the token.
 * Reading through /usr/bin/security does not raise a Keychain prompt (the item's ACL trusts that binary).
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile: nodeExecFile } = require('node:child_process');

const SECURITY_PATH = '/usr/bin/security';
const SERVICE_BASE = 'Claude Code-credentials';
const NOT_FOUND_EXIT = 44;          // security(1): errSecItemNotFound
const READ_TIMEOUT_MS = 8000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Folder + service naming (pure)
// ---------------------------------------------------------------------------

/** path.resolve already drops them on every OS we ship; kept so the hashed form never depends on that. */
function stripTrailingSeparators(p) {
  const root = path.parse(p).root;
  let out = p;
  while (out.length > root.length && out.endsWith(path.sep)) out = out.slice(0, -1);
  return out;
}

/** Absolute Claude Code config folder for a setting as typed ('' = Claude Code's own default). */
function resolveConfigDir(configDir, { env = process.env, home = os.homedir() } = {}) {
  let dir = typeof configDir === 'string' ? configDir.trim() : '';
  if (!dir) {
    const fromEnv = env && typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
    dir = fromEnv || path.join(home, '.claude');
  }
  if (dir === '~') dir = home;
  else if (dir.startsWith('~/') || dir.startsWith('~\\')) dir = path.join(home, dir.slice(2));
  return stripTrailingSeparators(path.resolve(dir));
}

function shortHash(text, length) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, length);
}

/** '~', '~/…' and '~\…' expanded the way a shell would before setting CLAUDE_CONFIG_DIR; nothing else changed. */
function expandTilde(dir, home) {
  if (dir === '~') return home;
  if (dir.startsWith('~/') || dir.startsWith('~\\')) return String(home).replace(/[\\/]+$/, '') + dir.slice(1);
  return dir;
}

/** The suffixed item name Claude Code uses for a folder it was started in with CLAUDE_CONFIG_DIR. */
function serviceName(dir) {
  return `${SERVICE_BASE}-${shortHash(String(dir).normalize('NFC'), 8)}`;
}

/**
 * Item names to try for a folder setting, most likely first:
 *   ''                      → the unsuffixed default item; with CLAUDE_CONFIG_DIR set in the widget's environment,
 *                             that variable's item(s) INSTEAD (a Claude Code started from the same environment uses it,
 *                             and the unsuffixed item would be a different login shown under this account's name)
 *   a folder = <home>/.claude → unsuffixed, then the suffixed forms (the folder can be reached either way)
 *   any other folder        → the suffixed forms only: as typed, tidied, tidied + trailing separator
 */
function serviceCandidates(configDir, { env = process.env, home = os.homedir() } = {}) {
  const typed = typeof configDir === 'string' ? configDir.trim() : '';
  const out = [];
  const add = (svc) => { if (!out.includes(svc)) out.push(svc); };
  if (!typed) {
    // Claude Code treats an empty variable as unset; any other value is hashed exactly as set.
    const fromEnv = env && typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR : '';
    if (fromEnv) {
      add(serviceName(fromEnv));
      if (fromEnv.trim()) add(serviceName(resolveConfigDir(fromEnv, { env, home })));
      return out;
    }
    add(SERVICE_BASE);
    return out;
  }
  const dir = resolveConfigDir(typed, { env, home });
  if (dir === resolveConfigDir(path.join(home, '.claude'), { env, home })) add(SERVICE_BASE);
  add(serviceName(expandTilde(typed, home)));
  add(serviceName(dir));
  add(serviceName(dir + path.sep));
  return out;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function keychainError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

/**
 * `security -w` prints the item's data as text, or as hex when the bytes are not printable (Claude Code writes the
 * item with `-X <hex>`; non-ASCII JSON can come back that way). Returns the parsed object or null — never throws, and
 * the error path never sees the text.
 */
function parseItem(stdout) {
  const text = String(stdout == null ? '' : stdout).trim();
  const attempt = (t) => { try { const v = JSON.parse(t); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };
  const direct = attempt(text);
  if (direct) return direct;
  if (text.length && text.length % 2 === 0 && /^[0-9a-f]+$/i.test(text)) return attempt(Buffer.from(text, 'hex').toString('utf8'));
  return null;
}

/** One `security find-generic-password -s <service> -w` run → { found: false } | { found: true, stdout }. Rejects on errors. */
function findPassword(execFile, service, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => { if (!done) { done = true; clearTimeout(guard); fn(value); } };
    // execFile's own `timeout` kills the child; the extra timer guards an implementation that never calls back.
    const guard = setTimeout(() => finish(reject, keychainError('keychain_error', 'Reading the Keychain timed out', { timedOut: true })), timeoutMs + 500);
    if (typeof guard.unref === 'function') guard.unref();
    try {
      execFile(SECURITY_PATH, ['find-generic-password', '-s', service, '-w'],
        { timeout: timeoutMs, encoding: 'utf8', windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES },
        (err, stdout) => {
          if (!err) return finish(resolve, { found: true, stdout });
          if (err.code === NOT_FOUND_EXIT) return finish(resolve, { found: false });
          if (err.killed || err.signal) return finish(reject, keychainError('keychain_error', 'Reading the Keychain timed out', { timedOut: true }));
          // Exit status or spawn error code only — never stderr/stdout.
          const detail = typeof err.code === 'number' ? `security exited with ${err.code}` : `security could not run (${err.code || 'error'})`;
          return finish(reject, keychainError('keychain_error', detail));
        });
    } catch (e) {
      finish(reject, keychainError('keychain_error', `security could not be started (${(e && e.code) || 'error'})`));
    }
  });
}

/**
 * Claude Code's stored credentials for a folder setting. Every serviceCandidates() item is read (a missing one,
 * exit 44, is skipped) and the one whose token expires LAST wins: an item left behind by an older launch (with or
 * without a trailing slash, with or without CLAUDE_CONFIG_DIR) must not shadow the login Claude Code keeps fresh.
 * Ties keep the candidate order. `stamp` is a short hash of the access token, for change detection without keeping
 * the token around. A Keychain error (timeout, `security` failing) rejects at once.
 */
async function readCredentials(configDir, { execFile = nodeExecFile, env = process.env, home = os.homedir(), timeoutMs = READ_TIMEOUT_MS } = {}) {
  let best = null;
  let unparseable = false;
  for (const service of serviceCandidates(configDir, { env, home })) {
    const r = await findPassword(execFile, service, timeoutMs);
    if (!r.found) continue;
    const creds = parseItem(r.stdout);
    if (!creds) { unparseable = true; continue; }
    const oauth = creds.claudeAiOauth && typeof creds.claudeAiOauth === 'object' ? creds.claudeAiOauth : null;
    const expiresAt = Number(oauth && oauth.expiresAt);
    const rank = Number.isFinite(expiresAt) ? expiresAt : -Infinity;
    if (!best || rank > best.rank) best = { creds, service, oauth, rank };
  }
  if (best) return { creds: best.creds, service: best.service, stamp: shortHash(best.oauth && best.oauth.accessToken ? best.oauth.accessToken : '', 16) };
  if (unparseable) throw keychainError('parse', 'The Claude Code Keychain item is not valid JSON');
  throw keychainError('not_found', 'No Claude Code credentials in the Keychain');
}

module.exports = {
  resolveConfigDir,
  serviceName,
  serviceCandidates,
  readCredentials,
  SECURITY_PATH,
  SERVICE_BASE,
  NOT_FOUND_EXIT,
  READ_TIMEOUT_MS,
};
