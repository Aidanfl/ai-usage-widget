'use strict';
// App entry (ARCHITECTURE.md §2/§4/§5/§8). Wires store → window → tray → scheduler → alerts, registers the
// IPC surface, and owns the lifecycle flags (single instance, before-quit, window recreate).

const path = require('path');
const os = require('os');
const { app, BrowserWindow, ipcMain, shell, Notification, powerMonitor, session, safeStorage } = require('electron');

// Must match package.json build.appId so dev (`npm start`) and packaged builds share one taskbar /
// toast identity on Windows.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.aidan.ai-usage-widget');
}

// Single instance: the second process hands off to the first ('second-instance' → show window) and quits
// before it touches the store or creates anything.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  bootstrap();
}

function createLogger(scope) {
  // `--debug` itself is not usable: Electron/Node reject it before main.js runs (DEP0062: "node --debug
  // ... invalid"), so the flag is `--debug-log`; DEBUG_LOG=1 works for packaged builds without a terminal.
  const DEBUG = process.env.DEBUG_LOG === '1' || process.argv.includes('--debug-log');
  const stamp = () => new Date().toISOString().slice(11, 19);
  const fn = (...args) => console.log(`${stamp()} [${scope}]`, ...args);
  fn.info = fn;
  fn.warn = (...args) => console.warn(`${stamp()} [${scope}] WARN`, ...args);
  fn.error = (...args) => console.error(`${stamp()} [${scope}] ERROR`, ...args);
  fn.debug = (...args) => { if (DEBUG) console.log(`${stamp()} [${scope}] debug`, ...args); };
  return fn;
}

function bootstrap() {
  const log = createLogger('main');
  const Store = require('electron-store');
  const { store, getSettings, saveSettings } = require('./store');
  const windowing = require('./window');
  const { createHistory } = require('./history');
  const { createAlertEngine } = require('./alerts');
  const { createScheduler } = require('./scheduler');
  const { createTray } = require('./tray');
  const { createPhoneSync } = require('./sync');

  const IS_PORTABLE = process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_FILE;
  const EXTERNAL_HOSTS = ['claude.ai', 'anthropic.com', 'chatgpt.com', 'openai.com', 'github.com'];
  const LOGO_PATH = path.join(__dirname, '..', '..', 'assets', 'logo.png');
  // Top-level key in config.json (next to `settings`) holding the safeStorage-encrypted claude.ai
  // sessionKey as base64. Kept out of `settings` so it never travels to the renderer.
  const WEB_SESSION_STORE_KEY = 'claudeWebSession';
  // Same pattern for the phone-sync pair key K (docs/PHONE-SYNC.md): base64 of
  // safeStorage.encryptString(base64(K)). Without safeStorage the key lives in memory for this run only.
  const PHONE_PAIR_KEY_STORE_KEY = 'phonePairKey';

  let mainWindow = null;
  let isQuitting = false;        // set on 'before-quit': lets the close handler tell quit from "hide to tray"
  let recreatingWindow = false;  // suppresses window-all-closed while a background change swaps windows
  let compactMode = false;
  let lastClaudeStatus = null;

  // ---------------------------------------------------------------------------------------------
  // Providers. Modules are written by another agent and may not exist yet, so each one is loaded
  // lazily: a missing/broken module yields an `error` ProviderSnapshot instead of crashing startup,
  // and the require is retried on the next tick so the file is picked up once it appears.
  // ---------------------------------------------------------------------------------------------
  function lazyProvider(relPath, id, name) {
    let loaded = null;
    let lastLoadError = null;
    let warned = false;
    const tryLoad = () => {
      if (loaded) return loaded;
      try {
        const mod = require(relPath);
        if (!mod || typeof mod.fetchSnapshot !== 'function') throw new Error(`${relPath} does not export fetchSnapshot()`);
        loaded = mod;
        lastLoadError = null;
        log.info(`provider ${id} loaded from ${relPath}`);
      } catch (err) {
        lastLoadError = err;
        if (!warned) {
          warned = true;
          log.warn(`provider ${id} unavailable (${relPath}): ${err && err.message}`);
        }
      }
      return loaded;
    };
    tryLoad();
    return {
      id,
      name,
      getModule: tryLoad,
      async fetchSnapshot(context) {
        const mod = tryLoad();
        if (mod) return mod.fetchSnapshot(context);
        return {
          id, name, status: 'error',
          error: { code: 'internal', message: `Provider module not available (${path.basename(relPath)}): ${lastLoadError ? lastLoadError.message : 'unknown'}` },
          source: null, plan: null, account: null, updatedAt: 0, windows: [], extra: null, credits: null, raw: {},
        };
      },
    };
  }

  const providers = {
    claude: lazyProvider('./providers/claude.js', 'claude', 'Claude'),
    claudeWeb: lazyProvider('./providers/claude-web.js', 'claude', 'Claude'),
    codex: lazyProvider('./providers/codex.js', 'codex', 'Codex'),
  };

  function resolveProviders() {
    const settings = getSettings();
    const claude = settings.claudeSource === 'claude_web' ? providers.claudeWeb : providers.claude;
    return [claude, providers.codex];
  }

  // ---------------------------------------------------------------------------------------------
  // Modules
  // ---------------------------------------------------------------------------------------------
  // History lives in its own file (usage-history.json) so the 10 000-sample array is not rewritten
  // on every settings change and config.json stays small and readable.
  // clearInvalidConfig: a corrupt/half-written history file must not make the app unlaunchable
  // (conf rethrows the SyntaxError from the constructor otherwise); history is disposable.
  const historyStore = new Store({ name: 'usage-history', clearInvalidConfig: true });
  const history = createHistory({
    get: () => historyStore.get('usageHistory', []),
    set: (samples) => historyStore.set('usageHistory', samples),
    now: Date.now,
  });

  const alerts = createAlertEngine({ notify: showNotification, now: Date.now });

  const tray = createTray({
    platform: process.platform,
    getSettings,
    onShow: () => showMainWindowSmart(),
    onRefresh: () => {
      broadcast('refresh-requested');
      scheduler.refreshNow();
    },
    onExit: () => app.quit(),
    onClick: () => toggleWindow(),
  });

  // Phone sync: pushes an encrypted copy of every snapshot to the relay per the push policy in
  // docs/PHONE-SYNC.md. Pure module — persistence of K, fetch and the clock are injected here.
  const phoneSync = createPhoneSync({
    getSettings,
    loadKey: readStoredPairKey,
    saveKey: persistPairKey,
    clearKey: () => persistPairKey(null),
    fetch: (...args) => globalThis.fetch(...args),
    now: Date.now,
    log: createLogger('phone-sync'),
    appVersion: app.getVersion(),
    platform: process.platform,
    hostname: safeHostname(),
  });
  phoneSync.onStatus((status) => broadcast('phone-sync-updated', status));

  const scheduler = createScheduler({
    providers: resolveProviders,
    getSettings,
    history,
    tray,
    alerts,
    log: createLogger('scheduler'),
    now: Date.now,
    onSnapshot: (snapshot) => {
      broadcast('usage-updated', snapshot);
      detectWebSessionExpiry(snapshot);
      // The 7-day history is read lazily (only when a push actually goes out) — it comes from disk.
      try {
        phoneSync.onSnapshot(snapshot, () => history.get(7, snapshot));
      } catch (err) {
        log.error('phone sync onSnapshot failed:', err && err.message);
      }
    },
  });

  // ---------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------
  function liveWindow() {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  }

  // "Hide from taskbar" is a taskbar button on Windows and the Dock icon on macOS (setSkipTaskbar is a
  // no-op there). Both only while a tray / menu-bar item exists to bring the window back.
  function applyHideFromTaskbar(win, hide) {
    const effective = !!hide && tray.hasIcon();
    if (process.platform === 'darwin') {
      if (!app.dock) return;
      try {
        if (effective) app.dock.hide();
        else if (!app.dock.isVisible()) app.dock.show();
      } catch (err) {
        log.error('dock toggle failed:', err && err.message);
      }
      return;
    }
    if (win && !win.isDestroyed()) win.setSkipTaskbar(effective);
  }

  function broadcast(channel, payload) {
    const win = liveWindow();
    if (!win || win.webContents.isDestroyed()) return;
    try {
      win.webContents.send(channel, payload);
    } catch (err) {
      log.error(`broadcast ${channel} failed:`, err && err.message);
    }
  }

  function showNotification(title, body) {
    try {
      if (!Notification.isSupported()) return;
      new Notification({ title, body, silent: false, icon: LOGO_PATH }).show();
    } catch (err) {
      log.error('notification failed:', err && err.message);
    }
  }

  function persistPosition(position) {
    try {
      saveSettings({ windowPosition: position });
    } catch (err) {
      log.error('failed to persist window position:', err && err.message);
    }
  }

  function currentWidth() {
    return compactMode ? windowing.COMPACT_WIDTH : windowing.WIDGET_WIDTH;
  }

  // The claude_web provider signals a dead session by flipping to auth_required; the renderer gets a
  // dedicated event so it can drop back to the "Log in" state without diffing snapshots.
  function detectWebSessionExpiry(snapshot) {
    const claude = snapshot && snapshot.providers ? snapshot.providers.claude : null;
    const status = claude ? claude.status : null;
    if (getSettings().claudeSource === 'claude_web' && status === 'auth_required' && lastClaudeStatus && lastClaudeStatus !== 'auth_required') {
      broadcast('claude-web-session-expired');
    }
    lastClaudeStatus = status;
  }

  // ---------------------------------------------------------------------------------------------
  // Window
  // ---------------------------------------------------------------------------------------------
  function createWindow() {
    const settings = getSettings();
    compactMode = !!settings.compactMode;
    const win = windowing.createMainWindow({
      settings,
      savedPosition: settings.windowPosition,
      log,
      onMove: persistPosition,
      onClose: (event) => {
        if (isQuitting || recreatingWindow) return;
        // Hide instead of closing only when a tray icon exists to bring the window back.
        if (tray.hasIcon()) {
          event.preventDefault();
          win.hide();
        }
      },
      onClosed: () => {
        if (mainWindow === win) mainWindow = null;
      },
    });
    // Only hide from the taskbar while a tray icon exists to bring the window back (see the
    // minimize-window handler, which drops the flag when the tray is gone).
    win.on('restore', () => {
      applyHideFromTaskbar(win, getSettings().hideFromTaskbar);
    });
    mainWindow = win;
    return win;
  }

  function showMainWindowSmart() {
    const win = liveWindow();
    if (!win) {
      createWindow(); // shows itself on ready-to-show
      return;
    }
    windowing.showMainWindowSmart(win, { onMove: persistPosition });
    applyHideFromTaskbar(win, getSettings().hideFromTaskbar);
  }

  function toggleWindow() {
    const win = liveWindow();
    if (win && windowing.isWindowShownOnScreen(win)) win.hide();
    else showMainWindowSmart();
  }

  // `transparent`/`backgroundMaterial` are creation-only — and so is the DWM immersive theme that gives
  // Smoky vs Clear Acrylic their base colour — so a background change swaps the window for a new one at
  // the same position. createMainWindow() sets nativeTheme.themeSource for the new backdrop before it
  // constructs the window; the old one is destroyed first so its theme never bleeds into the new one.
  // destroy() skips the 'close' event, and the flag keeps window-all-closed from quitting in between.
  // The new window's renderer reads the applied backdrop through get-app-info at boot.
  function recreateWindow() {
    const old = liveWindow();
    recreatingWindow = true;
    try {
      if (old) {
        const b = old.getBounds();
        persistPosition({ x: b.x, y: b.y });
        old.destroy();
      }
      createWindow();
    } finally {
      recreatingWindow = false;
    }
  }

  function resizeToHeight(height) {
    const win = liveWindow();
    const h = Math.round(Number(height));
    if (!win || !Number.isFinite(h) || h < 40 || h > 3000) return;
    windowing.applyContentSize(win, currentWidth(), h, log);
    log.debug(`resize-window ${h} → content ${win.getContentSize().join('x')}, bounds ${JSON.stringify(win.getBounds())}`);
  }

  // Main switches the width and keeps the current height; the renderer re-measures and reports the
  // new height through resize-window right after, which avoids a visible collapse/expand.
  function applyCompactWidth(compact) {
    compactMode = !!compact;
    const win = liveWindow();
    if (!win) return;
    // A minimized window reports its content size as 0x0 (Windows); fall back to the last height the
    // renderer asked for so the deferred resize does not collapse the window to nothing on restore.
    const requested = windowing.getRequestedContentSize(win);
    const [, measured] = win.getContentSize();
    const height = !win.isMinimized() && measured > 0 ? measured : (requested ? requested.height : windowing.INITIAL_HEIGHT);
    windowing.applyContentSize(win, currentWidth(), height, log);
  }

  function openExternal(url) {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch (err) {
      log.warn(`blocked openExternal with invalid URL: ${String(url).slice(0, 200)}`);
      return;
    }
    const allowed = parsed.protocol === 'https:'
      && EXTERNAL_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
    if (!allowed) {
      log.warn(`blocked openExternal to disallowed URL: ${parsed.protocol}//${parsed.hostname}`);
      return;
    }
    shell.openExternal(parsed.toString()).catch((err) => log.error('openExternal failed:', err && err.message));
  }

  // ---------------------------------------------------------------------------------------------
  // Settings side effects
  // ---------------------------------------------------------------------------------------------
  function applyLoginItem(enabled) {
    if (process.platform === 'linux') return;
    if (IS_PORTABLE) {
      log.info('portable build: autoStart is not registered (use shell:startup instead)');
      return;
    }
    if (!app.isPackaged) {
      // In dev app.getPath('exe') is electron.exe; registering it would launch a bare Electron at login.
      log.info('dev run: autoStart change not applied to the OS login items');
      return;
    }
    try {
      app.setLoginItemSettings({
        openAtLogin: !!enabled,
        ...(process.platform !== 'darwin' ? { path: app.getPath('exe') } : {}),
      });
    } catch (err) {
      log.error('setLoginItemSettings failed:', err && err.message);
    }
  }

  function applySettingsSideEffects(prev, next) {
    const changed = (key) => JSON.stringify(prev[key]) !== JSON.stringify(next[key]);
    const win = liveWindow();

    if (changed('autoStart')) applyLoginItem(next.autoStart);
    if (changed('hideFromTaskbar')) applyHideFromTaskbar(win, next.hideFromTaskbar);
    if (win && changed('alwaysOnTop') && process.platform === 'darwin' && typeof win.setVisibleOnAllWorkspaces === 'function') {
      try { win.setVisibleOnAllWorkspaces(!!next.alwaysOnTop, { visibleOnFullScreen: true, skipTransformProcessType: true }); } catch (err) { log.error('setVisibleOnAllWorkspaces failed:', err && err.message); }
    }
    if (win && changed('alwaysOnTop')) win.setAlwaysOnTop(!!next.alwaysOnTop, 'floating');
    if (changed('refreshInterval')) scheduler.applyInterval(parseInt(next.refreshInterval, 10));

    if (changed('trayStats') || changed('providers')) {
      tray.rebuild();
    } else if (changed('warnThreshold') || changed('dangerThreshold') || changed('timeFormat')) {
      tray.update(scheduler.getLastSnapshot());
    }

    if (changed('compactMode')) applyCompactWidth(!!next.compactMode);

    if (changed('claudeSource')) {
      // The two Claude sources share the provider id; drop the old source's last-good values and
      // the expiry latch so the switch never shows "stale" data from the other source or fires a
      // spurious session-expired event.
      scheduler.forgetProvider('claude');
      lastClaudeStatus = null;
      if (next.claudeSource === 'claude_web') loadWebSession();
    }

    if (changed('providers') || changed('claudeSource') || changed('tokenAutoRefresh') || changed('claudeOrganizationId')) {
      scheduler.refreshNow();
    }

    // Compared on the resolved value, so acrylic ↔ acrylic_clear (same material, different theme/tint)
    // recreates too, while a no-op (unsupported → still solid) leaves the window alone.
    if (changed('background') && win && windowing.getAppliedBackground(win) !== windowing.resolveBackground(next.background)) {
      recreateWindow();
    }

    // Phone sync: enabling with no key generates one; a relay URL change resets the push state and
    // fills the new relay right away (both subject to the 60 s floor). The module broadcasts its status.
    if (changed('phoneSyncEnabled') || changed('phoneRelayUrl')) {
      phoneSync.settingsChanged(prev, next);
    }
  }

  function handleSaveSettings(rawPatch) {
    // Arrays pass `typeof === 'object'` and would be spread into numeric keys of the stored settings.
    if (!rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) return getSettings();
    const prev = getSettings();
    const patch = { ...rawPatch };
    // Both acrylics and mica need the DWM material (Windows 11 22H2+); the stored value is kept truthful
    // so `settings-updated` never announces a backdrop the window cannot have.
    if (patch.background && patch.background !== 'solid' && !windowing.acrylicSupported()) {
      log.info(`background '${patch.background}' is not supported on this OS build; using 'solid'`);
      patch.background = 'solid';
    }
    if (IS_PORTABLE && patch.autoStart) {
      // applyLoginItem() refuses to register a portable exe (§5); keep the stored value truthful so the
      // toggle does not show "on" for a setting that does nothing (and would silently activate later
      // if the same config.json is picked up by an installed build).
      log.info('portable build: autoStart cannot be registered; keeping it off');
      patch.autoStart = false;
    }
    const next = saveSettings(patch);
    try {
      applySettingsSideEffects(prev, next);
    } catch (err) {
      log.error('applying settings side effects failed:', err && err.message);
    }
    broadcast('settings-updated', next);
    return next;
  }

  // ---------------------------------------------------------------------------------------------
  // claude.ai web session (optional provider, providers/claude-web.js). The module keeps the
  // sessionKey in memory only; main.js owns persistence: safeStorage-encrypted in config.json,
  // restored with setSession() at startup and whenever the source switches to claude_web.
  // ---------------------------------------------------------------------------------------------
  const webLog = createLogger('claude-web');

  function webMethod(names) {
    const mod = providers.claudeWeb.getModule();
    if (!mod) return null;
    for (const name of names) if (typeof mod[name] === 'function') return mod[name].bind(mod);
    return null;
  }

  function readStoredWebSessionKey() {
    let encoded = null;
    try {
      encoded = store.get(WEB_SESSION_STORE_KEY, null);
    } catch (err) {
      log.error('reading the stored claude.ai session failed:', err && err.message);
      return null;
    }
    if (typeof encoded !== 'string' || !encoded) return null;
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        log.warn('safeStorage is unavailable; the stored claude.ai session cannot be decrypted — log in again');
        return null;
      }
      return safeStorage.decryptString(Buffer.from(encoded, 'base64')) || null;
    } catch (err) {
      log.warn('stored claude.ai session could not be decrypted (different user/machine?); log in again');
      return null;
    }
  }

  // Never logs or stores the key in clear text. Without safeStorage the session lives in memory only.
  function persistWebSessionKey(sessionKey) {
    try {
      if (!sessionKey) {
        store.delete(WEB_SESSION_STORE_KEY);
        return;
      }
      if (!safeStorage.isEncryptionAvailable()) {
        log.warn('safeStorage is unavailable; claude.ai session is kept for this run only');
        return;
      }
      store.set(WEB_SESSION_STORE_KEY, safeStorage.encryptString(String(sessionKey)).toString('base64'));
    } catch (err) {
      log.error('persisting the claude.ai session failed:', err && err.message);
    }
  }

  // Hands the persisted session to the provider module. Safe to call repeatedly.
  function loadWebSession() {
    const setSession = webMethod(['setSession']);
    if (!setSession) return;
    try {
      const sessionKey = readStoredWebSessionKey();
      setSession({ sessionKey, organizationId: getSettings().claudeOrganizationId });
      if (sessionKey) log.info('claude.ai web session restored');
    } catch (err) {
      log.error('restoring the claude.ai session failed:', err && err.message);
    }
  }

  async function claudeWebLogin() {
    const login = webMethod(['login']);
    if (!login) return { success: false, error: 'Claude web login is not available in this build' };
    try {
      const result = await login({
        log: webLog,
        onSessionKey: (sessionKey, { organizationId } = {}) => {
          persistWebSessionKey(sessionKey);
          if (organizationId) saveSettings({ claudeOrganizationId: organizationId });
        },
      });
      const ok = result === true || (result && result.success !== false);
      if (ok) {
        lastClaudeStatus = null;
        scheduler.forgetProvider('claude');
        scheduler.refreshNow();
        broadcast('settings-updated', getSettings()); // claudeOrganizationId may have changed
      }
      return result && typeof result === 'object' ? result : { success: !!ok };
    } catch (err) {
      return { success: false, error: (err && err.message) || 'Login failed' };
    }
  }

  async function claudeWebLogout() {
    const logout = webMethod(['logout']);
    if (logout) {
      try { await logout(); } catch (err) { log.error('claude web logout failed:', err && err.message); }
    }
    persistWebSessionKey(null);
    lastClaudeStatus = null;
    scheduler.forgetProvider('claude');
    if (getSettings().claudeOrganizationId) handleSaveSettings({ claudeOrganizationId: null }); // also refreshes
    else scheduler.refreshNow();
    return true;
  }

  async function claudeWebOrgs() {
    const list = webMethod(['listOrgs', 'listOrganizations']);
    if (!list) return [];
    try {
      const orgs = await list({ log: webLog });
      return Array.isArray(orgs)
        ? orgs.map((o) => ({ id: String(o.id), name: o.name == null ? '' : String(o.name), isTeam: !!o.isTeam }))
        : [];
    } catch (err) {
      log.error('claude web org list failed:', err && err.message);
      return [];
    }
  }

  async function claudeWebSelectOrg(id) {
    if (typeof id !== 'string' || !id) return false;
    const select = webMethod(['selectOrg', 'selectOrganization']);
    try {
      if (select) await select(id);
      handleSaveSettings({ claudeOrganizationId: id }); // side effect: refreshNow()
      return true;
    } catch (err) {
      log.error('claude web org select failed:', err && err.message);
      return false;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Phone sync pair key (docs/PHONE-SYNC.md). Same persistence pattern as the claude.ai session:
  // safeStorage-encrypted under a top-level store key, decrypted only in this process. Never logged.
  // ---------------------------------------------------------------------------------------------
  function safeHostname() {
    try {
      return os.hostname();
    } catch (err) {
      return '';
    }
  }

  // → Buffer (32 bytes) | null. Requires a ready app (safeStorage); sync.load() is called from whenReady.
  function readStoredPairKey() {
    let encoded = null;
    try {
      encoded = store.get(PHONE_PAIR_KEY_STORE_KEY, null);
    } catch (err) {
      log.error('reading the stored phone pair key failed:', err && err.message);
      return null;
    }
    if (typeof encoded !== 'string' || !encoded) return null;
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        log.warn('safeStorage is unavailable; the stored phone pair key cannot be decrypted — re-pair the phone');
        return null;
      }
      const key = Buffer.from(safeStorage.decryptString(Buffer.from(encoded, 'base64')), 'base64');
      return key.length === 32 ? key : null;
    } catch (err) {
      log.warn('stored phone pair key could not be decrypted (different user/machine?); re-pair the phone');
      return null;
    }
  }

  // Returns true only when the key landed on disk; false = memory-only for this run (the UI says so).
  function persistPairKey(key) {
    try {
      if (!key) {
        store.delete(PHONE_PAIR_KEY_STORE_KEY);
        return true;
      }
      if (!safeStorage.isEncryptionAvailable()) {
        log.warn('safeStorage is unavailable; the phone pair key is kept for this run only');
        return false;
      }
      store.set(PHONE_PAIR_KEY_STORE_KEY, safeStorage.encryptString(Buffer.from(key).toString('base64')).toString('base64'));
      return true;
    } catch (err) {
      log.error('persisting the phone pair key failed:', err && err.message);
      return false;
    }
  }

  // Unpair = DELETE the slot best-effort, forget K (module) and turn the setting off (here, so the
  // settings-updated broadcast and side effects run through the one path).
  async function phoneSyncUnpair() {
    await phoneSync.unpair();
    if (getSettings().phoneSyncEnabled) handleSaveSettings({ phoneSyncEnabled: false });
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // IPC (§8). Payloads are `{ key }` objects from preload; bare values are accepted too.
  // ---------------------------------------------------------------------------------------------
  const unwrap = (arg, key) => (arg && typeof arg === 'object' && key in arg ? arg[key] : arg);

  // The renderer is untrusted input and the claude.ai login/fetch windows load remote pages in this
  // process: only the widget's own webContents may drive the IPC surface. Foreign senders are logged
  // and ignored (invoke → rejected promise, send → dropped).
  function isTrustedSender(event) {
    const win = liveWindow();
    return !!(event && event.sender && win && event.sender === win.webContents);
  }
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      log.warn(`ipc '${channel}' from an unexpected sender ignored`);
      throw new Error('Unauthorized IPC sender');
    }
    return fn(event, ...args);
  });
  const on = (channel, fn) => ipcMain.on(channel, (event, ...args) => {
    if (!isTrustedSender(event)) {
      log.warn(`ipc '${channel}' from an unexpected sender ignored`);
      return;
    }
    fn(event, ...args);
  });

  handle('get-settings', () => getSettings());
  handle('save-settings', (_event, arg) => handleSaveSettings(unwrap(arg, 'patch')));
  handle('get-snapshot', () => scheduler.getLastSnapshot());
  handle('refresh-now', () => scheduler.refreshNow());
  handle('get-history', (_event, arg) => {
    const requested = Number(unwrap(arg, 'days'));
    const days = Number.isFinite(requested) && requested > 0 ? Math.min(8, requested) : 7;
    return history.get(days, scheduler.getLastSnapshot());
  });
  // `background` is the backdrop the CURRENT window was created with ('acrylic' | 'acrylic_clear' |
  // 'mica' | 'solid'), which is what the renderer keys its bg-* class and forced palette off — the
  // stored setting may be ahead of it until the recreate lands, or downgraded to solid.
  handle('get-app-info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    acrylicSupported: windowing.acrylicSupported(),
    isPortable: IS_PORTABLE,
    background: windowing.getAppliedBackground(liveWindow()),
  }));
  handle('claude-web-login', () => claudeWebLogin());
  handle('claude-web-logout', () => claudeWebLogout());
  handle('claude-web-orgs', () => claudeWebOrgs());
  handle('claude-web-select-org', (_event, arg) => claudeWebSelectOrg(unwrap(arg, 'id')));
  // Phone sync (§8 / docs/PHONE-SYNC.md). K never leaves the main process; the renderer only sees the
  // pairing string + QR data URL.
  handle('phone-sync-status', () => phoneSync.getStatus());
  handle('phone-sync-pairing', () => phoneSync.getPairing());
  handle('phone-sync-repair', () => phoneSync.repair());
  handle('phone-sync-unpair', () => phoneSyncUnpair());
  handle('phone-sync-test', (_event, arg) => phoneSync.test(unwrap(arg, 'relayUrl')));
  handle('phone-sync-push-now', () => phoneSync.pushNow());

  on('minimize-window', () => {
    const win = liveWindow();
    if (!win) return;
    const hideFromTaskbar = !!getSettings().hideFromTaskbar;
    if (hideFromTaskbar && tray.hasIcon()) {
      win.hide();
      return;
    }
    // hideFromTaskbar with no tray icon (both providers off, or Tray creation failed) would minimize a
    // window that has neither a taskbar button nor a tray icon; give the taskbar button back first.
    // The 'restore' handler in createWindow() re-hides it once a tray icon exists again.
    if (hideFromTaskbar) applyHideFromTaskbar(win, false);
    win.minimize();
  });
  on('close-window', () => {
    const win = liveWindow();
    if (win) win.close(); // routes through the 'close' handler → hide-or-quit decision
  });
  on('resize-window', (_event, arg) => resizeToHeight(unwrap(arg, 'height')));
  on('set-compact-mode', (_event, arg) => {
    const compact = !!unwrap(arg, 'compact');
    // Persist through the settings path so the width change and the `settings-updated` broadcast
    // happen together; when nothing changed just re-apply the width (idempotent).
    if (getSettings().compactMode !== compact) handleSaveSettings({ compactMode: compact });
    else applyCompactWidth(compact);
  });
  on('open-external', (_event, arg) => openExternal(unwrap(arg, 'url')));

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------
  app.whenReady().then(() => {
    // The renderer never needs OS permissions (camera, notifications, ...); deny by default.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

    let settings = getSettings();
    if (!windowing.acrylicSupported() && settings.background !== 'solid') {
      log.info(`backdrop '${settings.background}' not supported on this OS; switching to 'solid'`);
      // A failed config write (read-only profile, disk full) must not abort startup before the window
      // and tray exist — resolveBackground() downgrades at creation time anyway.
      try {
        settings = saveSettings({ background: 'solid' });
      } catch (err) {
        log.error('persisting the backdrop downgrade failed:', err && err.message);
        settings = { ...settings, background: 'solid' };
      }
    }
    log.info(`starting v${app.getVersion()} (electron ${process.versions.electron}, ${process.platform} ${require('os').release()}, backdrop ${windowing.resolveBackground(settings.background)}, portable ${IS_PORTABLE})`);

    try {
      const kept = history.pruneAll();
      log.debug(`history: ${kept} samples after startup prune`);
    } catch (err) {
      log.error('history prune failed:', err && err.message);
    }

    // safeStorage needs a ready app; restore the claude.ai session before the first tick.
    loadWebSession();
    // Same for the phone pair key (the first tick's snapshot is the first push when sync is on).
    phoneSync.load();

    createWindow();
    tray.update(null); // creates placeholder badges when trayStats is on
    if (process.platform === 'darwin') applyHideFromTaskbar(liveWindow(), settings.hideFromTaskbar);

    powerMonitor.on('resume', () => {
      log.info('system resumed; refreshing');
      scheduler.refreshNow();
    });

    // Re-assert z-order every 2 s. Windows refuses WS_EX_TOPMOST to EVERY process while a fullscreen
    // game is the foreground window (verified: even a WinForms TopMost form is denied), so a widget
    // (re)started during a game comes up without the flag. isAlwaysOnTop() reads the real native flag
    // on Windows, so this loop notices the denial and keeps asking; the first tick after the game stops
    // being foreground succeeds and the window jumps back to the topmost band. Never re-asserts
    // `false` (the user may have turned it off meanwhile).
    let topmostDenied = false;
    if (process.platform === 'win32') setInterval(() => {
      const win = liveWindow();
      if (!win || !getSettings().alwaysOnTop) return;
      const raisable = win.isVisible() && !win.isMinimized() && !win.isFocused();
      if (win.isAlwaysOnTop()) {
        if (topmostDenied) { topmostDenied = false; log.info('always-on-top regained'); }
        // Holding the flag is not the whole story: a borderless game that makes ITSELF topmost sits above
        // us inside the topmost band whenever it is the active window. HWND_TOP (moveTop, non-activating)
        // moves us back to the top of the band without disturbing the game.
        if (raisable) win.moveTop();
        return;
      }
      win.setAlwaysOnTop(true, 'floating');
      if (win.isAlwaysOnTop()) return;
      if (!topmostDenied) { topmostDenied = true; log.info('always-on-top denied by Windows (fullscreen app in front?); retrying every 2 s'); }
      // Fallback while denied: a plain non-activating raise (HWND_TOP) is still allowed, so keep the
      // widget above the other ordinary windows on its monitor. It cannot cover the fullscreen game
      // itself, and it never takes focus, so the game is undisturbed.
      if (raisable) win.moveTop();
    }, 2000);

    scheduler.start();
  }).catch((err) => {
    log.error('startup failed:', err && (err.stack || err.message));
    // Without a window or a tray icon the process is invisible and the user has no way to close it
    // (and the single-instance lock keeps a relaunch from ever showing anything).
    if (!liveWindow() && !tray.hasIcon()) {
      log.error('no window and no tray icon after a failed startup; quitting');
      app.quit();
    }
  });

  app.on('second-instance', () => showMainWindowSmart());
  app.on('activate', () => showMainWindowSmart());

  app.on('before-quit', () => {
    isQuitting = true;
    scheduler.stop();
  });
  app.on('will-quit', () => {
    tray.destroy();
  });

  app.on('window-all-closed', () => {
    if (recreatingWindow || BrowserWindow.getAllWindows().length > 0) return;
    // macOS: the Dock icon (when visible) reopens the window through 'activate', so stay alive.
    if (process.platform === 'darwin' && app.dock && app.dock.isVisible()) return;
    // Without a tray icon there is no way back to a hidden window, so a closed window means quit.
    if (!tray.hasIcon()) app.quit();
  });

  // A widget should log and keep running rather than die with a dialog on an unexpected error.
  process.on('uncaughtException', (err) => log.error('uncaught exception:', err && (err.stack || err.message)));
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection:', reason && (reason.stack || reason.message || reason)));
}
