'use strict';
// Refresh loop (ARCHITECTURE.md §6 "Scheduler"). One timer; each tick fetches every enabled provider
// with Promise.allSettled, builds a Snapshot (last-good values marked `stale` when a provider fails),
// then runs history → tray → alerts → onSnapshot. Nothing in here may throw into the caller.

const PROVIDER_IDS = ['claude', 'codex'];
const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S = 15;
const MAX_INTERVAL_S = 3600;
// Providers own their 15 s request timeouts; this is only a backstop so a hung provider can never
// wedge the in-flight guard forever.
const PROVIDER_DEADLINE_MS = 60000;

function normalizeLog(log) {
  const base = typeof log === 'function' ? log : (log && typeof log.info === 'function' ? log.info.bind(log) : (...a) => console.log(...a));
  const pick = (name, fallback) => (log && typeof log[name] === 'function' ? log[name].bind(log) : fallback);
  return {
    info: base,
    warn: pick('warn', (...a) => console.warn(...a)),
    error: pick('error', (...a) => console.error(...a)),
    debug: pick('debug', () => {}),
  };
}

// Providers receive a callable `log(...)` that also carries .warn/.error/.debug — both call styles work.
function childLog(logger, prefix) {
  const fn = (...args) => logger.info(`[${prefix}]`, ...args);
  fn.info = fn;
  fn.warn = (...args) => logger.warn(`[${prefix}]`, ...args);
  fn.error = (...args) => logger.error(`[${prefix}]`, ...args);
  fn.debug = (...args) => logger.debug(`[${prefix}]`, ...args);
  return fn;
}

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Provider did not respond within ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([Promise.resolve(promise), deadline]).finally(() => clearTimeout(timer));
}

function classifyError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  if ((err && err.name === 'AbortError') || msg.includes('timed out') || msg.includes('did not respond')) return 'network';
  if (msg.includes('fetch failed') || msg.includes('econn') || msg.includes('enotfound') || msg.includes('network')) return 'network';
  return 'internal';
}

function safeMessage(err) {
  const msg = String((err && err.message) || err || 'Unknown error');
  return msg.length > 300 ? `${msg.slice(0, 297)}...` : msg;
}

function failureSnapshot(provider, err, code) {
  return {
    id: provider.id,
    name: provider.name || provider.id,
    status: 'error',
    error: { code: code || classifyError(err), message: safeMessage(err) },
    source: provider.source || null,
    plan: null,
    account: null,
    updatedAt: 0,
    windows: [],
    extra: null,
    credits: null,
    raw: {},
  };
}

// IPC uses structured clone; anything exotic a provider leaves in `raw` (Error, Buffer, cycles)
// would make every `usage-updated` send throw. A JSON round-trip keeps snapshots plain.
function toPlain(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (err) {
    const { raw, ...rest } = value || {};
    try {
      return JSON.parse(JSON.stringify({ ...rest, raw: {} }));
    } catch (err2) {
      return null;
    }
  }
}

function createScheduler({ providers = [], getSettings, onSnapshot, history, tray, alerts, log, now = Date.now, fetch: fetchImpl } = {}) {
  const logger = normalizeLog(log);
  const lastGood = new Map();   // provider id → last ProviderSnapshot with status 'ok'
  // Provider ids whose next *automatic* tick is skipped (§6: HTTP 429 → keep last good, skip next
  // cycle). Providers ask for this with `skipNextCycle: true` on the snapshot they return.
  const skipNext = new Set();
  let lastSnapshot = null;
  let timer = null;
  let running = false;
  let inFlight = null;
  let intervalMs = DEFAULT_INTERVAL_S * 1000;

  function settingsSafe() {
    try {
      return (typeof getSettings === 'function' && getSettings()) || {};
    } catch (err) {
      logger.error('getSettings failed:', safeMessage(err));
      return {};
    }
  }

  // `providers` may be an array or a function returning one, so main.js can swap the Claude
  // implementation (claude_code vs claude_web) without rebuilding the scheduler.
  function resolveProviders() {
    let list;
    try {
      list = typeof providers === 'function' ? providers() : providers;
    } catch (err) {
      logger.error('provider resolution failed:', safeMessage(err));
      list = [];
    }
    return (Array.isArray(list) ? list : []).filter((p) => p && typeof p.id === 'string' && typeof p.fetchSnapshot === 'function');
  }

  function isEnabled(settings, id) {
    const flags = settings && settings.providers;
    return !flags || typeof flags !== 'object' || flags[id] !== false;
  }

  function coerce(provider, result) {
    if (!result || typeof result !== 'object' || typeof result.status !== 'string' || !Array.isArray(result.windows)) {
      return failureSnapshot(provider, new Error('Provider returned an invalid snapshot'), 'parse');
    }
    // `skipNextCycle` is a scheduler hint, not part of the §3 ProviderSnapshot shape: consume it here.
    const { skipNextCycle, ...rest } = result;
    if (skipNextCycle === true) skipNext.add(provider.id);
    return {
      ...rest,
      id: provider.id,
      name: result.name || provider.name || provider.id,
      error: result.error === undefined ? null : result.error,
      source: result.source === undefined ? (provider.source || null) : result.source,
      plan: result.plan === undefined ? null : result.plan,
      account: result.account === undefined ? null : result.account,
      updatedAt: typeof result.updatedAt === 'number' ? result.updatedAt : 0,
      extra: result.extra === undefined ? null : result.extra,
      credits: result.credits === undefined ? null : result.credits,
      raw: result.raw === undefined ? {} : result.raw,
    };
  }

  // Applies the last-good policy: a failed cycle with previous data becomes `stale` carrying the old
  // windows; auth_required passes through untouched (the renderer must show the sign-in state).
  function finalize(provider, snap, prevGood) {
    if (snap.status === 'ok') {
      if (!snap.updatedAt) snap.updatedAt = now();
      const plain = toPlain(snap) || snap;
      lastGood.set(provider.id, plain);
      return plain;
    }
    if (snap.status === 'error' && prevGood) {
      return toPlain({
        ...prevGood,
        status: 'stale',
        error: snap.error || { code: 'network', message: 'Refresh failed; showing last known values' },
      }) || prevGood;
    }
    if (snap.status === 'stale' && snap.windows.length === 0 && prevGood) {
      return toPlain({ ...prevGood, status: 'stale', error: snap.error || null }) || prevGood;
    }
    return toPlain(snap) || failureSnapshot(provider, new Error('Snapshot could not be serialized'), 'parse');
  }

  async function runProvider(provider, settings) {
    const prevGood = lastGood.get(provider.id) || null;
    const context = {
      settings,
      fetch: fetchImpl || globalThis.fetch,
      now,
      log: childLog(logger, provider.id),
      lastGood: prevGood,
    };
    let result;
    try {
      result = await withDeadline(provider.fetchSnapshot(context), PROVIDER_DEADLINE_MS);
    } catch (err) {
      logger.warn(`[${provider.id}] fetchSnapshot threw:`, safeMessage(err));
      result = failureSnapshot(provider, err);
    }
    return finalize(provider, coerce(provider, result), prevGood);
  }

  function safeStep(name, fn) {
    try {
      fn();
    } catch (err) {
      logger.error(`${name} step failed:`, safeMessage(err));
    }
  }

  function emptySnapshot() {
    return { fetchedAt: now(), providers: { claude: null, codex: null } };
  }

  function tick(reason) {
    if (inFlight) {
      logger.debug(`tick (${reason}) skipped: refresh already in flight`);
      return inFlight;
    }
    inFlight = (async () => {
      const settings = settingsSafe();
      const enabled = resolveProviders().filter((p) => isEnabled(settings, p.id));

      // A provider that was rate-limited last time sits out one automatic tick and keeps showing its
      // previous (stale) entry. Manual/start/resume ticks always run everything.
      const previous = lastSnapshot && lastSnapshot.providers ? lastSnapshot.providers : {};
      const carried = new Map();
      const toRun = [];
      for (const p of enabled) {
        if (reason === 'interval' && skipNext.has(p.id) && previous[p.id]) {
          carried.set(p.id, previous[p.id]);
          logger.debug(`[${p.id}] sitting out this cycle after a rate-limit response`);
        } else {
          toRun.push(p);
        }
      }
      skipNext.clear();

      const settled = await Promise.allSettled(toRun.map((p) => runProvider(p, settings)));

      const providersOut = {};
      for (const id of PROVIDER_IDS) providersOut[id] = null;
      settled.forEach((outcome, i) => {
        const provider = toRun[i];
        providersOut[provider.id] = outcome.status === 'fulfilled'
          ? outcome.value
          : failureSnapshot(provider, outcome.reason);
      });
      for (const [id, snap] of carried) providersOut[id] = snap;

      const snapshot = { fetchedAt: now(), providers: providersOut };
      lastSnapshot = snapshot;

      safeStep('history', () => history && history.append(snapshot));
      safeStep('tray', () => tray && tray.update(snapshot));
      safeStep('alerts', () => alerts && alerts.evaluate(snapshot, settings));
      safeStep('onSnapshot', () => onSnapshot && onSnapshot(snapshot));
      logger.debug(`tick (${reason}) done:`, Object.entries(providersOut).map(([id, p]) => `${id}=${p ? p.status : 'off'}`).join(' '));
      return snapshot;
    })()
      .catch((err) => {
        logger.error('tick failed:', safeMessage(err));
        return lastSnapshot || emptySnapshot();
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => { tick('interval'); }, intervalMs);
  }

  function start() {
    if (running) return;
    running = true;
    schedule();
    tick('start');
  }

  function stop() {
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
  }

  // Manual refresh runs now and restarts the timer so the next automatic tick is a full interval away.
  function refreshNow() {
    const result = tick('manual');
    if (running) schedule();
    return result;
  }

  function applyInterval(seconds) {
    const n = Number(seconds);
    const clamped = Number.isFinite(n) && n > 0 ? Math.min(MAX_INTERVAL_S, Math.max(MIN_INTERVAL_S, Math.round(n))) : DEFAULT_INTERVAL_S;
    intervalMs = clamped * 1000;
    if (running) schedule();
    return clamped;
  }

  applyInterval(parseInt(settingsSafe().refreshInterval, 10));

  // Drops the last-good memory for one provider id. main.js calls it when the Claude *source*
  // changes so claude_web never shows claude_code's values as "stale" (or vice versa).
  function forgetProvider(id) {
    lastGood.delete(id);
    skipNext.delete(id);
  }

  return {
    start,
    stop,
    refreshNow,
    getLastSnapshot: () => lastSnapshot,
    applyInterval,
    forgetProvider,
    isRefreshing: () => inFlight !== null,
  };
}

module.exports = { createScheduler, failureSnapshot, toPlain };
