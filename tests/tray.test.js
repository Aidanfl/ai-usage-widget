'use strict';
// Tray lifecycle: the badge set follows trayStats/providers, update() repaints without recreating icons,
// and destroy() latches so a refresh tick that finishes during shutdown cannot recreate Tray objects
// (which would leave ghost icons in the Windows notification area). Electron is injected as fakes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTray, desiredBadges, badgeColor } = require('../src/main/tray');

function fakeElectron() {
  const created = [];
  class Tray {
    constructor(image) {
      this.image = image;
      this.tooltip = '';
      this.destroyed = false;
      this.listeners = 0;
      created.push(this);
    }
    isDestroyed() { return this.destroyed; }
    setToolTip(text) { this.tooltip = text; }
    setContextMenu() {}
    setImage(image) { this.image = image; }
    on() { this.listeners += 1; }
    removeAllListeners() { this.listeners = 0; }
    destroy() { this.destroyed = true; }
  }
  const nativeImage = {
    createFromBuffer: (buffer, size) => ({ buffer, size, isEmpty: () => false }),
    createFromPath: () => ({ isEmpty: () => true }), // force the generated placeholder
  };
  const Menu = { buildFromTemplate: (template) => ({ template }) };
  return { deps: { Tray, Menu, nativeImage }, created };
}

const SNAPSHOT = {
  fetchedAt: 1,
  providers: {
    claude: {
      id: 'claude', name: 'Claude', status: 'ok', error: null,
      windows: [
        { key: 'session', label: 'Current Session', kind: 'session', percent: 42, resetsAt: '2026-09-07T13:59:00.000Z' },
        { key: 'weekly', label: 'Weekly Limit', kind: 'weekly', percent: 91, resetsAt: '2026-09-10T13:59:00.000Z' },
      ],
    },
    codex: null,
  },
};

function settingsFor(trayStats, providers = { claude: true, codex: true }) {
  return { trayStats, providers, warnThreshold: 75, dangerThreshold: 90, timeFormat: '12h' };
}

test("trayStats 'claude' creates weekly+session badges once, repaints in place and reports hasIcon()", () => {
  const { deps, created } = fakeElectron();
  const tray = createTray({ getSettings: () => settingsFor('claude'), electron: deps });

  tray.update(null); // startup placeholders
  assert.equal(created.length, 2);
  assert.equal(tray.hasIcon(), true);
  assert.deepEqual(created.map((t) => t.tooltip), ['Claude Weekly: waiting for data', 'Claude Session: waiting for data']);

  tray.update(SNAPSHOT);
  assert.equal(created.length, 2, 'same badge set → icons are repainted, not recreated');
  assert.match(created[0].tooltip, /^Claude Weekly: 91%/);
  assert.match(created[1].tooltip, /^Claude Session: 42%/);
  assert.equal(created.every((t) => !t.destroyed), true);
});

test('destroy() latches: a late update()/rebuild() (in-flight tick finishing during quit) creates no icons', () => {
  const { deps, created } = fakeElectron();
  const tray = createTray({ getSettings: () => settingsFor('both'), electron: deps });
  tray.update(SNAPSHOT);
  const before = created.length;
  assert.ok(before > 0);

  tray.destroy();
  assert.equal(tray.isDestroyed(), true);
  assert.equal(created.every((t) => t.destroyed), true, 'existing icons destroyed');
  assert.equal(tray.hasIcon(), false);

  tray.update(SNAPSHOT);
  tray.rebuild();
  assert.equal(created.length, before, 'no Tray constructed after destroy()');
  assert.equal(tray.hasIcon(), false);
});

test('rebuild() follows settings: off → no icons; a disabled provider drops its badges; both → codex first', () => {
  let settings = settingsFor('claude');
  const { deps, created } = fakeElectron();
  const tray = createTray({ getSettings: () => settings, electron: deps });
  tray.update(SNAPSHOT);
  assert.equal(created.filter((t) => !t.destroyed).length, 2);

  settings = settingsFor('off');
  tray.rebuild();
  assert.equal(created.filter((t) => !t.destroyed).length, 0);
  assert.equal(tray.hasIcon(), false, 'hasIcon() must be false so close-window quits instead of hiding forever');

  settings = settingsFor('claude', { claude: false, codex: true });
  tray.rebuild();
  assert.equal(tray.hasIcon(), false, 'trayStats on but provider off → nothing to show');

  settings = settingsFor('both');
  tray.rebuild();
  const live = created.filter((t) => !t.destroyed);
  assert.deepEqual(live.map((t) => t.tooltip.split(':')[0]), ['Codex Weekly', 'Codex Session', 'Claude Weekly', 'Claude Session']);
  assert.match(live[0].tooltip, /waiting for data/);
});

test('desiredBadges / badgeColor are pure: placeholders without data, thresholds recolour', () => {
  const none = desiredBadges(null, settingsFor('codex'));
  assert.deepEqual(none.map((b) => b.id), ['codex.weekly', 'codex.session']);
  assert.equal(none[0].window, null);

  const claude = desiredBadges(SNAPSHOT, settingsFor('claude'));
  assert.deepEqual(claude.map((b) => [b.id, b.window.percent]), [['claude.weekly', 91], ['claude.session', 42]]);
  assert.deepEqual(desiredBadges(SNAPSHOT, settingsFor('off')), []);

  assert.deepEqual(badgeColor('claude.weekly', 10, 75, 90), { r: 59, g: 130, b: 246 });
  assert.deepEqual(badgeColor('claude.weekly', 80, 75, 90), { r: 245, g: 158, b: 11 });
  assert.deepEqual(badgeColor('claude.weekly', 95, 75, 90), { r: 239, g: 68, b: 68 });
});
