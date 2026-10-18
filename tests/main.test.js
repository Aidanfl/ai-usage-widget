'use strict';
// main.js wiring for several Claude accounts: the account registry, per-account claude.ai sessions and
// the claude.ai IPC surface (plus the preload bridge for it). main.js only runs under Electron, so it is
// loaded here with every dependency replaced by a small fake (a Module._load hook scoped to main.js and
// preload.js) and driven through the IPC handlers and scheduler callbacks it registers. The fakes follow
// the module contracts, not the other modules' code, so this file tests main.js alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

const MAIN = path.join(__dirname, '..', 'src', 'main', 'main.js');
const PRELOAD = path.join(__dirname, '..', 'src', 'preload.js');

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const enc = (text) => Buffer.from(`enc:${text}`).toString('base64');
const dec = (blob) => Buffer.from(blob, 'base64').toString().replace(/^enc:/, '');
const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

// The harness the Module._load hook currently serves (one at a time; node:test runs a file's tests in order).
let current = null;
const realLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
  if (current && parent && (parent.filename === MAIN || parent.filename === PRELOAD)) {
    if (current.missing.has(request)) {
      const err = new Error(`Cannot find module '${request}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    if (Object.prototype.hasOwnProperty.call(current.modules, request)) return current.modules[request];
  }
  return realLoad.call(this, request, parent, ...rest);
};
test.after(() => { Module._load = realLoad; });

// main.js logs through console; each harness collects its lines (and restores the real console after).
const realConsole = { log: console.log, warn: console.warn, error: console.error };

function acct(id, source = 'claude_code', extra = {}) {
  return { id, label: '', source, configDir: '', organizationId: null, ...extra };
}

// Same rules as accounts.js per the contract (§1 ids/slots, §3 display name); dedupe returns a marker.
function fakeAccountsLib() {
  const slotOf = (id) => (id === 'claude' ? 1 : Number(id.slice('claude-'.length)));
  return {
    isClaudeId: (id) => id === 'claude' || /^claude-[2-6]$/.test(id),
    slotOf,
    accountDisplayName: (account, list) => account.label || (list.length === 1 ? 'Claude' : `Claude ${slotOf(account.id)}`),
    dedupeSnapshot: (providers) => ({ providers: { ...providers, dedupedBy: 'accounts.js' }, duplicates: { 'claude-2': 'claude' } }),
  };
}

function okSnapshot(id, name, extra = {}) {
  return {
    id, name, status: 'ok', error: null, source: 'claude_code', plan: 'Pro', account: null, updatedAt: 1,
    windows: [{ key: 'weekly', percent: 10 }], extra: null, credits: null, identity: null, raw: {}, ...extra,
  };
}

/**
 * boot({ accounts, settings, config, missing, ready, storeFaults, accountsLib, trayThrows }) → harness.
 * `config` holds the top-level store keys next to `settings` (claudeWebSession / claudeWebSessions).
 */
async function boot({ accounts = [acct('claude')], settings = {}, config = {}, missing = [], ready = true, storeFaults = false, accountsLib = fakeAccountsLib(), trayThrows = false } = {}) {
  const h = {
    missing: new Set(missing),
    config: clone(config),
    saves: [],
    created: [],          // every provider instance made by a factory, in order
    forgotten: [],        // scheduler.forgetProvider ids
    historyForgotten: [], // history.forgetProvider ids
    alertsForgotten: [],  // alerts.forget ids
    inFlight: null,       // a promise standing for a scheduler tick in flight (isRefreshing() while set)
    refreshes: 0,
    trayRebuilds: 0,
    sent: [],             // broadcasts to the renderer { channel, payload }
    logs: [],
    handlers: {},
    schedulerOpts: null,
    ready: false,
    loginGate: null,      // optional promise a fake login awaits before its cookie "arrives"
    codeFactoryThrows: false,
  };

  // --- settings store (contract §2 semantics main.js relies on) ---
  const normalize = (s) => {
    const out = clone(s);
    const ids = new Set(out.claudeAccounts.map((a) => a.id));
    out.claudeSource = out.claudeAccounts[0].source;
    out.claudeOrganizationId = out.claudeAccounts[0].organizationId;
    out.providers = Object.fromEntries(Object.entries(out.providers || {}).filter(([id]) => !/^claude-/.test(id) || ids.has(id)));
    return out;
  };
  let stored = normalize({
    refreshInterval: '120', background: 'acrylic', compactMode: false, hideFromTaskbar: false, alwaysOnTop: true,
    trayStats: 'off', tokenAutoRefresh: true, expandedOpen: {}, providers: { claude: true, codex: true },
    phoneSyncEnabled: false, phoneRelayUrl: '', ...settings, claudeAccounts: accounts,
  });
  const configStore = {
    get: (key, fallback) => (Object.prototype.hasOwnProperty.call(h.config, key) ? clone(h.config[key]) : fallback),
    set: (key, value) => {
      if (storeFaults) throw new Error('disk full');
      h.config[key] = clone(value);
    },
    delete: (key) => {
      if (storeFaults) throw new Error('disk full');
      delete h.config[key];
    },
  };
  h.getSettings = () => clone(stored);
  const saveSettings = (patch) => {
    h.saves.push(clone(patch));
    stored = normalize({ ...stored, ...clone(patch), providers: { ...stored.providers, ...((patch && patch.providers) || {}) } });
    return clone(stored);
  };

  // --- electron ---
  const webContents = { send: (channel, payload) => h.sent.push({ channel, payload: clone(payload) }), isDestroyed: () => false };
  h.win = {
    webContents, isDestroyed: () => false, on() {}, hide() {}, destroy() {}, isMinimized: () => false, isVisible: () => true,
    getContentSize: () => [620, 400], getBounds: () => ({ x: 0, y: 0, width: 620, height: 400 }), setAlwaysOnTop() {}, setSkipTaskbar() {},
  };
  let becomeReady;
  const readyPromise = new Promise((resolve) => { becomeReady = resolve; });
  h.becomeReady = async () => { h.ready = true; becomeReady(); await flush(); };
  const electron = {
    app: {
      requestSingleInstanceLock: () => true, setAppUserModelId() {}, quit() {}, on() {}, whenReady: () => readyPromise,
      isReady: () => h.ready, getVersion: () => '1.1.0', isPackaged: false, getPath: () => '/nonexistent', setLoginItemSettings() {}, dock: null,
    },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: (channel, fn) => { h.handlers[channel] = fn; }, on() {} },
    shell: { openExternal: async () => {} },
    Notification: Object.assign(function Notification() { return { show() {} }; }, { isSupported: () => false }),
    powerMonitor: { on() {} },
    session: { defaultSession: { setPermissionRequestHandler() {} } },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(`enc:${text}`),
      decryptString: (buf) => {
        const text = buf.toString();
        if (!text.startsWith('enc:')) throw new Error('cannot decrypt');
        return text.slice(4);
      },
    },
  };

  // --- provider factories ---
  const webInstance = (opts) => {
    const inst = {
      kind: 'web', opts, sessions: [], logouts: 0, wipes: 0, logins: 0, selected: [], next: null,
      setSession(session) { inst.sessions.push(clone(session)); },
      async login({ onSessionKey }) {
        inst.logins += 1;
        if (h.loginGate) await h.loginGate;
        const organizationId = `org-${opts.id}`;
        await onSessionKey(`sk-fake-${opts.id}`, { organizationId, organizations: [] });
        return { success: true, organizationId, organizations: [] };
      },
      async logout() {
        inst.logouts += 1;
        if (inst.logoutFails) throw new Error('partition gone');
        return true;
      },
      async wipe() {
        inst.wipes += 1;
        if (inst.logoutFails) throw new Error('partition gone');
        return true;
      },
      async listOrgs() { return [{ id: 'org-a', name: 'Org A', isTeam: false, raw: {} }, { id: 'org-b', name: null, isTeam: true }]; },
      async selectOrg(orgId) { inst.selected.push(orgId); return true; },
      async fetchSnapshot() { return inst.next || okSnapshot('claude', 'Claude', { source: 'claude_web' }); },
    };
    h.created.push(inst);
    return inst;
  };
  const codeInstance = (opts) => {
    if (h.codeFactoryThrows) throw new Error('bad config folder');
    const inst = {
      kind: 'code', opts, next: null, gate: null,
      async fetchSnapshot() { if (inst.gate) await inst.gate; return inst.next || okSnapshot('claude', 'Claude'); },
    };
    h.created.push(inst);
    return inst;
  };

  h.modules = {
    electron,
    'electron-store': class FakeStore { constructor() { this.data = {}; } get(k, d) { return k in this.data ? this.data[k] : d; } set(k, v) { this.data[k] = v; } },
    './store': { store: configStore, getSettings: h.getSettings, saveSettings },
    './window': {
      createMainWindow: () => h.win, acrylicSupported: () => true, resolveBackground: (b) => b, getAppliedBackground: () => 'acrylic',
      showMainWindowSmart() {}, isWindowShownOnScreen: () => true, applyContentSize() {}, getRequestedContentSize: () => null,
      WIDGET_WIDTH: 620, COMPACT_WIDTH: 290, INITIAL_HEIGHT: 400,
    },
    './history': { createHistory: () => ({ get: () => ({ samples: [], series: [] }), append() {}, pruneAll: () => 0, forgetProvider: (id) => { h.historyForgotten.push(id); } }) },
    './alerts': { createAlertEngine: () => ({ evaluate() {}, reset() {}, forget: (id) => { h.alertsForgotten.push(id); } }) },
    './tray': {
      createTray: () => ({
        update() {}, destroy() {}, hasIcon: () => true,
        rebuild: () => { h.trayRebuilds += 1; if (trayThrows) throw new Error('tray gone'); },
      }),
    },
    './sync': {
      createPhoneSync: () => ({
        onStatus() {}, onSnapshot() {}, load() {}, settingsChanged() {}, getStatus: () => ({}), getPairing: () => ({}),
        repair: () => ({}), unpair: async () => {}, test: async () => ({}), pushNow: async () => ({}),
      }),
    },
    './scheduler': {
      createScheduler: (opts) => {
        h.schedulerOpts = opts;
        return {
          start() {}, stop() {}, applyInterval() {}, getLastSnapshot: () => null, isRefreshing: () => h.inFlight !== null,
          refreshNow: () => { h.refreshes += 1; return h.inFlight || Promise.resolve(null); },
          forgetProvider: (id) => { h.forgotten.push(id); },
        };
      },
    },
    './accounts': accountsLib,
    './providers/claude.js': { createClaudeCodeProvider: codeInstance },
    './providers/claude-web.js': { createClaudeWebProvider: webInstance },
    './providers/codex.js': { fetchSnapshot: async () => okSnapshot('codex', 'Codex', { source: 'codex_auth_file' }) },
  };

  // Helpers on the booted app.
  h.invoke = (channel, arg) => h.handlers[channel]({ sender: h.win.webContents }, arg);
  h.save = (patch) => h.invoke('save-settings', { patch });
  h.saveAccounts = (list) => h.save({ claudeAccounts: list });
  h.saveDirect = saveSettings; // a writer that skips main.js's side effects
  h.providers = () => h.schedulerOpts.providers();
  h.wrapper = (id) => h.providers().find((p) => p.id === id);
  h.instancesOf = (id) => h.created.filter((inst) => inst.opts.id === id);
  h.events = (channel) => h.sent.filter((s) => s.channel === channel).map((s) => s.payload);
  h.restore = () => {};

  current = h;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const listenersBefore = { ue: process.listeners('uncaughtException'), ur: process.listeners('unhandledRejection') };
  // linux keeps main.js off the win32 z-order interval and the macOS Dock calls.
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  for (const name of Object.keys(realConsole)) console[name] = (...args) => h.logs.push(args.map(String).join(' '));
  h.restore = () => {
    Object.assign(console, realConsole);
    if (current === h) current = null;
  };
  try {
    delete require.cache[MAIN];
    require(MAIN);
    if (ready) await h.becomeReady();
  } finally {
    Object.defineProperty(process, 'platform', platform);
    for (const l of process.listeners('uncaughtException')) if (!listenersBefore.ue.includes(l)) process.removeListener('uncaughtException', l);
    for (const l of process.listeners('unhandledRejection')) if (!listenersBefore.ur.includes(l)) process.removeListener('unhandledRejection', l);
  }
  return h;
}

// Every test boots its own app; the hook and console are released even when an assertion fails.
function bootFor(t, options) {
  return boot(options).then((h) => { t.after(() => h.restore()); return h; });
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

test('registry: one provider per account in slot order, then Codex; each instance gets its own source and folder', async (t) => {
  const h = await bootFor(t, {
    accounts: [
      acct('claude'),
      acct('claude-2', 'claude_web'),
      acct('claude-3', 'claude_keychain', { configDir: '~/.claude-3' }),
      acct('claude-4', 'claude_code', { configDir: '~/.claude-4' }),
    ],
  });
  assert.deepEqual(h.providers().map((p) => p.id), ['claude', 'claude-2', 'claude-3', 'claude-4', 'codex']);
  for (const p of h.providers()) await p.fetchSnapshot({ settings: h.getSettings() });

  const byId = (id) => h.instancesOf(id)[0];
  assert.equal(byId('claude').kind, 'code');
  assert.equal(byId('claude').opts.credentialStore, 'file');
  assert.equal(byId('claude').opts.configDir, '');
  assert.equal(byId('claude-2').kind, 'web');
  assert.equal(typeof byId('claude-2').opts.getOrganizationId, 'function');
  assert.equal(byId('claude-3').kind, 'code');
  assert.equal(byId('claude-3').opts.credentialStore, 'keychain');
  assert.equal(byId('claude-3').opts.configDir, '~/.claude-3');
  assert.equal(byId('claude-4').opts.credentialStore, 'file');
  assert.equal(byId('claude-4').opts.configDir, '~/.claude-4');
  // The factories get a name FUNCTION, so a relabelled account's own messages (the Keychain "open <name> in Claude
  // Code" hint, the claude.ai login window title) follow the rename without re-creating the instance.
  assert.deepEqual(['claude', 'claude-2', 'claude-3', 'claude-4'].map((id) => typeof byId(id).opts.name), ['function', 'function', 'function', 'function']);
  assert.deepEqual(['claude', 'claude-2', 'claude-3', 'claude-4'].map((id) => byId(id).opts.name()), ['Claude 1', 'Claude 2', 'Claude 3', 'Claude 4']);
  assert.equal(h.created.length, 4, 'one instance per account, not one per fetch');
  assert.equal(h.wrapper('claude-3').source, 'claude_keychain');
});

test('registry: the wrapper stamps its id and current display name on whatever the instance returns', async (t) => {
  const h = await bootFor(t, { accounts: [acct('claude'), acct('claude-2', 'claude_code', { label: 'Work' })] });
  const second = h.wrapper('claude-2');
  await second.fetchSnapshot({});
  const inst = h.instancesOf('claude-2')[0];

  // An instance answers with its own (stale) id and name, as a cached floor result would.
  const cached = { ...okSnapshot('claude', 'Claude'), status: 'error', error: { code: 'network', message: 'down' } };
  inst.next = cached;
  const failed = await second.fetchSnapshot({});
  assert.equal(failed.id, 'claude-2');
  assert.equal(failed.name, 'Work');
  assert.equal(failed.status, 'error', 'a failure is stamped too');
  assert.equal(cached.id, 'claude', 'the instance\'s object is copied, never mutated');

  inst.next = okSnapshot('claude', 'Claude');
  assert.equal((await h.wrapper('claude').fetchSnapshot({})).name, 'Claude 1');

  // A single account is plain "Claude" (the 1.0.x look).
  const solo = await bootFor(t, { accounts: [acct('claude')] });
  const snap = await solo.wrapper('claude').fetchSnapshot({});
  assert.equal(snap.id, 'claude');
  assert.equal(snap.name, 'Claude');
});

test('registry: a label change keeps the instance, its last-good values and its claude.ai session', async (t) => {
  const h = await bootFor(t, {
    accounts: [acct('claude'), acct('claude-2', 'claude_web')],
    config: { claudeWebSessions: { 'claude-2': enc('sk-two') } },
  });
  const before = h.instancesOf('claude-2');
  assert.equal(before.length, 1, 'restored at startup');
  h.forgotten.length = 0;

  h.saveAccounts([acct('claude'), acct('claude-2', 'claude_web', { label: 'Side project' })]);

  assert.equal(h.instancesOf('claude-2').length, 1, 'no new instance');
  assert.deepEqual(h.forgotten, [], 'last-good values kept');
  assert.equal(before[0].logouts, 0);
  assert.equal(before[0].sessions.length, 1, 'the session is not re-applied');
  assert.equal(dec(h.config.claudeWebSessions['claude-2']), 'sk-two', 'stored session kept');
  assert.equal((await h.wrapper('claude-2').fetchSnapshot({})).name, 'Side project', 'the new label shows at once');
  assert.equal(before[0].opts.name(), 'Side project', "the instance's own messages (login window title) follow the rename");
  assert.ok(h.refreshes > 0, 'a claudeAccounts change refreshes');
});

test('registry: a source or folder change re-creates only that account and forgets its last-good values', async (t) => {
  const h = await bootFor(t, {
    accounts: [acct('claude'), acct('claude-2', 'claude_code', { configDir: '~/.claude-2' })],
    config: { claudeWebSession: enc('sk-one') },
  });
  for (const p of h.providers()) await p.fetchSnapshot({});
  const firstOne = h.instancesOf('claude')[0];
  h.forgotten.length = 0;

  // Folder change on account 2.
  h.saveAccounts([acct('claude'), acct('claude-2', 'claude_code', { configDir: '~/.claude-other' })]);
  await h.wrapper('claude-2').fetchSnapshot({});
  assert.deepEqual(h.forgotten, ['claude-2']);
  assert.equal(h.instancesOf('claude-2').length, 2);
  assert.equal(h.instancesOf('claude-2')[1].opts.configDir, '~/.claude-other');
  assert.equal(h.wrapper('claude').getInstance(), firstOne, 'account 1 untouched');

  // Account 1 switches to claude.ai: a web instance with ITS stored session.
  h.forgotten.length = 0;
  h.saveAccounts([acct('claude', 'claude_web'), acct('claude-2', 'claude_code', { configDir: '~/.claude-other' })]);
  await h.wrapper('claude').fetchSnapshot({});
  assert.deepEqual(h.forgotten, ['claude']);
  const web = h.instancesOf('claude').find((inst) => inst.kind === 'web');
  assert.ok(web);
  assert.deepEqual(web.sessions, [{ sessionKey: 'sk-one', organizationId: null }]);

  // Source change keychain ↔ file store re-creates as well.
  h.forgotten.length = 0;
  h.saveAccounts([acct('claude', 'claude_web'), acct('claude-2', 'claude_keychain', { configDir: '~/.claude-other' })]);
  await h.wrapper('claude-2').fetchSnapshot({});
  assert.deepEqual(h.forgotten, ['claude-2']);
  assert.equal(h.instancesOf('claude-2').at(-1).opts.credentialStore, 'keychain');
});

test('registry: removing an account signs its partition out, deletes only its stored session and forgets it', async (t) => {
  const h = await bootFor(t, {
    accounts: [
      acct('claude', 'claude_web'),
      acct('claude-2', 'claude_web'),
      acct('claude-3'),            // a claude.ai session left over from an earlier switch
      acct('claude-4'),            // never signed in to claude.ai
    ],
    config: { claudeWebSession: enc('sk-one'), claudeWebSessions: { 'claude-2': enc('sk-two'), 'claude-3': enc('sk-three') } },
  });
  const second = h.instancesOf('claude-2')[0];
  h.forgotten.length = 0;

  h.saveAccounts([acct('claude', 'claude_web')]);
  await flush();

  assert.equal(second.wipes, 1, 'the removed claude.ai account has its whole partition wiped (SSO cookies too)');
  assert.equal(second.logouts, 0);
  const throwaway = h.created.filter((inst) => inst.kind === 'web' && inst.opts.id === 'claude-3');
  assert.equal(throwaway.length, 1, 'a leftover session is signed out on its own partition');
  assert.equal(throwaway[0].wipes, 1);
  assert.deepEqual(h.historyForgotten.sort(), ['claude-2', 'claude-3', 'claude-4'], "removed accounts' history series go");
  assert.deepEqual(h.alertsForgotten.sort(), ['claude-2', 'claude-3', 'claude-4'], "removed accounts' alert latches go");
  assert.equal(h.created.filter((inst) => inst.kind === 'web' && inst.opts.id === 'claude-4').length, 0, 'no partition touched for an account that never signed in');
  assert.equal(h.config.claudeWebSessions, undefined, 'the map goes once it is empty');
  assert.equal(dec(h.config.claudeWebSession), 'sk-one', 'account 1 keeps its session');
  assert.equal(h.instancesOf('claude')[0].logouts, 0);
  assert.deepEqual(h.forgotten.sort(), ['claude-2', 'claude-3', 'claude-4']);
  assert.deepEqual(h.providers().map((p) => p.id), ['claude', 'codex']);
});

test('registry: removing one of several accounts keeps the other stored sessions', async (t) => {
  const h = await bootFor(t, {
    accounts: [acct('claude'), acct('claude-2', 'claude_web'), acct('claude-3', 'claude_web')],
    config: { claudeWebSessions: { 'claude-2': enc('sk-two'), 'claude-3': enc('sk-three') } },
  });
  h.saveAccounts([acct('claude'), acct('claude-3', 'claude_web')]);
  await flush();
  assert.deepEqual(Object.keys(h.config.claudeWebSessions), ['claude-3']);
  assert.equal(h.instancesOf('claude-3')[0].logouts, 0);
});

// ---------------------------------------------------------------------------------------------
// Sessions at startup
// ---------------------------------------------------------------------------------------------

test('startup: each claude_web account gets its own stored session and organization, only once the app is ready', async (t) => {
  const h = await bootFor(t, {
    ready: false,
    accounts: [
      acct('claude', 'claude_web', { organizationId: 'org-one' }),
      acct('claude-2'),
      acct('claude-3', 'claude_web', { organizationId: 'org-three' }),
    ],
    config: {
      claudeWebSession: enc('sk-one'),
      claudeWebSessions: { 'claude-2': enc('sk-two-old'), 'claude-3': enc('sk-three'), 'claude-5': enc('sk-orphan') },
    },
  });
  // Before ready (no safeStorage yet) an instance may exist, but it has no session yet.
  await h.wrapper('claude-3').fetchSnapshot({});
  assert.deepEqual(h.instancesOf('claude-3')[0].sessions, []);

  await h.becomeReady();
  assert.deepEqual(h.instancesOf('claude')[0].sessions, [{ sessionKey: 'sk-one', organizationId: 'org-one' }]);
  assert.deepEqual(h.instancesOf('claude-3')[0].sessions, [{ sessionKey: 'sk-three', organizationId: 'org-three' }]);
  assert.equal(h.instancesOf('claude-2').filter((inst) => inst.kind === 'web').length, 0, 'a claude_code account gets no claude.ai instance');
  assert.equal(h.config.claudeWebSessions['claude-2'], enc('sk-two-old'), 'a configured account keeps its session across a source switch');
  assert.equal(h.config.claudeWebSessions['claude-5'], undefined, 'a session whose account is gone is dropped');

  // Later fetches never re-apply it (setSession resets the request floor).
  await h.wrapper('claude-3').fetchSnapshot({});
  assert.equal(h.instancesOf('claude-3')[0].sessions.length, 1);
  assert.ok(!h.logs.some((line) => line.includes('sk-')), 'no session key in the log');
});

// ---------------------------------------------------------------------------------------------
// claude.ai IPC
// ---------------------------------------------------------------------------------------------

test('login: account N persists its session under its own key and writes only its own organization', async (t) => {
  const h = await bootFor(t, {
    accounts: [acct('claude', 'claude_web', { organizationId: 'org-one' }), acct('claude-2', 'claude_web')],
    config: { claudeWebSession: enc('sk-one') },
  });
  h.forgotten.length = 0;
  h.refreshes = 0;

  const result = await h.invoke('claude-web-login', { accountId: 'claude-2' });

  assert.equal(result.success, true);
  assert.equal(h.instancesOf('claude-2')[0].logins, 1);
  assert.equal(h.instancesOf('claude')[0].logins, 0);
  assert.equal(dec(h.config.claudeWebSessions['claude-2']), 'sk-fake-claude-2');
  assert.equal(dec(h.config.claudeWebSession), 'sk-one', 'account 1\'s session untouched');
  const saved = h.getSettings();
  assert.equal(saved.claudeAccounts[1].organizationId, 'org-claude-2');
  assert.equal(saved.claudeAccounts[0].organizationId, 'org-one');
  assert.ok(h.saves.every((patch) => !('claudeOrganizationId' in patch)), 'never through the account-1 legacy key');
  // The instances' org fallback reads each account's own entry, live.
  assert.equal(h.instancesOf('claude-2')[0].opts.getOrganizationId(), 'org-claude-2');
  assert.equal(h.instancesOf('claude')[0].opts.getOrganizationId(), 'org-one');
  assert.deepEqual(h.forgotten, ['claude-2']);
  assert.equal(h.refreshes, 1);
  assert.equal(h.events('settings-updated').at(-1).claudeAccounts[1].organizationId, 'org-claude-2');
  assert.ok(!h.logs.some((line) => line.includes('sk-fake')), 'no session key in the log');
});

test('login: no accountId means account 1 (1.0.x callers)', async (t) => {
  const h = await bootFor(t, { accounts: [acct('claude', 'claude_web'), acct('claude-2', 'claude_web')] });
  assert.equal((await h.invoke('claude-web-login')).success, true);
  assert.equal(h.instancesOf('claude')[0].logins, 1);
  assert.equal(h.instancesOf('claude-2')[0].logins, 0);
  assert.equal(dec(h.config.claudeWebSession), 'sk-fake-claude');
  assert.equal(h.config.claudeWebSessions, undefined);
  assert.equal(h.getSettings().claudeAccounts[0].organizationId, 'org-claude');
  assert.equal(h.getSettings().claudeAccounts[1].organizationId, null);
});

test('IPC: an account the registry has not caught up with is refused, never mapped onto account 1', async (t) => {
  const h = await bootFor(t, { accounts: [acct('claude', 'claude_web')] });
  h.saveDirect({ claudeAccounts: [acct('claude', 'claude_web'), acct('claude-2', 'claude_web')] });
  assert.equal((await h.invoke('claude-web-login', { accountId: 'claude-2' })).success, false);
  assert.equal(await h.invoke('claude-web-logout', { accountId: 'claude-2' }), false);
  assert.equal(await h.invoke('claude-web-select-org', { id: 'org-x', accountId: 'claude-2' }), false);
  const one = h.instancesOf('claude')[0];
  assert.equal(one.logins + one.logouts + one.selected.length, 0);
  assert.equal(h.config.claudeWebSession, undefined);
});

test('IPC: an unknown, malformed or non-claude.ai account is refused and nothing is touched', async (t) => {
  const h = await bootFor(t, {
    accounts: [acct('claude', 'claude_web', { organizationId: 'org-one' }), acct('claude-2')],
    config: { claudeWebSession: enc('sk-one') },
  });
  const one = h.instancesOf('claude')[0];
  const savesBefore = h.saves.length;
  for (const accountId of ['claude-5', 'codex', '', null, 2, { id: 'claude' }]) {
    const login = await h.invoke('claude-web-login', { accountId });
    assert.equal(login.success, false, `login ${JSON.stringify(accountId)}`);
    assert.equal(typeof login.error, 'string');
    assert.equal(await h.invoke('claude-web-logout', { accountId }), false, `logout ${JSON.stringify(accountId)}`);
    assert.deepEqual(await h.invoke('claude-web-orgs', { accountId }), [], `orgs ${JSON.stringify(accountId)}`);
    assert.equal(await h.invoke('claude-web-select-org', { id: 'org-x', accountId }), false, `select ${JSON.stringify(accountId)}`);
  }
  // claude-2 is configured but reads a Claude Code folder: no claude.ai sign-in for it.
  assert.equal((await h.invoke('claude-web-login', { accountId: 'claude-2' })).success, false);
  assert.deepEqual(await h.invoke('claude-web-orgs', { accountId: 'claude-2' }), []);
  assert.equal(await h.invoke('claude-web-select-org', { id: 'org-x', accountId: 'claude-2' }), false);

  assert.equal(one.logins + one.logouts + one.selected.length, 0, 'account 1 never acted on');
  assert.equal(h.created.length, 1, 'a refused call makes no instance (only account 1\'s, restored at startup)');
  assert.equal(h.saves.length, savesBefore);
  assert.equal(dec(h.config.claudeWebSession), 'sk-one');
  assert.equal(h.getSettings().claudeAccounts[0].organizationId, 'org-one');
});

test('logout: account N loses only its own session and organization', async (t) => {
  const h = await bootFor(t, {
    accounts: [acct('claude', 'claude_web', { organizationId: 'org-one' }), acct('claude-2', 'claude_web', { organizationId: 'org-two' })],
    config: { claudeWebSession: enc('sk-one'), claudeWebSessions: { 'claude-2': enc('sk-two') } },
  });
  h.forgotten.length = 0;
  h.refreshes = 0;

  assert.equal(await h.invoke('claude-web-logout', { accountId: 'claude-2' }), true);

  assert.equal(h.instancesOf('claude-2')[0].logouts, 1);
  assert.equal(h.instancesOf('claude')[0].logouts, 0);
  assert.equal(h.config.claudeWebSessions, undefined);
  assert.equal(dec(h.config.claudeWebSession), 'sk-one');
  const saved = h.getSettings();
  assert.equal(saved.claudeAccounts[1].organizationId, null);
  assert.equal(saved.claudeAccounts[0].organizationId, 'org-one');
  assert.ok(h.forgotten.includes('claude-2') && !h.forgotten.includes('claude'));
  assert.ok(h.refreshes >= 1);
  assert.equal(h.instancesOf('claude-2').length, 1, 'the account keeps its instance (same login slot, signed out)');
});

test('logout: without an organization to clear it still refreshes, and no accountId means account 1', async (t) => {
  const h = await bootFor(t, {
    accounts: [acct('claude', 'claude_web'), acct('claude-2', 'claude_web')],
    config: { claudeWebSession: enc('sk-one'), claudeWebSessions: { 'claude-2': enc('sk-two') } },
  });
  h.refreshes = 0;
  const savesBefore = h.saves.length;
  assert.equal(await h.invoke('claude-web-logout'), true);
  assert.equal(h.config.claudeWebSession, undefined);
  assert.equal(dec(h.config.claudeWebSessions['claude-2']), 'sk-two');
  assert.equal(h.saves.length, savesBefore, 'nothing to save');
  assert.equal(h.refreshes, 1);
});

test('orgs + select-org: per account; the organization lands on that account through the settings path', async (t) => {
  const h = await bootFor(t, {
    accounts: [acct('claude', 'claude_web', { organizationId: 'org-one' }), acct('claude-2', 'claude_web')],
  });
  assert.deepEqual(await h.invoke('claude-web-orgs', { accountId: 'claude-2' }), [
    { id: 'org-a', name: 'Org A', isTeam: false }, { id: 'org-b', name: '', isTeam: true },
  ]);
  h.refreshes = 0;
  assert.equal(await h.invoke('claude-web-select-org', { id: 'org-b', accountId: 'claude-2' }), true);
  assert.deepEqual(h.instancesOf('claude-2')[0].selected, ['org-b']);
  assert.deepEqual(h.instancesOf('claude')[0].selected, []);
  assert.equal(h.getSettings().claudeAccounts[1].organizationId, 'org-b');
  assert.equal(h.getSettings().claudeAccounts[0].organizationId, 'org-one');
  assert.equal(h.refreshes, 1, 'side effects ran');
  assert.equal(h.events('settings-updated').at(-1).claudeAccounts[1].organizationId, 'org-b');

  // The 1.0.x shape ({ id } only, or a bare id) is account 1.
  assert.equal(await h.invoke('claude-web-select-org', { id: 'org-a' }), true);
  assert.equal(await h.invoke('claude-web-select-org', 'org-a'), true);
  assert.deepEqual(h.instancesOf('claude')[0].selected, ['org-a', 'org-a']);
  assert.equal(h.getSettings().claudeAccounts[0].organizationId, 'org-a');
  assert.equal(h.getSettings().claudeAccounts[1].organizationId, 'org-b');
});

test('login: a sign-in that finishes after its account was removed persists nothing and is signed out', async (t) => {
  const h = await bootFor(t, { accounts: [acct('claude'), acct('claude-2', 'claude_web')] });
  let release;
  h.loginGate = new Promise((resolve) => { release = resolve; });
  const pending = h.invoke('claude-web-login', { accountId: 'claude-2' });
  await flush();
  const inst = h.instancesOf('claude-2')[0];
  assert.equal(inst.logins, 1);

  h.saveAccounts([acct('claude')]);
  await flush();
  assert.equal(inst.wipes, 1, 'removal wipes its partition');
  release();
  const result = await pending;
  await flush();

  assert.equal(result.success, false);
  assert.equal(h.config.claudeWebSessions, undefined, 'no session stored for a removed account');
  assert.equal(h.config.claudeWebSession, undefined, 'and none under account 1 either');
  assert.ok(h.saves.every((patch) => !patch.claudeAccounts || patch.claudeAccounts.every((a) => a.id !== 'claude-2')), 'the account is not written back');
  assert.equal(inst.wipes, 2, 'the cookie the late login left behind is wiped with the rest of the partition');
});

test('login: a sign-in that finishes after its account switched source persists nothing', async (t) => {
  const h = await bootFor(t, { accounts: [acct('claude'), acct('claude-2', 'claude_web')] });
  let release;
  h.loginGate = new Promise((resolve) => { release = resolve; });
  const pending = h.invoke('claude-web-login', { accountId: 'claude-2' });
  await flush();
  h.saveAccounts([acct('claude'), acct('claude-2')]);
  release();
  assert.equal((await pending).success, false);
  assert.equal(h.config.claudeWebSessions, undefined);
  assert.equal(h.getSettings().claudeAccounts[1].organizationId, null);
});

// ---------------------------------------------------------------------------------------------
// Session expiry
// ---------------------------------------------------------------------------------------------

test('session-expired: fires once per claude.ai account on the ok → auth_required transition, naming it', async (t) => {
  const h = await bootFor(t, { accounts: [acct('claude', 'claude_web'), acct('claude-2', 'claude_web'), acct('claude-3')] });
  const snap = (statuses, duplicates) => ({
    fetchedAt: 1,
    providers: Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, status === null ? null : { ...okSnapshot(id, id), status }])),
    ...(duplicates ? { duplicates } : {}),
  });
  const onSnapshot = h.schedulerOpts.onSnapshot;

  onSnapshot(snap({ claude: 'auth_required', 'claude-2': 'ok', 'claude-3': 'ok' }));
  assert.deepEqual(h.events('claude-web-session-expired'), [], 'a session already dead at the first snapshot is not an expiry');

  onSnapshot(snap({ claude: 'auth_required', 'claude-2': 'auth_required', 'claude-3': 'auth_required' }));
  assert.deepEqual(h.events('claude-web-session-expired'), [{ accountId: 'claude-2' }], 'only the claude.ai account that just expired');

  onSnapshot(snap({ claude: 'auth_required', 'claude-2': 'auth_required', 'claude-3': 'auth_required' }));
  assert.equal(h.events('claude-web-session-expired').length, 1, 'latched');

  onSnapshot(snap({ claude: 'ok', 'claude-2': 'stale', 'claude-3': 'ok' }));
  onSnapshot(snap({ claude: 'auth_required', 'claude-2': 'stale', 'claude-3': 'ok' }));
  assert.deepEqual(h.events('claude-web-session-expired'), [{ accountId: 'claude-2' }, { accountId: 'claude' }]);
});

test('session-expired: an account hidden as a duplicate still arms the latch; a disabled one does not', async (t) => {
  const h = await bootFor(t, { accounts: [acct('claude', 'claude_web'), acct('claude-2', 'claude_web')] });
  const onSnapshot = h.schedulerOpts.onSnapshot;
  const entry = (id, status) => ({ ...okSnapshot(id, id), status });

  onSnapshot({ fetchedAt: 1, providers: { claude: entry('claude', 'ok'), 'claude-2': null }, duplicates: { 'claude-2': 'claude' } });
  onSnapshot({ fetchedAt: 2, providers: { claude: entry('claude', 'ok'), 'claude-2': entry('claude-2', 'auth_required') }, duplicates: {} });
  assert.deepEqual(h.events('claude-web-session-expired'), [{ accountId: 'claude-2' }]);

  const h2 = await bootFor(t, { accounts: [acct('claude', 'claude_web'), acct('claude-2', 'claude_web')] });
  h2.schedulerOpts.onSnapshot({ fetchedAt: 1, providers: { claude: entry('claude', 'ok'), 'claude-2': null }, duplicates: {} });
  h2.schedulerOpts.onSnapshot({ fetchedAt: 2, providers: { claude: entry('claude', 'ok'), 'claude-2': entry('claude-2', 'auth_required') }, duplicates: {} });
  assert.deepEqual(h2.events('claude-web-session-expired'), [], 'turned off, then signed out: nothing expired while it was shown');
});

test('session-expired: a source switch re-arms that account\'s latch', async (t) => {
  const h = await bootFor(t, { accounts: [acct('claude'), acct('claude-2')] });
  const entry = (id, status) => ({ ...okSnapshot(id, id), status });
  h.schedulerOpts.onSnapshot({ fetchedAt: 1, providers: { claude: entry('claude', 'ok'), 'claude-2': entry('claude-2', 'ok') } });
  h.saveAccounts([acct('claude'), acct('claude-2', 'claude_web')]);
  // The first claude.ai snapshot says "sign in": that is the new source's starting state, not an expiry.
  h.schedulerOpts.onSnapshot({ fetchedAt: 2, providers: { claude: entry('claude', 'ok'), 'claude-2': entry('claude-2', 'auth_required') } });
  assert.deepEqual(h.events('claude-web-session-expired'), []);
});

// ---------------------------------------------------------------------------------------------
// Resilience
// ---------------------------------------------------------------------------------------------

test('resilience: a missing provider module gives its accounts an error snapshot and is picked up once it appears', async (t) => {
  const h = await bootFor(t, { accounts: [acct('claude'), acct('claude-2', 'claude_web')], missing: ['./providers/claude.js'] });
  const snap = await h.wrapper('claude').fetchSnapshot({});
  assert.equal(snap.id, 'claude');
  assert.equal(snap.name, 'Claude 1');
  assert.equal(snap.status, 'error');
  assert.equal(snap.error.code, 'internal');
  assert.match(snap.error.message, /claude\.js/);
  assert.equal((await h.wrapper('claude-2').fetchSnapshot({})).status, 'ok', 'the other module still works');
  assert.equal((await h.wrapper('codex').fetchSnapshot({})).status, 'ok');

  h.missing.clear();
  const later = await h.wrapper('claude').fetchSnapshot({});
  assert.equal(later.status, 'ok');
  assert.equal(later.name, 'Claude 1');
  assert.equal(h.instancesOf('claude').length, 1);
});

test('resilience: a factory that throws is an error snapshot for that account, retried next time', async (t) => {
  const h = await bootFor(t, { accounts: [acct('claude'), acct('claude-2')] });
  h.codeFactoryThrows = true;
  const snap = await h.wrapper('claude-2').fetchSnapshot({});
  assert.equal(snap.status, 'error');
  assert.equal(snap.id, 'claude-2');
  assert.equal(snap.name, 'Claude 2');
  assert.match(snap.error.message, /bad config folder/);
  h.codeFactoryThrows = false;
  assert.equal((await h.wrapper('claude-2').fetchSnapshot({})).status, 'ok');
});

test('dedupe: the scheduler gets accounts.dedupeSnapshot', async (t) => {
  const h = await bootFor(t, { accounts: [acct('claude'), acct('claude-2')] });
  const out = h.schedulerOpts.dedupe({ claude: null, 'claude-2': null, codex: null });
  assert.equal(out.providers.dedupedBy, 'accounts.js');
  assert.deepEqual(out.duplicates, { 'claude-2': 'claude' });
});

test('dedupe: without accounts.js the scheduler gets a pass-through and names still follow the rules', async (t) => {
  const h = await bootFor(t, { accounts: [acct('claude'), acct('claude-2', 'claude_code', { label: 'Work' })], missing: ['./accounts'] });
  const input = { claude: null, 'claude-2': null, codex: null };
  assert.deepEqual(h.schedulerOpts.dedupe(input), { providers: input, duplicates: {} });
  assert.equal((await h.wrapper('claude').fetchSnapshot({})).name, 'Claude 1');
  assert.equal((await h.wrapper('claude-2').fetchSnapshot({})).name, 'Work');
  assert.deepEqual(h.providers().map((p) => p.id), ['claude', 'claude-2', 'codex']);
});

test('names: an accounts.js whose accountDisplayName throws falls back to the default name, never a lost snapshot', async (t) => {
  const lib = { ...fakeAccountsLib(), accountDisplayName: () => { throw new Error('boom'); } };
  const h = await bootFor(t, { accounts: [acct('claude'), acct('claude-2', 'claude_code', { label: 'Work' })], accountsLib: lib });
  const first = await h.wrapper('claude').fetchSnapshot({});
  assert.equal(first.name, 'Claude 1');
  assert.equal(first.status, 'ok');
  assert.equal(h.wrapper('claude-2').name, 'Work');
});

test('side effects: the registry follows the stored list even when a later step (the tray) throws', async (t) => {
  const h = await bootFor(t, { accounts: [acct('claude')], trayThrows: true });
  const next = await h.saveAccounts([acct('claude'), acct('claude-2')]);  // renames account 1 → tray.rebuild throws
  assert.deepEqual(next.claudeAccounts.map((a) => a.id), ['claude', 'claude-2']);
  assert.equal(h.trayRebuilds, 1);
  assert.deepEqual(h.providers().map((p) => p.id), ['claude', 'claude-2', 'codex']);
  assert.deepEqual(h.events('settings-updated').at(-1).claudeAccounts.map((a) => a.id), ['claude', 'claude-2']);
});

test('side effects: a failing store or logout never escapes save-settings', async (t) => {
  const h = await bootFor(t, {
    accounts: [acct('claude'), acct('claude-2', 'claude_web')],
    config: { claudeWebSessions: { 'claude-2': enc('sk-two') } },
    storeFaults: true,
  });
  h.instancesOf('claude-2')[0].logoutFails = true;
  const next = await h.saveAccounts([acct('claude')]);
  await flush();
  assert.deepEqual(next.claudeAccounts.map((a) => a.id), ['claude']);
  assert.deepEqual(h.events('settings-updated').at(-1).claudeAccounts.map((a) => a.id), ['claude']);
  assert.deepEqual(h.providers().map((p) => p.id), ['claude', 'codex'], 'the registry still followed the list');
  assert.ok(h.logs.some((line) => /ERROR/.test(line)), 'the failures are logged');
});

test('tray: rebuilt when account 1\'s display name changes, not for another account\'s label', async (t) => {
  const h = await bootFor(t, { accounts: [acct('claude')] });
  h.trayRebuilds = 0;
  h.saveAccounts([acct('claude'), acct('claude-2')]);                       // 'Claude' → 'Claude 1'
  assert.equal(h.trayRebuilds, 1);
  h.saveAccounts([acct('claude'), acct('claude-2', 'claude_code', { label: 'Side' })]);
  assert.equal(h.trayRebuilds, 1, 'account 2 renamed: account 1 still "Claude 1"');
  h.saveAccounts([acct('claude', 'claude_code', { label: 'Main' }), acct('claude-2', 'claude_code', { label: 'Side' })]);
  assert.equal(h.trayRebuilds, 2);
});

// ---------------------------------------------------------------------------------------------
// preload
// ---------------------------------------------------------------------------------------------

test('preload: the claude.ai methods carry an optional accountId; the 1-arg forms are unchanged', () => {
  const invokes = [];
  let api = null;
  current = {
    missing: new Set(),
    modules: {
      electron: {
        contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'api') api = value; } },
        ipcRenderer: { invoke: (channel, arg) => { invokes.push({ channel, arg }); return Promise.resolve(); }, send() {}, on() {}, removeListener() {} },
      },
    },
  };
  try {
    delete require.cache[PRELOAD];
    require(PRELOAD);
  } finally {
    current = null;
  }
  api.claudeWebLogin('claude-2');
  api.claudeWebLogout('claude-3');
  api.claudeWebOrgs('claude-4');
  api.claudeWebSelectOrg('org-x', 'claude-5');
  api.claudeWebLogin();
  api.claudeWebSelectOrg('org-y');
  api.saveSettings({ claudeAccounts: [] });
  assert.deepEqual(invokes.map((i) => i.channel), [
    'claude-web-login', 'claude-web-logout', 'claude-web-orgs', 'claude-web-select-org', 'claude-web-login', 'claude-web-select-org', 'save-settings',
  ]);
  assert.deepEqual(invokes[0].arg, { accountId: 'claude-2' });
  assert.deepEqual(invokes[1].arg, { accountId: 'claude-3' });
  assert.deepEqual(invokes[2].arg, { accountId: 'claude-4' });
  assert.deepEqual(invokes[3].arg, { id: 'org-x', accountId: 'claude-5' });
  assert.equal(invokes[4].arg.accountId, undefined, 'left out → main picks account 1');
  assert.equal(invokes[5].arg.id, 'org-y');
  assert.equal(invokes[5].arg.accountId, undefined);
  assert.deepEqual(invokes[6].arg, { patch: { claudeAccounts: [] } });
});

test('registry: a fetch still in flight when its account switches login never reports the old login as this account; the new one is fetched at once', async (t) => {
  const h = await bootFor(t, { accounts: [acct('claude'), acct('claude-2', 'claude_keychain', { configDir: '' })] });
  const oldWrapper = h.wrapper('claude-2');
  oldWrapper.getInstance();
  const oldInstance = h.instancesOf('claude-2')[0];
  let release;
  oldInstance.gate = new Promise((r) => { release = r; });
  oldInstance.next = okSnapshot('claude', 'Claude', { source: 'claude_keychain', identity: { account: 'aaaa', org: 'bbbb', personalOrg: true } });
  const pending = oldWrapper.fetchSnapshot({}); // the tick in flight

  let endTick;
  h.inFlight = new Promise((r) => { endTick = r; });
  const before = h.refreshes;
  h.saveAccounts([acct('claude'), acct('claude-2', 'claude_keychain', { configDir: '~/.claude-1' })]);

  release();
  const late = await pending;
  assert.equal(late.status, 'error', "the old login's ok result is not this account's any more");
  assert.equal(late.identity, null, 'no identity: dedupe cannot hide the account behind the old login');
  assert.deepEqual(late.windows, []);
  assert.equal(late.id, 'claude-2');

  assert.equal(h.refreshes, before + 1, 'the refresh joined the tick in flight …');
  h.inFlight = null;
  endTick(null);
  await flush();
  assert.equal(h.refreshes, before + 2, '… and a fresh one runs once it settles, for the new folder');
});
