'use strict';
// Settings persistence (ARCHITECTURE.md §5). electron-store v8 → <userData>/config.json.
// Side effects of a settings change (window, tray, scheduler) live in main.js; this module only
// merges, validates and persists so it stays predictable and easy to reason about.

const Store = require('electron-store');
const { validateRelayUrl } = require('./sync'); // pure; the single source of truth for relay URL rules
// Pure; every rule about the Claude account list lives there (and is unit-tested there, since this module
// needs Electron to load).
const { defaultAccounts, sanitizeAccounts, migrateLegacyAccounts, applyLegacyAccountPatch, pruneAccountFlags } = require('./accounts');

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
  // Several Claude accounts (accounts.js). Account 1 keeps the provider id 'claude'; visibility and expand
  // state of account N live under providers['claude-N'] / expandedOpen['claude-N'] (absent = default).
  claudeAccounts: Object.freeze(defaultAccounts().map((a) => Object.freeze(a))),
  // Legacy single-source keys, always mirrored from account 1 by sanitizeSettings (1.0.x readers).
  claudeSource: 'claude_code',
  tokenAutoRefresh: true,
  trayStats: 'off',
  windowPosition: null,
  claudeOrganizationId: null,
  // Phone sync (docs/PHONE-SYNC.md). The pair key is NOT a setting: main.js keeps it safeStorage-encrypted
  // under the top-level `phonePairKey` store key so it never travels to the renderer.
  phoneSyncEnabled: false,
  phoneRelayUrl: '',
});

const ENUMS = {
  theme: ['dark', 'light', 'system'],
  // 'acrylic' is "Smoky Acrylic" in the UI (stored value kept for compatibility with 0.1.0 configs);
  // 'acrylic_clear' is "Clear Acrylic" (same DWM material, light glass base, no tint, dark text).
  background: ['acrylic', 'acrylic_clear', 'mica', 'solid'],
  timeFormat: ['12h', '24h'],
  dateFormat: ['date', 'date-day', 'date-day-time'],
  claudeSource: ['claude_code', 'claude_web', 'claude_keychain'],
  trayStats: ['off', 'claude', 'codex', 'both'],
  refreshInterval: ['15', '30', '60', '120', '300'],
};

const BOOLEAN_KEYS = ['autoStart', 'hideFromTaskbar', 'alwaysOnTop', 'usageAlerts', 'compactMode', 'graphVisible', 'tokenAutoRefresh', 'phoneSyncEnabled'];
// Nested { claude: bool, codex: bool, 'claude-2': bool, … } maps — patches merge into them instead of
// replacing them. Every other key, arrays included (claudeAccounts), is replaced by a patch.
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

  // 0.2.1 made the time part of a weekly "resets at" cell unconditional, so 'date-day-time' (which used to
  // add it, on two lines) now means exactly 'date-day'. The value stays in ENUMS so an existing config
  // validates, and is migrated here instead of being reset to the default.
  if (out.dateFormat === 'date-day-time') out.dateFormat = 'date-day';

  out.warnThreshold = clampThreshold(out.warnThreshold, previous.warnThreshold);
  out.dangerThreshold = clampThreshold(out.dangerThreshold, previous.dangerThreshold);
  if (out.warnThreshold > out.dangerThreshold) {
    [out.warnThreshold, out.dangerThreshold] = [out.dangerThreshold, out.warnThreshold];
  }

  // Account 1 always exists and comes first; the legacy keys are its mirror, never an independent value.
  out.claudeAccounts = sanitizeAccounts(out.claudeAccounts, previous.claudeAccounts);
  out.claudeSource = out.claudeAccounts[0].source;
  out.claudeOrganizationId = out.claudeAccounts[0].organizationId;

  for (const key of NESTED_BOOLEAN_KEYS) {
    const defaults = SETTINGS_DEFAULTS[key];
    const source = isPlainObject(out[key]) ? out[key] : (isPlainObject(previous[key]) ? previous[key] : defaults);
    const cleaned = {};
    for (const [id, enabled] of Object.entries({ ...defaults, ...source })) {
      cleaned[id] = typeof enabled === 'boolean' ? enabled : !!defaults[id];
    }
    // A removed account must not leave its hidden / expanded flag behind for the next account in that slot.
    out[key] = pruneAccountFlags(cleaned, out.claudeAccounts);
  }

  const pos = out.windowPosition;
  if (isPlainObject(pos) && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y))) {
    out.windowPosition = { x: Math.round(Number(pos.x)), y: Math.round(Number(pos.y)) };
  } else {
    out.windowPosition = pos === null ? null : (previous.windowPosition ?? null);
  }

  // Stored normalized (https only, http for localhost, trailing slash stripped, ≤ 512 chars) or '' when
  // invalid — the renderer validates before saving, so '' here means "cleared", never a silent fallback.
  out.phoneRelayUrl = typeof out.phoneRelayUrl === 'string' ? (validateRelayUrl(out.phoneRelayUrl) || '') : '';

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
  const raw = isPlainObject(stored) ? stored : {};
  // 1.0.x configs have no claudeAccounts: the legacy single-source keys become account 1. The migrated list
  // is the sanitize baseline, so it also stands in for an account 1 (or a field of it) a stored list lost.
  const merged = mergeSettings(SETTINGS_DEFAULTS, raw);
  merged.claudeAccounts = raw.claudeAccounts;
  return sanitizeSettings(merged, { ...SETTINGS_DEFAULTS, claudeAccounts: migrateLegacyAccounts(raw) });
}

function saveSettings(patch) {
  const current = getSettings();
  const cleanPatch = isPlainObject(patch) ? stripUndefined(patch) : {};
  const next = mergeSettings(current, cleanPatch);
  // claudeAccounts in a patch replaces the whole list (mergeSettings); 1.0.x callers that only send
  // claudeSource / claudeOrganizationId change account 1, and sanitize mirrors account 1 back to those keys.
  next.claudeAccounts = applyLegacyAccountPatch(next.claudeAccounts, cleanPatch);
  const merged = applyCoupling(sanitizeSettings(next, current), cleanPatch);
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
