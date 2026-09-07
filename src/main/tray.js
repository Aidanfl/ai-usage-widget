'use strict';
// Tray badges (ARCHITECTURE.md §10). Bitmap-font percentage badges ported bit-for-bit from the original
// widget (spec-main.md §3.4/3.5). One Tray per badge; the badge set follows `settings.trayStats`.

const path = require('path');
const { formatResetTime } = require('./alerts');

// Electron is resolved lazily so the module can be unit-tested under plain node; createTray() also
// accepts an injected `{ Tray, Menu, nativeImage }` for the same reason.
function electron() {
  return require('electron');
}

const PLACEHOLDER_ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'tray-icon.png');
// macOS menu bar: one monochrome template glyph (Electron picks trayTemplate@2x.png for Retina) plus the
// percentages as menu-bar TEXT — the coloured 20 px bitmap badges below are a Windows notification-area idiom.
const TEMPLATE_ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'trayTemplate.png');

// Series colours per badge slot; warn/danger recolour to amber/red; ≥ 99 % becomes the red ✕.
const BADGE_COLORS = {
  'claude.weekly': { r: 59, g: 130, b: 246 },   // blue
  'claude.session': { r: 139, g: 92, b: 246 },  // purple
  'codex.weekly': { r: 20, g: 184, b: 166 },    // teal
  'codex.session': { r: 34, g: 197, b: 94 },    // green
};
const WARN_COLOR = { r: 245, g: 158, b: 11 };   // #f59e0b
const DANGER_COLOR = { r: 239, g: 68, b: 68 };  // #ef4444
const PLACEHOLDER_COLOR = { r: 90, g: 90, b: 100 };
const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex' };

/**
 * Bold 8x11 bitmap font for numbers 0-9 (2-pixel strokes for bold look)
 * Each number is represented as an array of 11 rows, each row is 8 bits (MSB = leftmost column)
 */
const BITMAP_FONT = {
  '0': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b11000011,
    0b11000011,
    0b11000011,
    0b11000011,
    0b11000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '1': [
    0b00011000,
    0b00111000,
    0b01111000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b01111110,
    0b01111110
  ],
  '2': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b00000011,
    0b00000110,
    0b00011100,
    0b00111000,
    0b01110000,
    0b11100000,
    0b11111111,
    0b11111111
  ],
  '3': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b00000011,
    0b00000110,
    0b00111100,
    0b00000110,
    0b00000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '4': [
    0b00000110,
    0b00001110,
    0b00011110,
    0b00110110,
    0b01100110,
    0b11111111,
    0b11111111,
    0b00000110,
    0b00000110,
    0b00000110,
    0b00000110
  ],
  '5': [
    0b11111111,
    0b11111111,
    0b11000000,
    0b11000000,
    0b11111100,
    0b00000110,
    0b00000011,
    0b00000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '6': [
    0b00111100,
    0b01111110,
    0b11100000,
    0b11000000,
    0b11111100,
    0b11100110,
    0b11000011,
    0b11000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '7': [
    0b11111111,
    0b11111111,
    0b00000011,
    0b00000110,
    0b00001100,
    0b00011000,
    0b00110000,
    0b00110000,
    0b01100000,
    0b01100000,
    0b01100000
  ],
  '8': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b11000011,
    0b01111110,
    0b00111100,
    0b01111110,
    0b11000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '9': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b11000011,
    0b11000011,
    0b01111111,
    0b00111111,
    0b00000011,
    0b00000111,
    0b01111110,
    0b00111100
  ]
};

/**
 * Narrow 6x11 bitmap font for 3-digit numbers (100%)
 * Bold version to match
 */
const BITMAP_FONT_NARROW = {
  '0': [
    0b011110,
    0b111111,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b111111,
    0b011110
  ],
  '1': [
    0b001100,
    0b011100,
    0b111100,
    0b001100,
    0b001100,
    0b001100,
    0b001100,
    0b001100,
    0b001100,
    0b111111,
    0b111111
  ]
};

/**
 * Draw a crisp bitmap character at position (x, y) in the buffer (BGRA byte order).
 */
function drawChar(buffer, width, height, char, x, y, color, useNarrow = false) {
  const bitmap = useNarrow ? BITMAP_FONT_NARROW[char] : BITMAP_FONT[char];
  if (!bitmap) return useNarrow ? 6 : 8;

  const charWidth = useNarrow ? 6 : 8;
  const charHeight = 11;
  const maxCol = useNarrow ? 5 : 7;

  for (let row = 0; row < charHeight; row++) {
    for (let col = 0; col < charWidth; col++) {
      if (bitmap[row] & (1 << (maxCol - col))) {
        const px = x + col;
        const py = y + row;
        if (px >= 0 && px < width && py >= 0 && py < height) {
          const offset = (py * width + px) * 4;
          buffer[offset] = color.b;
          buffer[offset + 1] = color.g;
          buffer[offset + 2] = color.r;
          buffer[offset + 3] = color.a;
        }
      }
    }
  }
  return charWidth;
}

function fillBackground(buffer, width, height, bgColor) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      buffer[offset] = bgColor.b;
      buffer[offset + 1] = bgColor.g;
      buffer[offset + 2] = bgColor.r;
      buffer[offset + 3] = 255;
    }
  }
}

/**
 * Generate a single percentage badge icon with colored background and bitmap text
 * @param {number} percent - Usage percentage (0-100)
 * @param {object} bgColor - Background color {r, g, b}
 * @returns {NativeImage} Generated tray icon
 */
function generatePercentageIcon(percent, bgColor, ni = electron().nativeImage) {
  const width = 20;
  const height = 20;
  const buffer = Buffer.alloc(width * height * 4);

  fillBackground(buffer, width, height, bgColor);

  // Draw white text
  const percentText = Math.round(percent).toString();
  const textColor = { r: 255, g: 255, b: 255, a: 255 };

  // Use narrow font for 3-digit numbers (100%)
  const useNarrow = percentText.length >= 3;
  const charWidth = useNarrow ? 6 : 8;
  const charHeight = 11;
  const gap = percentText.length >= 3 ? 0 : 1; // 1px gap for 1-2 digits, no gap for 100
  const totalWidth = percentText.length * charWidth + (percentText.length - 1) * gap;
  let startX = Math.floor((width - totalWidth) / 2);
  const startY = Math.floor((height - charHeight) / 2);

  for (let i = 0; i < percentText.length; i++) {
    drawChar(buffer, width, height, percentText[i], startX, startY, textColor, useNarrow);
    startX += charWidth + gap;
  }

  return ni.createFromBuffer(buffer, { width, height });
}

/**
 * Generate a Red X icon for 99-100% usage (maxed out)
 * @returns {NativeImage} Generated red X tray icon
 */
function generateRedXIcon(ni = electron().nativeImage) {
  const width = 20;
  const height = 20;
  const buffer = Buffer.alloc(width * height * 4);

  // Red background #dc3545
  fillBackground(buffer, width, height, { r: 220, g: 53, b: 69 });

  // Draw white X (2 pixel thick lines)
  const white = { r: 255, g: 255, b: 255, a: 255 };
  const paint = (px, py) => {
    if (px < width && py < height) {
      const offset = (py * width + px) * 4;
      buffer[offset] = white.b;
      buffer[offset + 1] = white.g;
      buffer[offset + 2] = white.r;
      buffer[offset + 3] = white.a;
    }
  };

  // Diagonal line from top-left to bottom-right
  for (let i = 0; i < 11; i++) {
    const x1 = 5 + i;
    const y1 = 5 + i;
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) paint(x1 + dx, y1 + dy);
    }
  }

  // Diagonal line from top-right to bottom-left
  for (let i = 0; i < 11; i++) {
    const x1 = 15 - i;
    const y1 = 5 + i;
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) paint(x1 + dx, y1 + dy);
    }
  }

  return ni.createFromBuffer(buffer, { width, height });
}

// Neutral badge shown before the first snapshot / when a provider has no window for the slot.
function generatePlaceholderIcon(ni = electron().nativeImage) {
  const width = 20;
  const height = 20;
  const buffer = Buffer.alloc(width * height * 4);
  fillBackground(buffer, width, height, PLACEHOLDER_COLOR);
  // A short white dash: "no value yet".
  for (let y = 9; y < 11; y++) {
    for (let x = 6; x < 14; x++) {
      const offset = (y * width + x) * 4;
      buffer[offset] = 255; buffer[offset + 1] = 255; buffer[offset + 2] = 255; buffer[offset + 3] = 255;
    }
  }
  return ni.createFromBuffer(buffer, { width, height });
}

function badgeColor(slotId, percent, warnThreshold, dangerThreshold) {
  if (percent >= dangerThreshold) return DANGER_COLOR;
  if (percent >= warnThreshold) return WARN_COLOR;
  return BADGE_COLORS[slotId] || PLACEHOLDER_COLOR;
}

// "Current Session" → "Session", "5-Hour Limit" → "5-Hour", "Weekly Limit" → "Weekly".
function shortLabel(window, kind) {
  if (kind === 'weekly') return 'Weekly';
  const label = window && window.label ? String(window.label) : '';
  const trimmed = label.replace(/\s*Limit$/i, '').replace(/^Current\s+/i, '').trim();
  return trimmed || 'Session';
}

// Desired badge list, in creation order. Slots are keyed by provider + window *kind* (not window key),
// so Codex `primary`/`secondary` and Claude `session`/`weekly` map onto stable tray icons.
// Order: Codex badges then Claude badges; within a provider weekly first, then session.
function desiredBadges(snapshot, settings) {
  const mode = settings && settings.trayStats ? settings.trayStats : 'off';
  if (mode === 'off') return [];
  const enabledFlags = (settings && settings.providers) || {};
  const providerOrder = [];
  if (mode === 'codex' || mode === 'both') providerOrder.push('codex');
  if (mode === 'claude' || mode === 'both') providerOrder.push('claude');

  const badges = [];
  for (const providerId of providerOrder) {
    if (enabledFlags[providerId] === false) continue;
    const provider = snapshot && snapshot.providers ? snapshot.providers[providerId] : null;
    const windows = provider && Array.isArray(provider.windows) ? provider.windows : [];
    const weekly = windows.find((w) => w && w.kind === 'weekly') || null;
    const session = windows.find((w) => w && w.kind === 'session') || null;
    const hasData = windows.length > 0;
    // With data: one badge per existing window. Without data yet: two placeholders so the tray does
    // not jump around when the first snapshot arrives.
    if (!hasData || weekly) badges.push({ id: `${providerId}.weekly`, providerId, kind: 'weekly', window: weekly, provider });
    if (!hasData || session) badges.push({ id: `${providerId}.session`, providerId, kind: 'session', window: session, provider });
  }
  return badges;
}

function providerStatusText(provider) {
  if (!provider) return 'waiting for data';
  if (provider.status === 'auth_required') return (provider.error && provider.error.message) || 'sign-in required';
  if (provider.status === 'error') return (provider.error && provider.error.message) || 'error';
  return 'no data';
}

// Menu-bar text for macOS: one "NN%" per badge (✕ at ≥ 99 % like the Windows red-cross badge, "–" while a
// slot has no data). With both providers on, each group is prefixed by its provider name.
function menuBarTitle(badges) {
  const groups = new Map();
  for (const badge of badges) {
    const pct = badge.window ? Number(badge.window.percent) : NaN;
    const text = !badge.window ? '–' : !Number.isFinite(pct) ? '–' : pct >= 99 ? '✕' : `${Math.round(Math.max(0, pct))}%`;
    const name = (badge.provider && badge.provider.name) || PROVIDER_NAMES[badge.providerId] || badge.providerId;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(text);
  }
  const parts = [...groups.entries()].map(([name, texts]) => (groups.size > 1 ? `${name} ${texts.join('·')}` : texts.join(' · ')));
  return parts.join('  ');
}

function createTray({ onShow, onRefresh, onExit, onClick, getSettings, electron: deps, platform = process.platform } = {}) {
  const { Tray, Menu, nativeImage } = deps || electron();
  const settingsOf = typeof getSettings === 'function' ? getSettings : () => ({});
  const menuBarMode = platform === 'darwin';
  // Latched by destroy() (called from 'will-quit'). A refresh tick that was in flight when the app
  // began quitting still runs tray.update() afterwards; without the latch reconcile() would create
  // brand-new Tray icons during shutdown and leave ghost icons in the Windows notification area.
  let destroyed = false;
  const call = (fn) => { try { if (typeof fn === 'function') fn(); } catch (err) { console.error('[tray] callback failed:', err && err.message); } };
  const clickHandler = () => call(onClick || onShow);

  const trays = new Map(); // badge id → Tray
  let order = [];
  let lastSnapshot = null;
  let placeholderImage = null;

  function getPlaceholder() {
    if (placeholderImage) return placeholderImage;
    try {
      const fromFile = nativeImage.createFromPath(PLACEHOLDER_ICON_PATH);
      placeholderImage = fromFile && !fromFile.isEmpty() ? fromFile.resize({ width: 20, height: 20 }) : generatePlaceholderIcon(nativeImage);
    } catch (err) {
      placeholderImage = generatePlaceholderIcon(nativeImage);
    }
    return placeholderImage;
  }

  function buildMenu() {
    return Menu.buildFromTemplate([
      { label: 'Show Widget', click: () => call(onShow) },
      { label: 'Refresh', click: () => call(onRefresh) },
      { type: 'separator' },
      { label: menuBarMode ? 'Quit AI Usage Widget' : 'Exit', click: () => call(onExit) },
    ]);
  }

  // macOS: a single menu-bar item. Created when the badge list is non-empty, destroyed when it empties.
  let templateImage = null;
  function getTemplateImage() {
    if (templateImage) return templateImage;
    try {
      const img = nativeImage.createFromPath(TEMPLATE_ICON_PATH);
      if (img && !img.isEmpty()) {
        if (typeof img.setTemplateImage === 'function') img.setTemplateImage(true);
        templateImage = img;
      }
    } catch (err) { /* fall through to the generated placeholder */ }
    if (!templateImage) templateImage = getPlaceholder();
    return templateImage;
  }

  function reconcileMenuBar(badges, settings) {
    const existing = trays.get('menubar');
    if (badges.length === 0) {
      if (existing) { trays.delete('menubar'); order = []; destroyOne(existing); }
      return;
    }
    let tray = existing && !existing.isDestroyed() ? existing : null;
    if (!tray) {
      try {
        tray = new Tray(getTemplateImage());
        tray.setContextMenu(buildMenu());
        tray.on('click', clickHandler);
        trays.set('menubar', tray);
        order = ['menubar'];
      } catch (err) {
        console.error('[tray] failed to create menu-bar item:', err && err.message);
        return;
      }
    }
    try {
      if (typeof tray.setTitle === 'function') tray.setTitle(menuBarTitle(badges), { fontType: 'monospacedDigit' });
      const timeFormat = settings.timeFormat === '24h' ? '24h' : '12h';
      const lines = badges.map((badge) => {
        const providerName = (badge.provider && badge.provider.name) || PROVIDER_NAMES[badge.providerId] || badge.providerId;
        if (!badge.window) return `${providerName} ${badge.kind === 'weekly' ? 'Weekly' : 'Session'}: ${providerStatusText(badge.provider)}`;
        const pct = Number(badge.window.percent);
        let line = `${providerName} ${shortLabel(badge.window, badge.kind)}: ${Math.round(Number.isFinite(pct) ? Math.max(0, pct) : 0)}%`;
        const resetText = formatResetTime(badge.window.resetsAt, timeFormat, badge.kind !== 'session');
        if (resetText) line += ` (resets ${resetText})`;
        return line;
      });
      tray.setToolTip(lines.join('\n'));
    } catch (err) {
      console.error('[tray] failed to paint menu-bar item:', err && err.message);
    }
  }

  function destroyOne(tray) {
    if (!tray || tray.isDestroyed()) return;
    try {
      tray.removeAllListeners();
      tray.setContextMenu(null);
      tray.setToolTip('');
    } catch (err) { /* best effort */ }
    try { tray.destroy(); } catch (err) { console.error('[tray] destroy failed:', err && err.message); }
  }

  function destroyAll() {
    const existing = [...trays.values()];
    trays.clear();
    order = [];
    for (const tray of existing) destroyOne(tray);
  }

  function createBadges(badges) {
    const menu = buildMenu();
    for (const badge of badges) {
      try {
        const tray = new Tray(getPlaceholder());
        tray.setToolTip(`${PROVIDER_NAMES[badge.providerId] || badge.providerId} ${badge.kind === 'weekly' ? 'Weekly' : 'Session'}`);
        tray.setContextMenu(menu);
        tray.on('click', clickHandler);
        trays.set(badge.id, tray);
      } catch (err) {
        console.error(`[tray] failed to create tray icon ${badge.id}:`, err && err.message);
      }
    }
    order = badges.map((b) => b.id);
  }

  function paint(badge, settings) {
    const tray = trays.get(badge.id);
    if (!tray || tray.isDestroyed()) return;
    const providerName = (badge.provider && badge.provider.name) || PROVIDER_NAMES[badge.providerId] || badge.providerId;
    try {
      if (!badge.window) {
        tray.setImage(getPlaceholder());
        tray.setToolTip(`${providerName} ${badge.kind === 'weekly' ? 'Weekly' : 'Session'}: ${providerStatusText(badge.provider)}`);
        return;
      }
      const warn = Number.isFinite(Number(settings.warnThreshold)) ? Number(settings.warnThreshold) : 75;
      const danger = Number.isFinite(Number(settings.dangerThreshold)) ? Number(settings.dangerThreshold) : 90;
      const timeFormat = settings.timeFormat === '24h' ? '24h' : '12h';
      const pct = Number(badge.window.percent);
      const percent = Number.isFinite(pct) ? Math.max(0, pct) : 0;

      tray.setImage(percent >= 99 ? generateRedXIcon(nativeImage) : generatePercentageIcon(percent, badgeColor(badge.id, percent, warn, danger), nativeImage));

      let tooltip = `${providerName} ${shortLabel(badge.window, badge.kind)}: ${Math.round(percent)}%`;
      const resetText = formatResetTime(badge.window.resetsAt, timeFormat, badge.kind !== 'session');
      if (resetText) tooltip += `\nResets: ${resetText}`;
      if (badge.provider && badge.provider.status === 'stale') tooltip += '\n(last refresh failed — showing previous values)';
      tray.setToolTip(tooltip);
    } catch (err) {
      console.error(`[tray] failed to paint ${badge.id}:`, err && err.message);
    }
  }

  function reconcile() {
    const settings = settingsOf() || {};
    const badges = desiredBadges(lastSnapshot, settings);
    if (menuBarMode) {
      reconcileMenuBar(badges, settings);
      return;
    }
    const ids = badges.map((b) => b.id);
    const same = ids.length === order.length && ids.every((id, i) => id === order[i]) && ids.every((id) => trays.has(id) && !trays.get(id).isDestroyed());
    if (!same) {
      destroyAll();
      if (badges.length > 0) createBadges(badges);
    }
    for (const badge of badges) paint(badge, settings);
  }

  return {
    update(snapshot) {
      if (snapshot) lastSnapshot = snapshot;
      if (destroyed) return;
      reconcile();
    },
    rebuild() {
      if (destroyed) return;
      destroyAll();
      reconcile();
    },
    destroy() {
      destroyed = true;
      destroyAll();
    },
    isDestroyed() {
      return destroyed;
    },
    hasIcon() {
      for (const tray of trays.values()) if (tray && !tray.isDestroyed()) return true;
      return false;
    },
  };
}

module.exports = {
  createTray,
  // Exposed for reuse/tests.
  BITMAP_FONT,
  BITMAP_FONT_NARROW,
  drawChar,
  generatePercentageIcon,
  generateRedXIcon,
  desiredBadges,
  badgeColor,
  menuBarTitle,
};
