'use strict';
// Main window (ARCHITECTURE.md §4): frameless widget with a DWM backdrop material, exact content sizing,
// position persistence and off-screen recovery.

const path = require('path');
const os = require('os');

// Electron is resolved lazily so this module can be unit-tested under plain node: tests inject fake
// `BrowserWindow`/`screen` objects through `deps`, production code falls through to the real ones.
function electron() {
  return require('electron');
}
function defaultScreen() {
  return electron().screen;
}

const WIDGET_WIDTH = 560;
const COMPACT_WIDTH = 290;
// Initial heights only — the renderer measures itself and calls `resize-window` right after load.
const INITIAL_HEIGHT = 155;
const COMPACT_INITIAL_HEIGHT = 120;
// A crashed renderer leaves a blank frameless panel with no way to recover from inside the widget, so
// the page is reloaded a bounded number of times per window.
const MAX_CRASH_RELOADS = 3;
const CRASH_RELOAD_DELAY_MS = 1000;

const RENDERER_INDEX = path.join(__dirname, '..', 'renderer', 'index.html');
const PRELOAD_PATH = path.join(__dirname, '..', 'preload.js');
const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.ico');

// Which backdrop each window was created with (creation-only option, so main.js needs it to decide
// whether a `background` change requires a recreate).
const appliedBackground = new WeakMap();

// Translucent backdrops: Windows needs a DWM backgroundMaterial (Windows 11 22H2, build 22621, or later);
// macOS always has NSVisualEffectView vibrancy. Everything else gets 'solid'. The name is historical —
// the renderer keys the Background buttons off `acrylicSupported` in get-app-info.
function acrylicSupported(platform = process.platform, release = os.release()) {
  if (platform === 'darwin') return true;
  if (platform !== 'win32') return false;
  const build = parseInt(String(release).split('.')[2], 10);
  return Number.isFinite(build) && build >= 22621;
}

// Settings values for `background` (store.js ENUMS), in UI order: Smoky Acrylic, Clear Acrylic, Mica, Solid.
// Both acrylic flavours use the same DWM material — they differ in the immersive theme the window is
// created under (themeSourceFor) and in the renderer's tint (styles.css bg-acrylic vs bg-clear).
const BACKGROUNDS = Object.freeze(['acrylic', 'acrylic_clear', 'mica', 'solid']);

function resolveBackground(setting, supported = acrylicSupported(), platform = process.platform) {
  let wanted = BACKGROUNDS.includes(setting) ? setting : 'acrylic';
  if (platform === 'darwin' && wanted === 'mica') wanted = 'acrylic'; // Mica is a Windows-only material
  return supported ? wanted : 'solid';
}

// DWM backdrop material for a resolved background; null = no material (transparent window, solid mode).
function materialFor(background) {
  if (background === 'acrylic' || background === 'acrylic_clear') return 'acrylic';
  if (background === 'mica') return 'mica';
  return null;
}

// macOS counterpart of materialFor(): the NSVisualEffectView material. 'under-window' is the closest
// match to acrylic (blurs whatever is behind the window, follows the app appearance that
// themeSourceFor() pins: dark glass for Smoky, bright glass for Clear). null = no vibrancy (solid).
function vibrancyFor(background) {
  if (background === 'acrylic' || background === 'acrylic_clear' || background === 'mica') return 'under-window';
  return null;
}

// Windows fixes the acrylic blur strength; the base colour of the glass follows the window's DWM
// immersive theme, which Electron derives from nativeTheme.themeSource (verified on this machine:
// "dark" → dark grey glass, "light" → bright, milky, clearly see-through glass). Smoky pins the dark
// base so the panel stays smoky even when Windows is in light mode; Clear pins the light base (white
// text is unreadable on it, so the renderer forces its dark-text palette); Mica/Solid follow the OS.
function themeSourceFor(background) {
  if (background === 'acrylic_clear') return 'light';
  if (background === 'acrylic') return 'dark';
  return 'system';
}

function widthFor(settings) {
  return settings && settings.compactMode ? COMPACT_WIDTH : WIDGET_WIDTH;
}

// True when the rect overlaps at least one connected display's work area (strict AABB test).
function isPositionOnScreen(x, y, width, height, scr = defaultScreen()) {
  return scr.getAllDisplays().some((display) => {
    const area = display.workArea;
    return x < area.x + area.width && x + width > area.x && y < area.y + area.height && y + height > area.y;
  });
}

function getCenteredPosition(width, height, scr = defaultScreen()) {
  const area = scr.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
  };
}

// A frameless window with a backgroundMaterial is created 64×32 px too small and every later
// setContentSize lands 16×8 px short (the invisible resize border). thickFrame:false would fix the
// size but lose the rounded corners and shadow, so we keep the frame and compensate by measuring.
// In solid/transparent mode the first call already matches and the helper is a no-op.
//
// The last size requested for each window is remembered: the renderer's first `resize-window` regularly
// arrives BEFORE the first paint, and 'ready-to-show' must re-apply that height rather than the initial
// one — the renderer de-duplicates on the height it last sent, so a clobbered size would never be resent
// (observed live: 155 px window showing 290 px of content until the next layout change).
//
// While the window is MINIMIZED Windows reports its content size as 0×0 and ignores setContentSize
// (verified on Electron 41.10.7): sizing it then would make the compensation below request a
// double-size window that pops up on restore. So the request is only recorded and the 'restore'
// handler in createMainWindow() applies it. Returns true when the window ended up at the requested size.
const requestedContentSize = new WeakMap();

function applyContentSize(win, width, height, log = console) {
  if (!win || win.isDestroyed()) return false;
  requestedContentSize.set(win, { width, height });
  if (win.isMinimized()) {
    if (typeof log.debug === 'function') log.debug(`[window] minimized; content size ${width}x${height} deferred until restore`);
    return false;
  }
  win.setContentSize(width, height);
  const [cw, ch] = win.getContentSize();
  if (cw > 0 && ch > 0 && (cw !== width || ch !== height)) {
    win.setContentSize(width + (width - cw), height + (height - ch));
  }
  const [fw, fh] = win.getContentSize();
  if (fw !== width || fh !== height) {
    log.warn(`[window] content size is ${fw}x${fh}, requested ${width}x${height}`);
    return false;
  }
  return true;
}

// Last size requested through applyContentSize() for this window (what the window *should* be even
// while minimized reports 0×0), or null before the first request.
function getRequestedContentSize(win) {
  return win ? requestedContentSize.get(win) || null : null;
}

// Moves the window back onto the primary work area if it is entirely off every display. A minimized
// window ignores setPosition (verified), so callers restore first; the 'restore' handler retries.
function ensureOnScreen(win, onMove, scr = defaultScreen()) {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) return false;
  const bounds = win.getBounds();
  if (isPositionOnScreen(bounds.x, bounds.y, bounds.width, bounds.height, scr)) return false;
  const { x, y } = getCenteredPosition(bounds.width, bounds.height, scr);
  win.setPosition(x, y);
  if (typeof onMove === 'function') onMove({ x, y });
  return true;
}

// Electron's isVisible() is true for a fully off-screen window; the tray toggle needs the truth.
function isWindowShownOnScreen(win, scr = defaultScreen()) {
  if (!win || win.isDestroyed()) return false;
  if (!win.isVisible() || win.isMinimized()) return false;
  const b = win.getBounds();
  return isPositionOnScreen(b.x, b.y, b.width, b.height, scr);
}

// Single recovery path for every "bring it forward" trigger. Returns false when there is no window
// to show so the caller can create one. Order matters: restore BEFORE the off-screen check, because a
// minimized window silently drops setPosition and would come back off-screen with a wrong saved position.
function showMainWindowSmart(win, { onMove, screen: scr = defaultScreen() } = {}) {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  ensureOnScreen(win, onMove, scr);
  win.show();
  win.focus();
  return true;
}

function createMainWindow({ settings = {}, savedPosition = null, onClose, onClosed, onMove, log = console, deps = {} } = {}) {
  const Win = deps.BrowserWindow || electron().BrowserWindow;
  const scr = deps.screen || defaultScreen();
  const crashReloadDelayMs = Number.isFinite(deps.crashReloadDelayMs) ? deps.crashReloadDelayMs : CRASH_RELOAD_DELAY_MS;

  const platform = deps.platform || process.platform;
  const supported = typeof deps.acrylicSupported === 'boolean' ? deps.acrylicSupported : acrylicSupported(platform);
  const background = resolveBackground(settings.background, supported, platform);
  // Windows: a DWM backgroundMaterial on an opaque window. macOS: NSVisualEffectView vibrancy on an opaque
  // window. Either way the renderer paints its tint over the blur. Solid mode is a transparent window
  // and the renderer draws its own rounded panel.
  const material = platform === 'win32' ? materialFor(background) : null;
  const vibrancy = platform === 'darwin' ? vibrancyFor(background) : null;
  const useMaterial = material !== null || vibrancy !== null;
  const width = widthFor(settings);
  const height = settings.compactMode ? COMPACT_INITIAL_HEIGHT : INITIAL_HEIGHT;

  let position = null;
  if (savedPosition && Number.isFinite(Number(savedPosition.x)) && Number.isFinite(Number(savedPosition.y))) {
    const x = Math.round(Number(savedPosition.x));
    const y = Math.round(Number(savedPosition.y));
    if (isPositionOnScreen(x, y, width, height, scr)) position = { x, y };
    else log.info(`[window] saved position ${x},${y} is off-screen; centering instead`);
  }

  const options = {
    width,
    height,
    frame: false,
    resizable: false,
    show: false,
    useContentSize: true,
    roundedCorners: true,
    hasShadow: true,
    alwaysOnTop: settings.alwaysOnTop !== false,
    skipTaskbar: !!settings.hideFromTaskbar,
    // Materials/vibrancy need an opaque window; the renderer paints a translucent tint over the blur.
    // Solid mode uses a transparent window and the renderer draws its own rounded panel.
    transparent: !useMaterial,
    title: 'AI Usage',
    icon: ICON_PATH,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  };
  if (material) options.backgroundMaterial = material;
  if (vibrancy) {
    options.vibrancy = vibrancy;
    // Keep the glass "active" while the widget is not the key window — it almost never is.
    options.visualEffectState = 'active';
  }
  if (position) {
    options.x = position.x;
    options.y = position.y;
  }

  // DWM picks the acrylic base colour from the window's immersive theme when the window is created, so
  // nativeTheme.themeSource must be set BEFORE `new BrowserWindow` (a background change recreates the
  // window through this function, which is what makes the switch take effect). themeSource is
  // app-global: it also drives the renderer's prefers-color-scheme, so the "system" theme setting
  // follows the backdrop (dark under Smoky, light under Clear) instead of Windows — accepted.
  const nativeTheme = deps.nativeTheme || electron().nativeTheme;
  const themeSource = themeSourceFor(background);
  if (nativeTheme && nativeTheme.themeSource !== themeSource) nativeTheme.themeSource = themeSource;
  if (typeof log.debug === 'function') log.debug(`[window] creating with backdrop ${background} (material ${material || vibrancy || 'none'}, themeSource ${themeSource})`);

  const win = new Win(options);
  appliedBackground.set(win, background);

  if (settings.alwaysOnTop !== false) win.setAlwaysOnTop(true, 'floating');
  // macOS: follow the user across Spaces and sit above full-screen apps too — the "always on top that
  // really is always" Windows cannot offer (see main.js's re-assert loop for the Windows story).
  if (platform === 'darwin' && typeof win.setVisibleOnAllWorkspaces === 'function') {
    try {
      win.setVisibleOnAllWorkspaces(settings.alwaysOnTop !== false, { visibleOnFullScreen: true, skipTransformProcessType: true });
    } catch (err) {
      log.warn('[window] setVisibleOnAllWorkspaces failed:', err && err.message);
    }
  }

  // Hardening: the widget never navigates or opens windows; anything else is a bug or an injection.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!String(url).startsWith('file:')) event.preventDefault();
  });

  // Crash recovery: reload the page (bounded) instead of leaving a dead blank panel. 'clean-exit' is
  // a normal teardown (window closing) and never reloaded.
  let crashReloads = 0;
  let reloadTimer = null;
  win.webContents.on('render-process-gone', (_event, details) => {
    const reason = details && details.reason;
    log.error('[window] renderer process gone:', reason);
    if (reason === 'clean-exit' || win.isDestroyed()) return;
    if (crashReloads >= MAX_CRASH_RELOADS) {
      log.error(`[window] renderer crashed ${crashReloads} times; not reloading again`);
      return;
    }
    crashReloads += 1;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      log.info(`[window] reloading renderer after crash (${crashReloads}/${MAX_CRASH_RELOADS})`);
      try { win.webContents.reload(); } catch (err) { log.error('[window] reload failed:', err && err.message); }
    }, crashReloadDelayMs);
  });

  // Renderer console → main log (debug level only) so smoke tests and `--debug-log` runs can see page
  // errors without DevTools. Electron ≥ 32 passes the details on the event object; older builds
  // used positional arguments — accept both.
  win.webContents.on('console-message', (event, legacyLevel, legacyMessage) => {
    const message = event && typeof event === 'object' && 'message' in event ? event.message : legacyMessage;
    const level = event && typeof event === 'object' && 'level' in event ? event.level : legacyLevel;
    if (message === undefined) return;
    const text = `[renderer:${level}] ${message}`;
    if (level === 'error' || level === 3) log.error(text);
    else if (typeof log.debug === 'function') log.debug(text);
  });

  win.once('ready-to-show', () => {
    // Re-apply the size most recently requested (the renderer may already have reported its height),
    // falling back to the initial size; this is also what compensates the material-window creation quirk.
    const wanted = requestedContentSize.get(win) || { width, height };
    applyContentSize(win, wanted.width, wanted.height, log);
    if (typeof log.debug === 'function') {
      log.debug(`[window] ready-to-show: content ${win.getContentSize().join('x')} (requested ${wanted.width}x${wanted.height})`);
    }
    win.show();
  });

  // Debounced position persistence. Guarded against the window being destroyed within the
  // debounce (the original could dereference a closed window here).
  let moveTimer = null;
  win.on('move', () => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      moveTimer = null;
      if (win.isDestroyed()) return;
      const b = win.getBounds();
      if (typeof onMove === 'function') onMove({ x: b.x, y: b.y });
    }, 300);
  });

  // main.js owns the hide-vs-quit decision (it knows the quit flag and whether a tray icon exists).
  win.on('close', (event) => {
    if (typeof onClose === 'function') onClose(event, win);
  });
  win.on('closed', () => {
    if (moveTimer) clearTimeout(moveTimer);
    if (reloadTimer) clearTimeout(reloadTimer);
    moveTimer = null;
    reloadTimer = null;
    if (typeof onClosed === 'function') onClosed(win);
  });

  // Restore: apply any content size that arrived while minimized (see applyContentSize), then recentre if
  // the coordinates no longer exist after a monitor change. Never call show()/focus() here — 'focus'
  // would re-enter itself.
  win.on('restore', () => {
    const wanted = requestedContentSize.get(win);
    if (wanted) applyContentSize(win, wanted.width, wanted.height, log);
    ensureOnScreen(win, onMove, scr);
  });
  win.on('focus', () => { ensureOnScreen(win, onMove, scr); });

  win.loadFile(RENDERER_INDEX).catch((err) => {
    log.error(`[window] failed to load ${RENDERER_INDEX}:`, err && err.message);
  });

  if (process.env.NODE_ENV === 'development') {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  return win;
}

function getAppliedBackground(win) {
  return win ? appliedBackground.get(win) || null : null;
}

module.exports = {
  createMainWindow,
  applyContentSize,
  getRequestedContentSize,
  acrylicSupported,
  resolveBackground,
  materialFor,
  vibrancyFor,
  themeSourceFor,
  BACKGROUNDS,
  WIDGET_WIDTH,
  COMPACT_WIDTH,
  INITIAL_HEIGHT,
  COMPACT_INITIAL_HEIGHT,
  MAX_CRASH_RELOADS,
  CRASH_RELOAD_DELAY_MS,
  isPositionOnScreen,
  getCenteredPosition,
  widthFor,
  ensureOnScreen,
  isWindowShownOnScreen,
  showMainWindowSmart,
  getAppliedBackground,
};
