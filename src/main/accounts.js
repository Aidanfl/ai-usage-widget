'use strict';
// Claude accounts (several at once). Pure: no electron, no I/O — store.js, scheduler.js, history.js and
// main.js call into it, and everything here runs under `node --test`.
//
// Ids: slot 1 is 'claude' (the 1.0.x id, so the shipped iPhone app, the `claude.session` history keys,
// providers.claude and expandedOpen.claude keep working); slot N ≥ 2 is 'claude-N', up to MAX_ACCOUNTS.
// Order everywhere: Claude accounts by slot, then 'codex', then any other id sorted.
//
// Account = { id, label, source, configDir, organizationId }
//   label           user label, trimmed, ≤ 40 chars; '' → the default display name
//   source          'claude_code' | 'claude_web' | 'claude_keychain'
//   configDir       Claude Code config folder as typed ('' = CLAUDE_CONFIG_DIR, else ~/.claude), ≤ 1024 chars
//   organizationId  claude_web: the selected claude.ai org uuid (≤ 200 chars) or null
//
// Exports:
//   MAX_ACCOUNTS, ACCOUNT_SOURCES, PRIMARY_ID
//   isClaudeId(id)                     'claude' or 'claude-2' … 'claude-6'
//   slotOf(id) → 1..6 | null           idForSlot(n) → id | null
//   nextFreeId(accounts) → id | null   lowest free slot (null when all six are taken)
//   accountDisplayName(account, accounts)   label, else 'Claude' (one account), else 'Claude <slot>'
//   defaultAccounts()                  a fresh one-account list
//   sanitizeAccounts(list, previousList)    the stored shape: valid entries only, unique ids, account 1 first,
//                                      sorted by slot; each invalid field falls back to the previous same-id
//                                      entry's value, then to the default
//   migrateLegacyAccounts({ claudeSource, claudeOrganizationId })   1.0.x single-source settings → account 1
//   applyLegacyAccountPatch(accounts, patch)   a claudeSource / claudeOrganizationId patch WITHOUT
//                                      claudeAccounts lands on account 1 (1.0.x callers keep working)
//   pruneAccountFlags(flags, accounts) drops claude-* keys of accounts that no longer exist (providers /
//                                      expandedOpen), so a removed account leaves no hidden flag behind
//   orderProviderIds(ids)              the display / payload order above
//   identityHash(uuid)                 sha256(uuid) hex, first 16 chars — snapshots never carry a raw uuid
//   sameAccount(a, b)                  two ProviderSnapshots are provably the same Claude account
//   dedupeSnapshot(providers) → { providers, duplicates }   later duplicates → null, duplicates[later] = earlier

const crypto = require('crypto');

const MAX_ACCOUNTS = 6;
const PRIMARY_ID = 'claude';
const ACCOUNT_SOURCES = Object.freeze(['claude_code', 'claude_web', 'claude_keychain']);
const MAX_LABEL_LENGTH = 40;
const MAX_CONFIG_DIR_LENGTH = 1024;
const MAX_ORG_ID_LENGTH = 200;
const SLOT_ID_RE = /^claude-([2-9])$/;
const DEFAULT_ACCOUNT = Object.freeze({ id: PRIMARY_ID, label: '', source: 'claude_code', configDir: '', organizationId: null });
// Snapshot statuses whose identity describes data the user is actually looking at.
const COMPARABLE_STATUSES = new Set(['ok', 'stale']);

// Field cleaners return the cleaned value or INVALID; `null` is a real value for organizationId ("no org
// selected"), so a sentinel rather than undefined/null marks a value that must fall back.
const INVALID = Symbol('invalid');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function slotOf(id) {
  if (id === PRIMARY_ID) return 1;
  const match = typeof id === 'string' ? SLOT_ID_RE.exec(id) : null;
  const slot = match ? Number(match[1]) : 0;
  return slot >= 2 && slot <= MAX_ACCOUNTS ? slot : null;
}

function isClaudeId(id) {
  return slotOf(id) !== null;
}

function idForSlot(slot) {
  if (slot === 1) return PRIMARY_ID;
  return Number.isInteger(slot) && slot >= 2 && slot <= MAX_ACCOUNTS ? `claude-${slot}` : null;
}

function nextFreeId(accounts) {
  const taken = new Set((Array.isArray(accounts) ? accounts : []).map((a) => (isPlainObject(a) ? a.id : null)));
  for (let slot = 1; slot <= MAX_ACCOUNTS; slot++) {
    const id = idForSlot(slot);
    if (!taken.has(id)) return id;
  }
  return null;
}

// A lone account reads exactly as 1.0.x did ("Claude"); with several, the unlabelled ones are numbered by slot.
function accountDisplayName(account, accounts) {
  const label = isPlainObject(account) && typeof account.label === 'string' ? account.label.trim() : '';
  if (label) return label;
  const count = Array.isArray(accounts) ? accounts.length : 1;
  const slot = isPlainObject(account) ? slotOf(account.id) : null;
  return count === 1 || !slot ? 'Claude' : `Claude ${slot}`;
}

function defaultAccounts() {
  return [{ ...DEFAULT_ACCOUNT }];
}

// Over-long labels are cut rather than rejected (harmless for a label, unlike a path or an org id).
function cleanLabel(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_LABEL_LENGTH).trim() : INVALID;
}

function cleanSource(value) {
  return ACCOUNT_SOURCES.includes(value) ? value : INVALID;
}

function cleanConfigDir(value) {
  if (typeof value !== 'string') return INVALID;
  const text = value.trim();
  return text.length <= MAX_CONFIG_DIR_LENGTH ? text : INVALID;
}

// null / '' = no org selected (a valid choice, as for the legacy claudeOrganizationId).
function cleanOrganizationId(value) {
  if (value === null) return null;
  if (typeof value !== 'string') return INVALID;
  const text = value.trim();
  if (!text) return null;
  return text.length <= MAX_ORG_ID_LENGTH ? text : INVALID;
}

function pick(value, previousValue, clean, fallback) {
  const cleaned = clean(value);
  if (cleaned !== INVALID) return cleaned;
  const prev = clean(previousValue);
  return prev !== INVALID ? prev : fallback;
}

// Always the same key order, so main.js's JSON comparison of prev/next settings only sees real changes.
function cleanAccount(entry, previous) {
  const prev = isPlainObject(previous) ? previous : {};
  return {
    id: entry.id,
    label: pick(entry.label, prev.label, cleanLabel, DEFAULT_ACCOUNT.label),
    source: pick(entry.source, prev.source, cleanSource, DEFAULT_ACCOUNT.source),
    configDir: pick(entry.configDir, prev.configDir, cleanConfigDir, DEFAULT_ACCOUNT.configDir),
    organizationId: pick(entry.organizationId, prev.organizationId, cleanOrganizationId, DEFAULT_ACCOUNT.organizationId),
  };
}

function bySlot(a, b) {
  return slotOf(a.id) - slotOf(b.id);
}

// Valid entries in input order, first of each id wins; each cleaned against `previousById`.
function collect(list, previousById) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    if (!isPlainObject(entry) || !isClaudeId(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(cleanAccount(entry, previousById.get(entry.id)));
  }
  return out;
}

function sanitizeAccounts(list, previousList) {
  const previous = collect(previousList, new Map());
  const previousById = new Map(previous.map((a) => [a.id, a]));
  // Not a list at all (a corrupt value, a bad patch) keeps the previous list, like every other setting.
  const source = Array.isArray(list) ? list : (previous.length > 0 ? previous : defaultAccounts());
  const accounts = collect(source, previousById);
  if (!accounts.some((a) => a.id === PRIMARY_ID)) {
    accounts.unshift(previousById.get(PRIMARY_ID) || { ...DEFAULT_ACCOUNT });
  }
  return accounts.sort(bySlot).slice(0, MAX_ACCOUNTS);
}

function migrateLegacyAccounts(legacy) {
  const src = isPlainObject(legacy) ? legacy : {};
  return [{
    ...DEFAULT_ACCOUNT,
    source: pick(src.claudeSource, undefined, cleanSource, DEFAULT_ACCOUNT.source),
    organizationId: pick(src.claudeOrganizationId, undefined, cleanOrganizationId, null),
  }];
}

// The renderer always sends the full claudeAccounts list; a patch that does so wins over the legacy keys.
// Anything else is returned as given (even a non-list), so sanitizeAccounts can fall back to the stored list.
function applyLegacyAccountPatch(accounts, patch) {
  if (!isPlainObject(patch) || patch.claudeAccounts !== undefined) return accounts;
  const changes = {};
  if (patch.claudeSource !== undefined) changes.source = patch.claudeSource;
  if (patch.claudeOrganizationId !== undefined) changes.organizationId = patch.claudeOrganizationId;
  if (Object.keys(changes).length === 0) return accounts;
  const list = Array.isArray(accounts) ? accounts : [];
  const index = list.findIndex((a) => isPlainObject(a) && a.id === PRIMARY_ID);
  if (index === -1) return [{ ...DEFAULT_ACCOUNT, ...changes }, ...list];
  return list.map((a, i) => (i === index ? { ...a, ...changes } : a));
}

// Any claude-* key without a matching account goes (including ids that can never be valid, e.g. 'claude-9').
function pruneAccountFlags(flags, accounts) {
  const ids = new Set((Array.isArray(accounts) ? accounts : []).map((a) => (isPlainObject(a) ? a.id : null)));
  const out = {};
  for (const [id, value] of Object.entries(isPlainObject(flags) ? flags : {})) {
    if (id.startsWith('claude-') && !ids.has(id)) continue;
    out[id] = value;
  }
  return out;
}

function providerRank(id) {
  if (isClaudeId(id)) return slotOf(id);
  return id === 'codex' ? MAX_ACCOUNTS + 1 : MAX_ACCOUNTS + 2;
}

function orderProviderIds(ids) {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string'))];
  return unique.sort((a, b) => providerRank(a) - providerRank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

function identityHash(uuid) {
  if (typeof uuid !== 'string' || !uuid) return null;
  return crypto.createHash('sha256').update(uuid).digest('hex').slice(0, 16);
}

function known(value) {
  return typeof value === 'string' && value.length > 0;
}

function comparable(snapshot) {
  return isPlainObject(snapshot) && COMPARABLE_STATUSES.has(snapshot.status) && isPlainObject(snapshot.identity);
}

// Conservative on purpose: a false merge hides a real account, a false split only shows one twice. So
// anything unknown is "different". Two known account ids decide, unless their orgs are known to differ: usage
// is per organisation, so one login on a personal plan and on a team seat is two usage pools. Otherwise the
// same org only proves the same account when both sides say it is a personal org (a team org holds many people).
function sameAccount(a, b) {
  if (!comparable(a) || !comparable(b)) return false;
  const x = a.identity;
  const y = b.identity;
  if (known(x.account) && known(y.account)) {
    return x.account === y.account && !(known(x.org) && known(y.org) && x.org !== y.org);
  }
  return known(x.org) && known(y.org) && x.org === y.org && x.personalOrg === true && y.personalOrg === true;
}

// Walks the Claude ids in slot order; a later account that matches an earlier visible one is shown once:
// the lowest slot keeps the card (its id, name, history line and alert latches stay put). When that card is
// stale and the twin is fresh — a lapsed read-only Keychain login next to a live claude.ai sign-in, or a 429
// back-off — the card shows the twin's fresh numbers under the lower slot's id and name, so nothing freezes at
// old values and the duplicate never pops in and out (one card, one alert per crossing). Non-Claude ids pass
// through untouched; the input is not mutated.
function dedupeSnapshot(providers) {
  const input = isPlainObject(providers) ? providers : {};
  const out = { ...input };
  const duplicates = {};
  const visible = [];
  for (const id of orderProviderIds(Object.keys(input)).filter(isClaudeId)) {
    const snapshot = input[id];
    if (!snapshot) continue;
    const twin = visible.find((v) => sameAccount(v.snapshot, snapshot));
    if (twin) {
      if (twin.snapshot.status === 'stale' && snapshot.status === 'ok') {
        twin.snapshot = { ...snapshot, id: twin.id, name: twin.snapshot.name };
        out[twin.id] = twin.snapshot;
      }
      out[id] = null;
      duplicates[id] = twin.id;
    } else {
      visible.push({ id, snapshot });
    }
  }
  return { providers: out, duplicates };
}

module.exports = {
  MAX_ACCOUNTS,
  ACCOUNT_SOURCES,
  PRIMARY_ID,
  isClaudeId,
  slotOf,
  idForSlot,
  nextFreeId,
  accountDisplayName,
  defaultAccounts,
  sanitizeAccounts,
  migrateLegacyAccounts,
  applyLegacyAccountPatch,
  pruneAccountFlags,
  orderProviderIds,
  identityHash,
  sameAccount,
  dedupeSnapshot,
};
