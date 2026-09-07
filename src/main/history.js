'use strict';
// Usage history (ARCHITECTURE.md §7). Pure factory: storage (get/set) and the clock are injected so
// the logic runs in `node --test` without Electron. Samples are `{ t, v: { '<provider>.<windowKey>': pct } }`.

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 8 * DAY_MS;
const MAX_SAMPLES = 10000;
const DEFAULT_CHART_DAYS = 7;

// A provider whose fetch failed this cycle contributes no sample: `stale` re-samples old values at a
// new timestamp (a flat line that lies), and auth/error states carry no data. The chart shows a gap.
const SKIPPED_STATUSES = new Set(['auth_required', 'error', 'stale']);
const EXTRA_COLOR = 'rose';

function isSample(sample) {
  return !!sample
    && typeof sample.t === 'number' && Number.isFinite(sample.t)
    && !!sample.v && typeof sample.v === 'object' && !Array.isArray(sample.v);
}

function roundPercent(value) {
  return Math.round(value * 10) / 10;
}

function providerHasResetTimestamps(provider) {
  return Array.isArray(provider.windows) && provider.windows.some((w) => w && typeof w.resetsAt === 'string' && w.resetsAt);
}

// Builds the `v` map for one snapshot; returns null when no provider produced usable data
// (dead-session heuristic from the original: a live account always has reset timestamps).
function buildValues(snapshot) {
  if (!snapshot || !snapshot.providers || typeof snapshot.providers !== 'object') return null;
  const values = {};
  for (const provider of Object.values(snapshot.providers)) {
    if (!provider || typeof provider.id !== 'string') continue;
    if (SKIPPED_STATUSES.has(provider.status)) continue;
    if (!providerHasResetTimestamps(provider)) continue;

    for (const window of provider.windows) {
      if (!window || typeof window.key !== 'string') continue;
      const percent = Number(window.percent);
      if (!Number.isFinite(percent)) continue;
      values[`${provider.id}.${window.key}`] = roundPercent(percent);
    }
    if (provider.extra && typeof provider.extra.percent === 'number' && Number.isFinite(provider.extra.percent)) {
      values[`${provider.id}.extra`] = roundPercent(provider.extra.percent);
    }
  }
  return Object.keys(values).length > 0 ? values : null;
}

function prune(samples, nowMs) {
  const cutoff = nowMs - RETENTION_MS;
  let kept = samples.filter((s) => s.t > cutoff);
  if (kept.length > MAX_SAMPLES) kept = kept.slice(kept.length - MAX_SAMPLES);
  return kept;
}

function humanizeKey(key) {
  const [provider, ...rest] = key.split('.');
  const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const windowPart = rest.join('.').split('_').map(capitalize).join(' ');
  return `${capitalize(provider)} ${windowPart}`.trim();
}

// Series descriptors give the chart names/colours. The latest snapshot is authoritative; keys that
// only exist in older samples (a window that has since disappeared) get a neutral descriptor so
// the chart never drops stored data silently.
function buildSeries(latestSnapshot, samples) {
  const series = [];
  const seen = new Set();
  const push = (descriptor) => {
    if (seen.has(descriptor.key)) return;
    seen.add(descriptor.key);
    series.push(descriptor);
  };

  const providers = latestSnapshot && latestSnapshot.providers ? Object.values(latestSnapshot.providers) : [];
  for (const provider of providers) {
    if (!provider || typeof provider.id !== 'string') continue;
    const name = provider.name || humanizeKey(provider.id);
    for (const window of Array.isArray(provider.windows) ? provider.windows : []) {
      if (!window || typeof window.key !== 'string') continue;
      push({ key: `${provider.id}.${window.key}`, label: `${name} ${window.label || window.key}`, color: window.color || 'slate' });
    }
    if (provider.extra) {
      push({ key: `${provider.id}.extra`, label: `${name} Extra Usage`, color: EXTRA_COLOR });
    }
  }

  const leftovers = new Set();
  for (const sample of samples) {
    for (const key of Object.keys(sample.v)) if (!seen.has(key)) leftovers.add(key);
  }
  for (const key of [...leftovers].sort()) push({ key, label: humanizeKey(key), color: 'slate' });

  return series;
}

function createHistory({ get, set, now = Date.now } = {}) {
  if (typeof get !== 'function' || typeof set !== 'function') {
    throw new TypeError('createHistory requires get() and set() storage functions');
  }

  function load() {
    let raw;
    try {
      raw = get();
    } catch (err) {
      return [];
    }
    return Array.isArray(raw) ? raw.filter(isSample) : [];
  }

  function append(snapshot) {
    const values = buildValues(snapshot);
    if (!values) return false;
    const t = now();
    const samples = load();
    samples.push({ t, v: values });
    set(prune(samples, t));
    return true;
  }

  function getHistory(days = DEFAULT_CHART_DAYS, latestSnapshot = null) {
    const span = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : DEFAULT_CHART_DAYS;
    const cutoff = now() - span * DAY_MS;
    const samples = load().filter((s) => s.t > cutoff).sort((a, b) => a.t - b.t);
    return { samples, series: buildSeries(latestSnapshot, samples) };
  }

  function pruneAll() {
    const samples = load();
    const kept = prune(samples, now());
    if (kept.length !== samples.length) set(kept);
    return kept.length;
  }

  return { append, get: getHistory, pruneAll };
}

module.exports = {
  createHistory,
  RETENTION_MS,
  MAX_SAMPLES,
  DEFAULT_CHART_DAYS,
  // Exposed for tests.
  buildValues,
  buildSeries,
};
