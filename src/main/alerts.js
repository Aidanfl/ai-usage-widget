'use strict';
// Alert state machine (ARCHITECTURE.md §11). Pure: `notify(title, body)` and the clock are injected,
// so main.js plugs in Electron's Notification and tests plug in a spy.
//
// Per `provider.windowKey` we track one cycle (keyed by `resetsAt`) with three latched flags:
// warned → dangered → blocked. Each latch fires at most once per cycle; a new `resetsAt` re-arms.
// "Available again" fires once when a window that was blocked (this cycle or the previous one)
// is no longer blocked AND no other window of the same provider is blocked.

const DEFAULT_WARN = 75;
const DEFAULT_DANGER = 90;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Shared with tray.js so tooltips and toasts format reset times identically.
function formatResetTime(resetsAt, timeFormat = '12h', includeDate = false) {
  if (!resetsAt) return null;
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return null;
  const minutes = String(date.getMinutes()).padStart(2, '0');
  let time;
  if (timeFormat === '24h') {
    time = `${String(date.getHours()).padStart(2, '0')}:${minutes}`;
  } else {
    const hours = date.getHours();
    time = `${hours % 12 || 12}:${minutes} ${hours >= 12 ? 'PM' : 'AM'}`;
  }
  return includeDate ? `${MONTHS[date.getMonth()]} ${date.getDate()}, ${time}` : time;
}

function threshold(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function createAlertEngine({ notify, now = Date.now } = {}) {
  const send = typeof notify === 'function' ? notify : () => {};
  // 'provider.windowKey' → { cycle, warned, dangered, blocked }
  const windowStates = new Map();
  // A provider's first evaluation seeds its latches silently (port of the original): launching the
  // widget while already at 80% should not toast about a state the user is looking at.
  const seededProviders = new Set();

  function evaluate(snapshot, settings = {}) {
    const fired = [];
    if (!snapshot || !snapshot.providers || typeof snapshot.providers !== 'object') return fired;

    const warnAt = threshold(settings.warnThreshold, DEFAULT_WARN);
    const dangerAt = threshold(settings.dangerThreshold, DEFAULT_DANGER);
    const alertsEnabled = settings.usageAlerts !== false;
    const timeFormat = settings.timeFormat === '24h' ? '24h' : '12h';

    for (const provider of Object.values(snapshot.providers)) {
      if (!provider || typeof provider.id !== 'string' || !Array.isArray(provider.windows)) continue;
      if (provider.status === 'auth_required' || provider.status === 'error') continue;

      const silent = !alertsEnabled || !seededProviders.has(provider.id);
      const name = provider.name || provider.id;
      const emit = (title, body) => {
        if (silent) return;
        fired.push({ title, body });
        try { send(title, body); } catch (err) { /* a broken notifier must never break polling */ }
      };

      // Codex reports limit_reached at provider level; normalize.js also marks windows `blocked`.
      const providerBlocked = !!(provider.credits && provider.credits.limitReached);

      const evaluated = [];
      for (const window of provider.windows) {
        if (!window || typeof window.key !== 'string') continue;
        const id = `${provider.id}.${window.key}`;
        const pct = Number(window.percent);
        const percent = Number.isFinite(pct) ? pct : 0;
        const cycle = typeof window.resetsAt === 'string' && window.resetsAt ? window.resetsAt : null;

        let state = windowStates.get(id);
        let wasBlocked = false;
        if (!state) {
          state = { cycle, warned: false, dangered: false, blocked: false };
          windowStates.set(id, state);
        } else if (state.cycle !== cycle) {
          // New reset cycle: remember whether the old one ended blocked, then re-arm every latch.
          wasBlocked = state.blocked;
          state.cycle = cycle;
          state.warned = false;
          state.dangered = false;
          state.blocked = false;
        } else {
          wasBlocked = state.blocked;
        }

        const isBlocked = percent >= 100 || window.severity === 'blocked' || providerBlocked;
        evaluated.push({ window, state, percent, isBlocked, wasBlocked });
      }

      // Pass 1 — escalations. Blocked events are grouped per provider so Codex's "limit reached"
      // (which blocks every window at once) produces one toast, not one per window.
      const newlyBlocked = [];
      for (const item of evaluated) {
        const { window, state, percent, isBlocked } = item;
        const label = window.label || window.key;
        if (isBlocked) {
          if (!state.blocked) {
            state.blocked = true;
            state.dangered = true;
            state.warned = true;
            newlyBlocked.push(item);
          }
        } else if (percent >= dangerAt) {
          if (!state.dangered) {
            state.dangered = true;
            state.warned = true;
            emit(`${name} · ${label} at ${Math.round(percent)}%`, `Nearly exhausted (danger threshold ${dangerAt}%).`);
          }
        } else if (percent >= warnAt) {
          if (!state.warned) {
            state.warned = true;
            emit(`${name} · ${label} at ${Math.round(percent)}%`, `Approaching your limit (warning threshold ${warnAt}%).`);
          }
        }
      }
      if (newlyBlocked.length > 0) {
        const labels = newlyBlocked.map((i) => i.window.label || i.window.key);
        const soonest = newlyBlocked
          .map((i) => i.window.resetsAt)
          .filter((r) => typeof r === 'string' && r && !Number.isNaN(new Date(r).getTime()))
          .sort((a, b) => new Date(a) - new Date(b))[0];
        const resetText = soonest ? ` Resets ${formatResetTime(soonest, timeFormat, true)}.` : '';
        if (newlyBlocked.length === 1) {
          const { window, percent } = newlyBlocked[0];
          emit(`${name} · ${labels[0]} reached`, `Usage is blocked at ${Math.round(percent)}%.${resetText}`);
        } else {
          emit(`${name} · limits reached`, `${labels.join(', ')} are at their limit.${resetText}`);
        }
      }

      // Pass 2 — availability. Only when nothing of this provider is blocked anymore, once per provider.
      const anyBlockedNow = evaluated.some((i) => i.isBlocked);
      const recovered = [];
      for (const item of evaluated) {
        if (item.wasBlocked && !item.isBlocked) {
          item.state.blocked = false;
          recovered.push(item.window.label || item.window.key);
        }
      }
      if (recovered.length > 0 && !anyBlockedNow) {
        emit(`${name} · usage available again`, `${recovered.join(', ')} ${recovered.length === 1 ? 'has' : 'have'} reset.`);
      }

      seededProviders.add(provider.id);
    }

    return fired;
  }

  function reset() {
    windowStates.clear();
    seededProviders.clear();
  }

  return { evaluate, reset };
}

module.exports = { createAlertEngine, formatResetTime };
