'use strict';
// Several Claude accounts (src/main/accounts.js): ids/slots/order, display names, the settings list
// (sanitize, 1.0.x migration, legacy patches, stale flag cleanup), identity hashing and the dedupe that
// shows one account once. The last block loads store.js with electron-store stubbed, so the wiring of
// those helpers into getSettings / saveSettings is covered too.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const Module = require('module');
const accounts = require('../src/main/accounts');

const {
  MAX_ACCOUNTS, ACCOUNT_SOURCES, isClaudeId, slotOf, idForSlot, nextFreeId, accountDisplayName, defaultAccounts,
  sanitizeAccounts, migrateLegacyAccounts, applyLegacyAccountPatch, pruneAccountFlags, orderProviderIds,
  identityHash, sameAccount, dedupeSnapshot,
} = accounts;

// Obviously fake ids; the repo is public.
const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const ACC_1 = '11111111-1111-4111-8111-111111111111';
const ACC_2 = '22222222-2222-4222-8222-222222222222';

function account(id, fields = {}) {
  return { id, label: '', source: 'claude_code', configDir: '', organizationId: null, ...fields };
}

function snap(id, identity, overrides = {}) {
  return {
    id, name: id, status: 'ok', error: null, source: 'claude_code', plan: 'Max 5x', account: null, updatedAt: 1,
    windows: [], extra: null, credits: null, raw: {}, identity, ...overrides,
  };
}

const ident = (account, org, personalOrg) => ({ account: identityHash(account), org: identityHash(org), personalOrg });

// ---------------------------------------------------------------------------------------------
// Ids, slots, order
// ---------------------------------------------------------------------------------------------
test('Claude ids: slot 1 is "claude", slots 2..6 are "claude-N"; nothing else is a Claude id', () => {
  assert.equal(MAX_ACCOUNTS, 6);
  assert.deepEqual([...ACCOUNT_SOURCES], ['claude_code', 'claude_web', 'claude_keychain']);
  for (const id of ['claude', 'claude-2', 'claude-3', 'claude-4', 'claude-5', 'claude-6']) assert.equal(isClaudeId(id), true, id);
  for (const id of ['claude-1', 'claude-7', 'claude-9', 'claude-02', 'claude-10', 'claude-', 'Claude', 'claude-2 ', 'codex', '', null, undefined, 2, {}]) {
    assert.equal(isClaudeId(id), false, String(id));
    assert.equal(slotOf(id), null, String(id));
  }
  assert.equal(slotOf('claude'), 1);
  assert.equal(slotOf('claude-4'), 4);
  for (let slot = 1; slot <= MAX_ACCOUNTS; slot++) assert.equal(slotOf(idForSlot(slot)), slot, 'round trip');
  assert.equal(idForSlot(1), 'claude');
  assert.equal(idForSlot(6), 'claude-6');
  for (const bad of [0, 7, 2.5, '2', null]) assert.equal(idForSlot(bad), null, String(bad));
});

test('nextFreeId is the lowest free slot, null when all six are taken', () => {
  assert.equal(nextFreeId([account('claude')]), 'claude-2');
  assert.equal(nextFreeId([account('claude'), account('claude-2'), account('claude-4')]), 'claude-3', 'a gap is reused first');
  assert.equal(nextFreeId([account('claude'), account('claude-3'), null, 'junk']), 'claude-2', 'junk entries ignored');
  const full = [1, 2, 3, 4, 5, 6].map((n) => account(idForSlot(n)));
  assert.equal(nextFreeId(full), null);
  assert.equal(nextFreeId([]), 'claude', 'an empty list has slot 1 free');
  assert.equal(nextFreeId(undefined), 'claude');
});

test('orderProviderIds: Claude accounts by slot, then codex, then any other id sorted', () => {
  assert.deepEqual(
    orderProviderIds(['codex', 'claude-3', 'gemini', 'claude', 'claude-2', 'abc', 'claude-9', 'claude-3', 7, null]),
    ['claude', 'claude-2', 'claude-3', 'codex', 'abc', 'claude-9', 'gemini'],
  );
  assert.deepEqual(orderProviderIds(['claude-6', 'claude-5', 'claude-4']), ['claude-4', 'claude-5', 'claude-6'], 'numeric slot order, not insertion');
  assert.deepEqual(orderProviderIds('nope'), []);
  const input = ['codex', 'claude'];
  orderProviderIds(input);
  assert.deepEqual(input, ['codex', 'claude'], 'input not sorted in place');
});

// ---------------------------------------------------------------------------------------------
// Display names
// ---------------------------------------------------------------------------------------------
test('accountDisplayName: "Claude" for a lone account, "Claude <slot>" with several, the label always wins', () => {
  const one = [account('claude')];
  assert.equal(accountDisplayName(one[0], one), 'Claude', 'a single-account widget reads exactly as 1.0.x');

  const many = [account('claude'), account('claude-3'), account('claude-4', { label: '  Work  ' })];
  assert.equal(accountDisplayName(many[0], many), 'Claude 1');
  assert.equal(accountDisplayName(many[1], many), 'Claude 3', 'numbered by slot, not by position');
  assert.equal(accountDisplayName(many[2], many), 'Work', 'label trimmed');

  const labelled = [account('claude', { label: 'Home' })];
  assert.equal(accountDisplayName(labelled[0], labelled), 'Home', 'a label also wins on a lone account');
  assert.equal(accountDisplayName(account('claude-2', { label: '   ' }), many), 'Claude 2', 'whitespace label = no label');
  assert.equal(accountDisplayName(account('claude-2', { label: 42 }), many), 'Claude 2');
  assert.equal(accountDisplayName(null, many), 'Claude');
});

// ---------------------------------------------------------------------------------------------
// Settings list
// ---------------------------------------------------------------------------------------------
test('defaultAccounts is one fresh claude_code account each call', () => {
  const a = defaultAccounts();
  assert.deepEqual(a, [{ id: 'claude', label: '', source: 'claude_code', configDir: '', organizationId: null }]);
  a[0].label = 'mutated';
  a.push(account('claude-2'));
  assert.deepEqual(defaultAccounts(), [account('claude')]);
});

test('migrateLegacyAccounts: a 1.0.x claude_code or claude_web config (with its org) becomes account 1', () => {
  assert.deepEqual(migrateLegacyAccounts({ claudeSource: 'claude_code', claudeOrganizationId: null }), [account('claude')]);
  assert.deepEqual(
    migrateLegacyAccounts({ claudeSource: 'claude_web', claudeOrganizationId: ORG_A }),
    [account('claude', { source: 'claude_web', organizationId: ORG_A })],
  );
  assert.deepEqual(
    migrateLegacyAccounts({ claudeSource: 'claude_code', claudeOrganizationId: ORG_B }),
    [account('claude', { organizationId: ORG_B })],
    'an org chosen under claude_web survives a switch back to claude_code, as the legacy key did',
  );
  assert.equal(migrateLegacyAccounts({ claudeSource: 'claude_keychain' })[0].source, 'claude_keychain');
  assert.equal(migrateLegacyAccounts({ claudeSource: 'bogus' })[0].source, 'claude_code', 'invalid legacy source → default');
  assert.equal(migrateLegacyAccounts({ claudeOrganizationId: '' })[0].organizationId, null);
  assert.equal(migrateLegacyAccounts({ claudeOrganizationId: 42 })[0].organizationId, null);
  assert.deepEqual(migrateLegacyAccounts(undefined), [account('claude')]);
  assert.deepEqual(migrateLegacyAccounts('junk'), [account('claude')]);
});

test('applyLegacyAccountPatch: claudeSource / claudeOrganizationId alone land on account 1; claudeAccounts wins', () => {
  const list = [account('claude', { organizationId: ORG_A }), account('claude-2', { source: 'claude_web' })];
  const frozen = JSON.parse(JSON.stringify(list));

  const source = applyLegacyAccountPatch(list, { claudeSource: 'claude_web' });
  assert.deepEqual(source, [account('claude', { source: 'claude_web', organizationId: ORG_A }), list[1]]);
  assert.deepEqual(list, frozen, 'input not mutated');

  const cleared = applyLegacyAccountPatch(list, { claudeOrganizationId: null });
  assert.equal(cleared[0].organizationId, null, 'null clears the org');
  assert.equal(cleared[0].source, 'claude_code');

  const both = applyLegacyAccountPatch(list, { claudeSource: 'claude_web', claudeOrganizationId: ORG_B });
  assert.deepEqual(both[0], account('claude', { source: 'claude_web', organizationId: ORG_B }));

  assert.equal(applyLegacyAccountPatch(list, { claudeSource: 'claude_web', claudeAccounts: [] }), list, 'with claudeAccounts the legacy keys are ignored');
  assert.equal(applyLegacyAccountPatch(list, { theme: 'light' }), list, 'nothing legacy → unchanged');
  assert.equal(applyLegacyAccountPatch(list, null), list);
  // A garbage list in the patch passes through as is, so sanitize falls back to the stored list
  // (turning it into [] here would delete every account but the first).
  assert.equal(applyLegacyAccountPatch('oops', { claudeAccounts: 'oops' }), 'oops');
  assert.equal(applyLegacyAccountPatch(undefined, { theme: 'light' }), undefined);

  const noPrimary = applyLegacyAccountPatch([account('claude-2')], { claudeSource: 'claude_web' });
  assert.deepEqual(noPrimary, [account('claude', { source: 'claude_web' }), account('claude-2')], 'account 1 is created when missing');
  assert.deepEqual(applyLegacyAccountPatch('junk', { claudeSource: 'claude_web' }), [account('claude', { source: 'claude_web' })]);
});

test('sanitizeAccounts drops garbage, keeps the first of each id, sorts by slot and always has account 1 first', () => {
  const out = sanitizeAccounts([
    null, 'claude-2', 5, [], { label: 'no id' }, account('codex'), account('claude-7'), account('claude-1'),
    account('claude-4', { label: 'Four' }),
    account('claude-2', { label: 'First two' }),
    account('claude-2', { label: 'Second two' }),
    account('claude', { label: 'One' }),
  ], null);
  assert.deepEqual(out.map((a) => [a.id, a.label]), [['claude', 'One'], ['claude-2', 'First two'], ['claude-4', 'Four']]);

  // Account 1 missing → the previous list's account 1 (all of its fields), else the default.
  const previous = [account('claude', { label: 'Prev one', source: 'claude_web', organizationId: ORG_A }), account('claude-3')];
  assert.deepEqual(sanitizeAccounts([account('claude-3', { label: 'Three' })], previous), [previous[0], account('claude-3', { label: 'Three' })]);
  assert.deepEqual(sanitizeAccounts([account('claude-3')], null), [account('claude'), account('claude-3')]);
  assert.deepEqual(sanitizeAccounts([], previous), [previous[0]], 'an empty list still keeps account 1 (it can never be removed)');

  // Not a list at all → the previous list (a corrupt value never wipes the accounts), else the default.
  assert.deepEqual(sanitizeAccounts('junk', previous), previous);
  assert.deepEqual(sanitizeAccounts(undefined, previous), previous);
  assert.deepEqual(sanitizeAccounts({ 0: account('claude') }, null), defaultAccounts());
  assert.deepEqual(sanitizeAccounts(undefined, 'also junk'), defaultAccounts());
});

test('sanitizeAccounts caps the list at six accounts in slot order', () => {
  const ids = ['claude-6', 'claude-5', 'claude-4', 'claude-3', 'claude-2', 'claude', 'claude-7', 'claude-8', 'claude-6'];
  const out = sanitizeAccounts(ids.map((id) => account(id, { label: id })), null);
  assert.equal(out.length, MAX_ACCOUNTS);
  assert.deepEqual(out.map((a) => a.id), ['claude', 'claude-2', 'claude-3', 'claude-4', 'claude-5', 'claude-6']);
});

test('sanitizeAccounts per field: invalid → the previous same-id value → the default', () => {
  const previous = [
    account('claude', { label: 'Home', source: 'claude_web', configDir: '~/.claude-home', organizationId: ORG_A }),
    account('claude-2', { label: 'Work', source: 'claude_keychain', configDir: '/Users/fake/.claude-work', organizationId: ORG_B }),
  ];
  const bad = { label: 42, source: 'bogus', configDir: 'x'.repeat(1025), organizationId: { uuid: ORG_B } };
  const out = sanitizeAccounts([{ id: 'claude', ...bad }, { id: 'claude-2', ...bad }, { id: 'claude-3', ...bad }], previous);
  assert.deepEqual(out[0], previous[0], 'every field from the previous same-id entry');
  assert.deepEqual(out[1], previous[1], 'per id: account 2 does not borrow account 1 values');
  assert.deepEqual(out[2], account('claude-3'), 'no previous entry → defaults');

  // A field that is missing altogether counts as invalid (a partial entry never wipes what was stored).
  assert.deepEqual(sanitizeAccounts([{ id: 'claude-2' }, { id: 'claude' }], previous), previous);

  // An invalid previous value is not trusted either.
  const junkPrev = [{ id: 'claude', label: 7, source: 'nope', configDir: null, organizationId: 9 }];
  assert.deepEqual(sanitizeAccounts([{ id: 'claude' }], junkPrev), [account('claude')]);
});

test('sanitizeAccounts keeps valid values: trims, cuts labels at 40, null/"" clear the org, folders stay as typed', () => {
  const previous = [account('claude', { label: 'Old', organizationId: ORG_A, configDir: '/old' })];
  const out = sanitizeAccounts([
    { id: 'claude', label: '  Personal  ', source: 'claude_keychain', configDir: '  ~/.claude-1  ', organizationId: null, extra: 'dropped' },
    { id: 'claude-2', label: `${'L'.repeat(45)}`, source: 'claude_web', configDir: '', organizationId: `  ${ORG_B}  ` },
    { id: 'claude-3', label: '', source: 'claude_code', configDir: '~\\.claude-3', organizationId: '' },
  ], previous);
  assert.deepEqual(out[0], { id: 'claude', label: 'Personal', source: 'claude_keychain', configDir: '~/.claude-1', organizationId: null },
    'null is a valid "no org" (not a fallback to the previous org); unknown keys dropped');
  assert.equal(out[1].label, 'L'.repeat(40));
  assert.equal(out[1].organizationId, ORG_B);
  assert.equal(out[1].configDir, '', "'' = the default folder, a valid value");
  assert.equal(out[2].configDir, '~\\.claude-3', '~ expanded only at use');
  assert.equal(out[2].organizationId, null);
  assert.equal(sanitizeAccounts([{ id: 'claude', organizationId: 'o'.repeat(201) }], previous)[0].organizationId, ORG_A, 'over-long org → previous');
  assert.equal(sanitizeAccounts([{ id: 'claude', configDir: 'd'.repeat(1024) }], previous)[0].configDir, 'd'.repeat(1024), '1024 chars is allowed');
  assert.deepEqual(Object.keys(out[2]), ['id', 'label', 'source', 'configDir', 'organizationId'], 'stable key order (main.js compares JSON)');

  const input = [{ id: 'claude-2', label: ' x ' }, { id: 'claude', label: ' y ' }];
  const copy = JSON.parse(JSON.stringify(input));
  sanitizeAccounts(input, previous);
  assert.deepEqual(input, copy, 'input not mutated or reordered');
});

test('pruneAccountFlags drops claude-* keys without an account and keeps everything else', () => {
  const list = [account('claude'), account('claude-2')];
  const flags = { claude: false, codex: true, 'claude-2': false, 'claude-3': false, 'claude-9': true, gemini: false };
  assert.deepEqual(pruneAccountFlags(flags, list), { claude: false, codex: true, 'claude-2': false, gemini: false });
  assert.equal(flags['claude-3'], false, 'input not mutated');
  assert.deepEqual(pruneAccountFlags(flags, [account('claude'), account('claude-2'), account('claude-3')]),
    { claude: false, codex: true, 'claude-2': false, 'claude-3': false, gemini: false }, 'a configured account keeps its flag');
  assert.deepEqual(pruneAccountFlags(null, list), {});
});

// ---------------------------------------------------------------------------------------------
// Identity + dedupe
// ---------------------------------------------------------------------------------------------
test('identityHash is the first 16 hex chars of sha256(uuid), never the uuid itself', () => {
  const h = identityHash(ACC_1);
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(h, crypto.createHash('sha256').update(ACC_1).digest('hex').slice(0, 16));
  assert.equal(identityHash(ACC_1), h, 'deterministic');
  assert.notEqual(identityHash(ACC_2), h);
  assert.ok(!h.includes(ACC_1.slice(0, 8)));
  for (const bad of ['', null, undefined, 42, {}]) assert.equal(identityHash(bad), null, String(bad));
});

test('sameAccount matrix: known account ids decide; else the same org only when both say it is personal', () => {
  const cases = [
    // [a identity, b identity, same?, why]
    [ident(ACC_1, ORG_A, true), ident(ACC_1, ORG_B, false), true, 'same account id, whatever the orgs'],
    [ident(ACC_1, ORG_A, true), ident(ACC_2, ORG_A, true), false, 'different account ids win over a shared personal org'],
    [ident(null, ORG_A, true), ident(ACC_1, ORG_A, true), true, 'one account unknown (claude_web), same personal org'],
    [ident(null, ORG_A, true), ident(null, ORG_A, true), true, 'both unknown, same personal org'],
    [ident(null, ORG_A, true), ident(null, ORG_B, true), false, 'different orgs'],
    [ident(null, ORG_A, false), ident(ACC_1, ORG_A, false), false, 'a shared team org holds many people'],
    [ident(null, ORG_A, true), ident(ACC_1, ORG_A, false), false, 'one side team'],
    [ident(null, ORG_A, null), ident(ACC_1, ORG_A, true), false, 'org type unknown on one side'],
    [ident(null, null, true), ident(null, null, true), false, 'no org known'],
    [ident(null, ORG_A, true), null, false, 'no identity'],
    [{ account: '', org: '', personalOrg: true }, { account: '', org: '', personalOrg: true }, false, 'empty strings are unknown'],
  ];
  for (const [x, y, expected, why] of cases) {
    assert.equal(sameAccount(snap('claude', x), snap('claude-2', y)), expected, why);
    assert.equal(sameAccount(snap('claude-2', y), snap('claude', x)), expected, `${why} (symmetric)`);
  }
});

test('sameAccount only compares data the user is looking at: ok and stale, never error / auth_required', () => {
  const id = ident(ACC_1, ORG_A, true);
  assert.equal(sameAccount(snap('claude', id), snap('claude-2', id, { status: 'stale' })), true, 'stale keeps last good identity and counts');
  for (const status of ['error', 'auth_required', undefined]) {
    assert.equal(sameAccount(snap('claude', id), snap('claude-2', id, { status })), false, String(status));
    assert.equal(sameAccount(snap('claude', id, { status }), snap('claude-2', id)), false, `${status} (first)`);
  }
  assert.equal(sameAccount(null, snap('claude', id)), false);
});

test('dedupeSnapshot: a later duplicate becomes null and points at the lowest visible slot; others untouched', () => {
  const same = ident(ACC_1, ORG_A, true);
  const other = ident(ACC_2, ORG_B, true);
  const codex = snap('codex', same, { source: 'codex_auth_file' }); // even an equal identity never merges Codex
  // Insertion order deliberately not slot order.
  const providers = {
    'claude-4': snap('claude-4', same, { status: 'stale' }),
    codex,
    'claude-2': snap('claude-2', same),
    claude: snap('claude', same),
    'claude-3': snap('claude-3', other),
    'claude-5': snap('claude-5', same, { status: 'error' }),
    'claude-6': null,
  };
  const before = JSON.parse(JSON.stringify(providers));
  const { providers: out, duplicates } = dedupeSnapshot(providers);
  assert.deepEqual(duplicates, { 'claude-2': 'claude', 'claude-4': 'claude' });
  assert.equal(out.claude, providers.claude, 'the lowest slot keeps its snapshot');
  assert.equal(out['claude-2'], null);
  assert.equal(out['claude-4'], null);
  assert.equal(out['claude-3'], providers['claude-3'], 'a different account stays');
  assert.equal(out['claude-5'], providers['claude-5'], 'an error snapshot is never merged (nothing to compare)');
  assert.equal(out['claude-6'], null);
  assert.equal(out.codex, codex, 'Codex passes through untouched');
  assert.deepEqual(Object.keys(out), Object.keys(providers), 'same keys, same order');
  assert.deepEqual(providers, before, 'input not mutated');
});

test('dedupeSnapshot: a hidden earlier account absorbs nothing; distinct accounts produce no duplicates', () => {
  const same = ident(null, ORG_A, true);
  const hiddenFirst = dedupeSnapshot({ claude: null, 'claude-2': snap('claude-2', same), 'claude-3': snap('claude-3', same), codex: null });
  assert.deepEqual(hiddenFirst.duplicates, { 'claude-3': 'claude-2' }, 'account 1 is off, so account 2 is the one shown');
  assert.notEqual(hiddenFirst.providers['claude-2'], null);

  const distinct = { claude: snap('claude', ident(ACC_1, ORG_A, true)), 'claude-2': snap('claude-2', ident(ACC_2, ORG_A, true)) };
  const result = dedupeSnapshot(distinct);
  assert.deepEqual(result.duplicates, {});
  assert.deepEqual(result.providers, distinct);
  assert.notEqual(result.providers, distinct, 'a new object even when nothing changed');

  assert.deepEqual(dedupeSnapshot(null), { providers: {}, duplicates: {} });
  assert.deepEqual(dedupeSnapshot({ claude: 'junk', 'claude-2': 5 }), { providers: { claude: 'junk', 'claude-2': 5 }, duplicates: {} });
});

// ---------------------------------------------------------------------------------------------
// store.js wiring (electron-store stubbed; the store module needs Electron to load otherwise)
// ---------------------------------------------------------------------------------------------
function loadStore(storedSettings) {
  const storePath = require.resolve('../src/main/store');
  const esPath = require.resolve('electron-store', { paths: [require('path').dirname(storePath)] });
  const data = {};
  if (storedSettings !== undefined) data.settings = JSON.parse(JSON.stringify(storedSettings));
  class FakeStore {
    get(key, fallback) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : fallback; }
    set(key, value) { data[key] = JSON.parse(JSON.stringify(value)); }
  }
  const stub = new Module(esPath);
  stub.filename = esPath;
  stub.loaded = true;
  stub.exports = FakeStore;
  require.cache[esPath] = stub;
  delete require.cache[storePath];
  return { ...require(storePath), data };
}

test('store: defaults and the 1.0.x migration (claude_code, claude_web + org) through getSettings', () => {
  const fresh = loadStore();
  const s = fresh.getSettings();
  assert.deepEqual(s.claudeAccounts, defaultAccounts());
  assert.equal(s.claudeSource, 'claude_code');
  assert.equal(s.claudeOrganizationId, null);
  assert.deepEqual(fresh.SETTINGS_DEFAULTS.claudeAccounts, defaultAccounts());

  const web = loadStore({ claudeSource: 'claude_web', claudeOrganizationId: ORG_A, theme: 'light', providers: { claude: false } });
  const w = web.getSettings();
  assert.deepEqual(w.claudeAccounts, [account('claude', { source: 'claude_web', organizationId: ORG_A })]);
  assert.equal(w.claudeSource, 'claude_web');
  assert.equal(w.claudeOrganizationId, ORG_A);
  assert.equal(w.theme, 'light');
  assert.equal(w.providers.claude, false, 'account 1 visibility stays providers.claude');

  // A stored list that lost account 1 gets it back from the (mirrored) legacy keys, not from the defaults.
  const lost = loadStore({ claudeSource: 'claude_web', claudeOrganizationId: ORG_A, claudeAccounts: [account('claude-2', { label: 'Two' })] });
  assert.deepEqual(lost.getSettings().claudeAccounts, [account('claude', { source: 'claude_web', organizationId: ORG_A }), account('claude-2', { label: 'Two' })]);

  // A stored list wins over the legacy keys, and they are re-mirrored from it.
  const listed = loadStore({ claudeSource: 'claude_code', claudeAccounts: [account('claude', { source: 'claude_keychain' })] });
  assert.equal(listed.getSettings().claudeSource, 'claude_keychain');

  const garbage = loadStore({ claudeSource: 'claude_web', claudeAccounts: [5, 'x'] });
  assert.deepEqual(garbage.getSettings().claudeAccounts, [account('claude', { source: 'claude_web' })], 'no valid entry → migrated');
});

test('store: saveSettings replaces the whole list, mirrors account 1 and drops a removed account\'s flags', () => {
  const s = loadStore();
  const three = [account('claude'), account('claude-2', { source: 'claude_web', label: 'Work' }), account('claude-3', { configDir: '~/.claude-3' })];
  let saved = s.saveSettings({ claudeAccounts: three, providers: { 'claude-3': false }, expandedOpen: { 'claude-3': true } });
  assert.deepEqual(saved.claudeAccounts, three);
  assert.equal(saved.providers['claude-3'], false);
  assert.deepEqual(s.data.settings.claudeAccounts, three, 'persisted');

  // The renderer sends the full list: account 3 removed → it is gone (arrays are replaced, never merged)
  // and so are its hidden / expanded flags.
  saved = s.saveSettings({ claudeAccounts: three.slice(0, 2) });
  assert.deepEqual(saved.claudeAccounts.map((a) => a.id), ['claude', 'claude-2']);
  assert.ok(!('claude-3' in saved.providers), 'providers flag dropped');
  assert.ok(!('claude-3' in saved.expandedOpen), 'expandedOpen flag dropped');
  assert.equal(saved.providers.codex, true);

  // A garbage list keeps the stored one.
  assert.deepEqual(s.saveSettings({ claudeAccounts: 'oops' }).claudeAccounts.map((a) => a.id), ['claude', 'claude-2']);

  // Account 1's source / org changed through the list → the legacy keys follow.
  saved = s.saveSettings({ claudeAccounts: [account('claude', { source: 'claude_web', organizationId: ORG_B }), saved.claudeAccounts[1]] });
  assert.equal(saved.claudeSource, 'claude_web');
  assert.equal(saved.claudeOrganizationId, ORG_B);
});

test('store: 1.0.x patches (claudeSource / claudeOrganizationId alone) change account 1; with claudeAccounts the list wins', () => {
  const s = loadStore({ claudeAccounts: [account('claude'), account('claude-2', { source: 'claude_web', organizationId: ORG_A })] });
  let saved = s.saveSettings({ claudeSource: 'claude_web' });
  assert.equal(saved.claudeAccounts[0].source, 'claude_web');
  assert.equal(saved.claudeSource, 'claude_web');
  assert.deepEqual(saved.claudeAccounts[1], account('claude-2', { source: 'claude_web', organizationId: ORG_A }), 'other accounts untouched');

  saved = s.saveSettings({ claudeOrganizationId: ORG_B });
  assert.equal(saved.claudeAccounts[0].organizationId, ORG_B);
  saved = s.saveSettings({ claudeOrganizationId: null });
  assert.equal(saved.claudeAccounts[0].organizationId, null, 'null clears it');
  assert.equal(saved.claudeOrganizationId, null);

  saved = s.saveSettings({ claudeSource: 'bogus' });
  assert.equal(saved.claudeSource, 'claude_web', 'an invalid source keeps the previous one');

  saved = s.saveSettings({ claudeSource: 'claude_keychain', claudeAccounts: [account('claude', { source: 'claude_code' })] });
  assert.equal(saved.claudeSource, 'claude_code', 'claudeAccounts wins; the legacy key is re-mirrored from it');
  assert.deepEqual(saved.claudeAccounts, [account('claude')]);

  saved = s.saveSettings({ theme: 'light' });
  assert.deepEqual(saved.claudeAccounts, [account('claude')], 'an unrelated patch leaves the list alone');
});
