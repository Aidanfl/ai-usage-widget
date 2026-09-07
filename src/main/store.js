'use strict';
// Settings persistence (ARCHITECTURE.md §5). electron-store v8 → <userData>/config.json.
// Side effects of a settings change (window, tray, scheduler) live in main.js; this module only
// merges, validates and persists so it stays predictable and easy to reason about.

const Store = require('electron-store');

const SETTINGS_DEFAULTS = Object.freeze({
  autoStart: false,
  hideFromTaskbar: false,
  alwaysOnTop: true,
  theme: 'dark',
  background: 'acrylic',
  warnThreshold: 75,
  dangerThreshold: 90,
  timeFormat: '12h',
  dateFormat: 'date',
  usageAlerts: true,
  compactMode: false,
  refreshInterval: '120', // the Claude provider additionally enforces a 60 s floor between real usage requests
  graphVisible: false,
  expandedOpen: Object.freeze({ claude: false, codex: false }),
  providers: Object.freeze({ claude: true, codex: true }),
  claudeSource: 'claude_code',
  tokenAutoRefresh: true,
  trayStats: 'off',
  windowPosition: null,
  claudeOrganizationId: null,
});

const ENUMS = {
  theme: ['dark', 'light', 'system'],
  // 'acrylic' is "Smoky Acrylic" in the UI (stored value kept for compatibility with 0.1.0 configs);
  // 'acrylic_clear' is "Clear Acrylic" (same DWM material, light glass base, no tint, dark text).
  background: ['acrylic', 'acrylic_clear', 'mica', 'solid'],
  timeFormat: ['12h', '24h'],
  dateFormat: ['date', 'date-day', 'date-day-time'],
  claudeSource: ['claude_code', 'claude_web'],
  trayStats: ['off', 'claude', 'codex', 'both'],
  refreshInterval: ['15', '30', '60', '120', '300'],
};

const BOOLEAN_KEYS = ['autoStart', 'hideFromTaskbar', 'alwaysOnTop', 'usageAlerts', 'compactMode', 'graphVisible', 'tokenAutoRefresh'];
// Nested { claude: bool, codex: bool } maps — patches merge into them instead of replacing them.
const NESTED_BOOLEAN_KEYS = ['expandedOpen', 'providers'];

// conf rethrows the SyntaxError from a corrupt config.json (default clearInvalidConfig: false) — and the
// constructor reads the file — so without this a half-written/corrupt file crashes `require('./store')`
// on every launch. Losing the settings once beats a permanently unlaunchable widget.
const store = new Store({ clearInvalidConfig: true });

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// electron-store throws on `set(key, undefined)`, so undefined must never reach the merged object.
function stripUndefined(value) {
  if (Array.isArray(value)) return value.filter((v) => v !== undefined).map(stripUndefined);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || typeof v === 'function') continue;
    out[k] = stripUndefined(v);
  }
  return out;
}

function mergeSettings(base, patch) {
  const out = { ...base };
  if (!isPlainObject(patch)) return out;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (NESTED_BOOLEAN_KEYS.includes(key) && isPlainObject(value)) {
      out[key] = { ...(isPlainObject(base[key]) ? base[key] : {}), ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

function clampThreshold(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(99, Math.max(1, Math.round(n)));
}

// Coerces every known key to its contract type; unknown/invalid values fall back to `previous`
// (the last known-good value) so a bad patch can never poison the stored settings.
function sanitizeSettings(input, previous = SETTINGS_DEFAULTS) {
  const out = { ...input };

  for (const key of BOOLEAN_KEYS) {
    out[key] = typeof out[key] === 'boolean' ? out[key] : !!previous[key];
  }

  for (const [key, allowed] of Object.entries(ENUMS)) {
    let value = out[key];
    if (key === 'refreshInterval' && typeof value === 'number') value = String(value);
    out[key] = allowed.includes(value) ? value : (allowed.includes(previous[key]) ? previous[key] : SETTINGS_DEFAULTS[key]);
  }

  out.warnThreshold = clampThreshold(out.warnThreshold, previous.warnThreshold);
  out.dangerThreshold = clampThreshold(out.dangerThreshold, previous.dangerThreshold);
  if (out.warnThreshold > out.dangerThreshold) {
    [out.warnThreshold, out.dangerThreshold] = [out.dangerThreshold, out.warnThreshold];
  }

  for (const key of NESTED_BOOLEAN_KEYS) {
    const defaults = SETTINGS_DEFAULTS[key];
    const source = isPlainObject(out[key]) ? out[key] : (isPlainObject(previous[key]) ? previous[key] : defaults);
    const cleaned = {};
    for (const [id, enabled] of Object.entries({ ...defaults, ...source })) {
      cleaned[id] = typeof enabled === 'boolean' ? enabled : !!defaults[id];
    }
    out[key] = cleaned;
  }

  const pos = out.windowPosition;
  if (isPlainObject(pos) && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y))) {
    out.windowPosition = { x: Math.round(Number(pos.x)), y: Math.round(Number(pos.y)) };
  } else {
    out.windowPosition = pos === null ? null : (previous.windowPosition ?? null);
  }

  out.claudeOrganizationId = typeof out.claudeOrganizationId === 'string' && out.claudeOrganizationId
    ? out.claudeOrganizationId
    : null;

  return stripUndefined(out);
}

// hideFromTaskbar without a tray icon would leave no way back to the window, so the two settings
// are coupled exactly like the original widget's UI did: hiding forces tray stats on, and turning
// tray stats off releases the taskbar hide. When a single patch says both, the "off" wins (safer).
function applyCoupling(merged, patch) {
  if (patch.trayStats === 'off' && merged.hideFromTaskbar) {
    merged.hideFromTaskbar = false;
  } else if (merged.hideFromTaskbar && merged.trayStats === 'off') {
    merged.trayStats = 'both';
  }
  return merged;
}

function getSettings() {
  let stored = {};
  try {
    stored = store.get('settings', {});
  } catch (err) {
    console.error('[store] failed to read settings, using defaults:', err && err.message);
  }
  return sanitizeSettings(mergeSettings(SETTINGS_DEFAULTS, isPlainObject(stored) ? stored : {}), SETTINGS_DEFAULTS);
}

function saveSettings(patch) {
  const current = getSettings();
  const cleanPatch = isPlainObject(patch) ? stripUndefined(patch) : {};
  const merged = applyCoupling(sanitizeSettings(mergeSettings(current, cleanPatch), current), cleanPatch);
  store.set('settings', merged);
  return merged;
}

module.exports = {
  store,
  SETTINGS_DEFAULTS,
  getSettings,
  saveSettings,
  // Exposed for tests / other main modules that need the pure pieces.
  mergeSettings,
  sanitizeSettings,
  stripUndefined,
};
