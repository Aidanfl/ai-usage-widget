'use strict';
// window.js lifecycle behaviour that only shows up on a real desktop: sizing while minimized, the
// restore-before-recentre order, off-screen recovery, the early-resize/ready-to-show race and crash
// reloads. Electron is replaced by fakes injected through `deps` (ARCHITECTURE.md §1: no Electron in tests).
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const windowing = require('../src/main/window');

const QUIET = { info() {}, warn() {}, error() {}, debug() {} };
const PRIMARY = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const fakeScreen = (displays = [PRIMARY]) => ({ getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0] });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * BrowserWindow stand-in reproducing what was verified on Electron 41.10.7 / Windows 11:
 *  - a window with a backgroundMaterial lands 16x8 short of every setContentSize (the invisible border)
 *  - a MINIMIZED window reports content 0x0 and silently ignores setContentSize and setPosition
 */
class FakeBrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.material = !!options.backgroundMaterial;
    this.destroyed = false;
    this.minimized = false;
    this.visible = false;
    this.bounds = { x: options.x ?? 100, y: options.y ?? 100, width: options.width, height: options.height };
    this.calls = [];
    this.webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler() {},
      openDevTools() {},
      isDestroyed: () => this.destroyed,
      reload: () => { this.calls.push('reload'); },
    });
  }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return this.minimized; }
  isVisible() { return this.visible && !this.minimized; }
  setAlwaysOnTop() {}
  setSkipTaskbar() {}
  loadFile() { return Promise.resolve(); }
  getBounds() { return { ...this.bounds }; }
  setPosition(x, y) {
    this.calls.push(`setPosition ${x},${y}`);
    if (this.minimized) return;
    this.bounds.x = x;
    this.bounds.y = y;
  }
  setContentSize(w, h) {
    this.calls.push(`setContentSize ${w}x${h}`);
    if (this.minimized) return;
    this.bounds.width = w - (this.material ? 16 : 0);
    this.bounds.height = h - (this.material ? 8 : 0);
  }
  getContentSize() { return this.minimized ? [0, 0] : [this.bounds.width, this.bounds.height]; }
  minimize() { this.minimized = true; this.calls.push('minimize'); }
  restore() { this.minimized = false; this.calls.push('restore'); this.emit('restore'); }
  show() { this.visible = true; this.calls.push('show'); }
  focus() { this.calls.push('focus'); }
  hide() { this.visible = false; }
  destroy() { this.destroyed = true; this.emit('closed'); }
}

function createWin({
  settings = {}, savedPosition = null, screen = fakeScreen(), onMove, onClose, onClosed, crashReloadDelayMs,
  BrowserWindow = FakeBrowserWindow, nativeTheme = { themeSource: 'system' }, acrylicSupported = true, platform = 'win32',
} = {}) {
  const win = windowing.createMainWindow({
    settings: { background: 'solid', compactMode: false, alwaysOnTop: true, ...settings },
    savedPosition,
    onMove,
    onClose,
    onClosed,
    log: QUIET,
    deps: { BrowserWindow, screen, crashReloadDelayMs, nativeTheme, acrylicSupported, platform },
  });
  return win;
}

test('background values: both acrylics share the material, differ in DWM theme; everything downgrades to solid when unsupported', () => {
  assert.deepEqual(windowing.BACKGROUNDS, ['acrylic', 'acrylic_clear', 'mica', 'solid']);
  for (const bg of windowing.BACKGROUNDS) {
    assert.equal(windowing.resolveBackground(bg, true, 'win32'), bg);
    assert.equal(windowing.resolveBackground(bg, false, 'win32'), 'solid', `${bg} without acrylic support`);
  }
  assert.equal(windowing.resolveBackground('bogus', true, 'win32'), 'acrylic', 'unknown value → default (Smoky)');
  assert.equal(windowing.resolveBackground(undefined, true, 'win32'), 'acrylic');
  assert.deepEqual(windowing.BACKGROUNDS.map(windowing.materialFor), ['acrylic', 'acrylic', 'mica', null]);
  assert.deepEqual(windowing.BACKGROUNDS.map(windowing.vibrancyFor), ['under-window', 'under-window', 'under-window', null]);
  assert.deepEqual(windowing.BACKGROUNDS.map(windowing.themeSourceFor), ['dark', 'light', 'system', 'system']);
  // macOS: Mica is Windows-only and folds into Smoky; everything else keeps its value.
  assert.deepEqual(windowing.BACKGROUNDS.map((bg) => windowing.resolveBackground(bg, true, 'darwin')), ['acrylic', 'acrylic_clear', 'acrylic', 'solid']);
});

test('acrylicSupported: Windows 11 22H2+ or macOS; Linux and older Windows get solid', () => {
  assert.equal(windowing.acrylicSupported('win32', '10.0.22621'), true);
  assert.equal(windowing.acrylicSupported('win32', '10.0.26200'), true);
  assert.equal(windowing.acrylicSupported('win32', '10.0.22000'), false, 'Windows 11 21H2 has no backgroundMaterial');
  assert.equal(windowing.acrylicSupported('win32', '10.0.19045'), false);
  assert.equal(windowing.acrylicSupported('darwin', '24.5.0'), true);
  assert.equal(windowing.acrylicSupported('linux', '6.8.0'), false);
});

test('macOS windows get vibrancy instead of a DWM material, stay opaque, and follow the user across Spaces', () => {
  class Recording extends FakeBrowserWindow {
    constructor(options) { super(options); this.workspaces = null; }
    setVisibleOnAllWorkspaces(flag, options) { this.workspaces = { flag, options }; }
  }
  const smoky = createWin({ settings: { background: 'acrylic' }, BrowserWindow: Recording, platform: 'darwin' });
  assert.equal('backgroundMaterial' in smoky.options, false);
  assert.equal(smoky.options.vibrancy, 'under-window');
  assert.equal(smoky.options.visualEffectState, 'active');
  assert.equal(smoky.options.transparent, false);
  assert.equal(smoky.options.roundedCorners, true);
  assert.deepEqual(smoky.workspaces, { flag: true, options: { visibleOnFullScreen: true, skipTransformProcessType: true } });
  assert.equal(windowing.getAppliedBackground(smoky), 'acrylic');

  const mica = createWin({ settings: { background: 'mica' }, BrowserWindow: Recording, platform: 'darwin' });
  assert.equal(windowing.getAppliedBackground(mica), 'acrylic', 'Mica folds into Smoky on macOS');
  assert.equal(mica.options.vibrancy, 'under-window');

  const solid = createWin({ settings: { background: 'solid' }, BrowserWindow: Recording, platform: 'darwin' });
  assert.equal('vibrancy' in solid.options, false);
  assert.equal(solid.options.transparent, true);

  const pinned = createWin({ settings: { background: 'acrylic', alwaysOnTop: false }, BrowserWindow: Recording, platform: 'darwin' });
  assert.equal(pinned.workspaces.flag, false, 'not pinned to every Space when always-on-top is off');

  // Linux: no material of any kind, always solid.
  const linux = createWin({ settings: { background: 'acrylic' }, platform: 'linux', acrylicSupported: false });
  assert.equal(windowing.getAppliedBackground(linux), 'solid');
  assert.equal(linux.options.transparent, true);
});

test('createMainWindow pins nativeTheme.themeSource for the backdrop BEFORE constructing the window and reports the applied value', () => {
  const themeAtConstruction = [];
  const theme = { themeSource: 'system' };
  class Recording extends FakeBrowserWindow {
    constructor(options) { super(options); themeAtConstruction.push(theme.themeSource); }
  }
  const make = (background, acrylicSupported = true) => createWin({ settings: { background }, BrowserWindow: Recording, nativeTheme: theme, acrylicSupported });

  const smoky = make('acrylic');
  assert.equal(smoky.options.backgroundMaterial, 'acrylic');
  assert.equal(smoky.options.transparent, false);
  assert.equal(windowing.getAppliedBackground(smoky), 'acrylic');
  assert.equal(themeAtConstruction.at(-1), 'dark', 'Smoky: dark glass base even on a light Windows');

  const clear = make('acrylic_clear');
  assert.equal(clear.options.backgroundMaterial, 'acrylic', 'same DWM material as Smoky');
  assert.equal(clear.options.transparent, false);
  assert.equal(windowing.getAppliedBackground(clear), 'acrylic_clear', 'get-app-info must tell the two apart');
  assert.equal(themeAtConstruction.at(-1), 'light', 'Clear: light glass base');

  const mica = make('mica');
  assert.equal(mica.options.backgroundMaterial, 'mica');
  assert.equal(themeAtConstruction.at(-1), 'system');

  const solid = make('solid');
  assert.equal('backgroundMaterial' in solid.options, false);
  assert.equal(solid.options.transparent, true);
  assert.equal(themeAtConstruction.at(-1), 'system');

  const downgraded = make('acrylic_clear', false);
  assert.equal(windowing.getAppliedBackground(downgraded), 'solid');
  assert.equal('backgroundMaterial' in downgraded.options, false);
  assert.equal(themeAtConstruction.at(-1), 'system', 'no forced theme without the material');
});

test('applyContentSize compensates the material 16x8 shortfall and is a single call for solid windows', () => {
  const material = new FakeBrowserWindow({ width: 560, height: 155, backgroundMaterial: 'acrylic' });
  assert.equal(windowing.applyContentSize(material, 560, 300, QUIET), true);
  assert.deepEqual(material.getContentSize(), [560, 300]);
  assert.deepEqual(material.calls, ['setContentSize 560x300', 'setContentSize 576x308']);
  assert.deepEqual(windowing.getRequestedContentSize(material), { width: 560, height: 300 });

  const solid = new FakeBrowserWindow({ width: 560, height: 155 });
  assert.equal(windowing.applyContentSize(solid, 290, 120, QUIET), true);
  assert.deepEqual(solid.calls, ['setContentSize 290x120']);
  assert.equal(windowing.getRequestedContentSize(null), null);
});

test('a resize arriving while minimized is deferred (never doubled from the 0x0 readback) and applied on restore', () => {
  const win = createWin();
  win.minimize();
  win.calls.length = 0;

  assert.equal(windowing.applyContentSize(win, 560, 420, QUIET), false);
  assert.ok(!win.calls.some((c) => c.startsWith('setContentSize')), 'no sizing call on a minimized window');
  assert.deepEqual(windowing.getRequestedContentSize(win), { width: 560, height: 420 }, 'request remembered');

  win.restore();
  assert.deepEqual(win.getContentSize(), [560, 420], 'restore applies the deferred size');
  assert.ok(!win.calls.some((c) => c.includes('1120') || c.includes('840')), 'the old w+(w-0) double-size request never happens');
});

test('showMainWindowSmart restores BEFORE recentring so an off-screen minimized window actually moves', () => {
  const win = new FakeBrowserWindow({ width: 560, height: 155, x: 5000, y: 5000 });
  win.minimized = true;
  const moves = [];

  assert.equal(windowing.showMainWindowSmart(win, { onMove: (p) => moves.push(p), screen: fakeScreen() }), true);

  const restoreAt = win.calls.indexOf('restore');
  const moveAt = win.calls.findIndex((c) => c.startsWith('setPosition'));
  assert.ok(restoreAt >= 0 && moveAt > restoreAt, `restore must precede setPosition: ${win.calls.join(', ')}`);
  assert.deepEqual([win.bounds.x, win.bounds.y], [680, 443], 'centred on the primary work area');
  assert.deepEqual(moves, [{ x: 680, y: 443 }], 'the persisted position is the one the window really has');
  assert.ok(win.calls.includes('show') && win.calls.includes('focus'));
  assert.equal(windowing.showMainWindowSmart(null), false);
});

test('ensureOnScreen never touches a minimized window (setPosition would be dropped and a phantom position persisted)', () => {
  const win = new FakeBrowserWindow({ width: 560, height: 155, x: 5000, y: 5000 });
  win.minimized = true;
  const moves = [];
  assert.equal(windowing.ensureOnScreen(win, (p) => moves.push(p), fakeScreen()), false);
  assert.deepEqual(moves, []);
  assert.deepEqual(win.calls, []);

  win.minimized = false;
  assert.equal(windowing.ensureOnScreen(win, (p) => moves.push(p), fakeScreen()), true);
  assert.deepEqual(moves, [{ x: 680, y: 443 }]);
  assert.equal(windowing.ensureOnScreen(win, (p) => moves.push(p), fakeScreen()), false, 'already on screen → no-op');
  assert.equal(moves.length, 1);
});

test('isPositionOnScreen / isWindowShownOnScreen use the injected display list', () => {
  const second = { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } };
  const scr = fakeScreen([PRIMARY, second]);
  assert.equal(windowing.isPositionOnScreen(100, 100, 560, 155, scr), true);
  assert.equal(windowing.isPositionOnScreen(3000, 200, 560, 155, scr), true, 'second display counts');
  assert.equal(windowing.isPositionOnScreen(-559, 100, 560, 155, scr), true, '1 px overlap is on screen');
  assert.equal(windowing.isPositionOnScreen(-560, 100, 560, 155, scr), false, 'touching the edge is not overlap');
  assert.equal(windowing.isPositionOnScreen(100, 1040, 560, 155, scr), false, 'below the work area (taskbar) is off screen');

  const win = new FakeBrowserWindow({ width: 560, height: 155, x: 100, y: 100 });
  assert.equal(windowing.isWindowShownOnScreen(win, scr), false, 'hidden');
  win.visible = true;
  assert.equal(windowing.isWindowShownOnScreen(win, scr), true);
  win.minimized = true;
  assert.equal(windowing.isWindowShownOnScreen(win, scr), false, 'minimized counts as not shown');
  win.minimized = false;
  win.bounds.x = 9000;
  assert.equal(windowing.isWindowShownOnScreen(win, scr), false, 'off-screen but visible is not shown');
});

test('createMainWindow drops an off-screen saved position (centred by the OS) and keeps an on-screen one', () => {
  const off = createWin({ savedPosition: { x: 7000, y: 7000 } });
  assert.equal('x' in off.options, false);
  assert.equal('y' in off.options, false);

  const on = createWin({ savedPosition: { x: '120', y: 80.4 } });
  assert.deepEqual([on.options.x, on.options.y], [120, 80]);
  assert.equal(on.options.width, windowing.WIDGET_WIDTH);
  assert.equal(on.options.useContentSize, true);

  const compact = createWin({ settings: { compactMode: true } });
  assert.equal(compact.options.width, windowing.COMPACT_WIDTH);
  assert.equal(compact.options.height, windowing.COMPACT_INITIAL_HEIGHT);
});

test('ready-to-show applies the height the renderer already requested instead of the initial one', () => {
  const win = createWin();
  assert.equal(win.visible, false, 'created hidden');
  windowing.applyContentSize(win, 560, 290, QUIET); // the renderer measured itself before first paint
  win.emit('ready-to-show');
  assert.deepEqual(win.getContentSize(), [560, 290]);
  assert.equal(win.visible, true);

  const untouched = createWin();
  untouched.emit('ready-to-show');
  assert.deepEqual(untouched.getContentSize(), [windowing.WIDGET_WIDTH, windowing.INITIAL_HEIGHT]);
});

test('renderer crashes are reloaded a bounded number of times; clean exits and closed windows are not', async () => {
  const win = createWin({ crashReloadDelayMs: 5 });
  const reloads = () => win.calls.filter((c) => c === 'reload').length;

  win.webContents.emit('render-process-gone', {}, { reason: 'clean-exit' });
  await sleep(25);
  assert.equal(reloads(), 0, 'clean-exit is a normal teardown');

  for (let i = 0; i < windowing.MAX_CRASH_RELOADS + 2; i++) {
    win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    await sleep(25);
  }
  assert.equal(reloads(), windowing.MAX_CRASH_RELOADS, 'reload budget is per window');

  const dying = createWin({ crashReloadDelayMs: 5 });
  dying.webContents.emit('render-process-gone', {}, { reason: 'oom' });
  dying.destroy(); // 'closed' clears the pending reload
  await sleep(25);
  assert.equal(dying.calls.filter((c) => c === 'reload').length, 0);
});

test('move is debounced to one persist and dropped when the window closes during the debounce', async () => {
  const moves = [];
  const win = createWin({ onMove: (p) => moves.push(p) });
  win.bounds.x = 10; win.emit('move');
  win.bounds.x = 20; win.emit('move');
  win.bounds.x = 30; win.emit('move');
  await sleep(380);
  assert.deepEqual(moves, [{ x: 30, y: 100 }]);

  const closedMoves = [];
  const closed = createWin({ onMove: (p) => closedMoves.push(p) });
  closed.emit('move');
  closed.destroy();
  await sleep(380);
  assert.deepEqual(closedMoves, []);
});

test('close/closed callbacks reach main.js with the window; restore recentres an off-screen window', () => {
  const seen = [];
  const win = createWin({
    onClose: (event, w) => seen.push(['close', w]),
    onClosed: (w) => seen.push(['closed', w]),
    onMove: (p) => seen.push(['move', p]),
  });
  win.emit('close', { preventDefault() {} });
  assert.deepEqual(seen, [['close', win]]);

  win.bounds.x = 8000; // monitor unplugged while minimized
  win.minimize();
  win.restore();
  // Centred on PRIMARY's 1920x1040 work area — derived, so a width change does not break this test.
  const centred = windowing.getCenteredPosition(windowing.WIDGET_WIDTH, windowing.INITIAL_HEIGHT, fakeScreen());
  assert.deepEqual([win.bounds.x, win.bounds.y], [centred.x, centred.y]);
  assert.deepEqual(seen[1], ['move', centred]);

  win.destroy();
  assert.deepEqual(seen[2], ['closed', win]);
  assert.equal(windowing.getAppliedBackground(win), 'solid');
  assert.equal(windowing.getAppliedBackground(null), null);
});
