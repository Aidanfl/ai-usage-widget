'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHistory, RETENTION_MS, MAX_SAMPLES } = require('../src/main/history');

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_788_700_000_000;

function win(key, percent, extra = {}) {
  return {
    key,
    label: extra.label || key,
    kind: extra.kind || 'other',
    percent,
    resetsAt: extra.resetsAt === undefined ? '2026-09-07T13:59:00.000Z' : extra.resetsAt,
    windowSeconds: null,
    severity: null,
    isActive: null,
    color: extra.color || 'slate',
    scope: null,
  };
}

function provider(id, windows, overrides = {}) {
  return {
    id,
    name: id === 'claude' ? 'Claude' : 'Codex',
    status: 'ok',
    error: null,
    source: id === 'claude' ? 'claude_code' : 'codex_auth_file',
    plan: null,
    account: null,
    updatedAt: T0,
    windows,
    extra: null,
    credits: null,
    raw: {},
    ...overrides,
  };
}

function snapshot(claude, codex) {
  return { fetchedAt: T0, providers: { claude, codex } };
}

function harness(initial = [], startTime = T0) {
  let stored = initial;
  let nowMs = startTime;
  const history = createHistory({
    get: () => stored,
    set: (arr) => { stored = arr; },
    now: () => nowMs,
  });
  return { history, get stored() { return stored; }, advance: (ms) => { nowMs += ms; }, setNow: (ms) => { nowMs = ms; } };
}

test('append builds <provider>.<windowKey> keys plus claude.extra when extra.percent is a number', () => {
  const h = harness();
  const claude = provider('claude', [
    win('session', 12.34, { label: 'Current Session', kind: 'session', color: 'purple' }),
    win('weekly', 40, { label: 'Weekly Limit', kind: 'weekly', color: 'blue' }),
  ], { extra: { enabled: true, percent: 5.55 } });
  const codex = provider('codex', [win('primary', 3, { label: '5-Hour Limit', kind: 'session', color: 'green' })]);

  assert.equal(h.history.append(snapshot(claude, codex)), true);
  assert.equal(h.stored.length, 1);
  assert.equal(h.stored[0].t, T0);
  assert.deepEqual(h.stored[0].v, {
    'claude.session': 12.3,
    'claude.weekly': 40,
    'claude.extra': 5.6,
    'codex.primary': 3,
  });
});

test('append omits claude.extra when extra.percent is not a number', () => {
  const h = harness();
  const claude = provider('claude', [win('weekly', 40)], { extra: { enabled: false, percent: null } });
  h.history.append(snapshot(claude, null));
  assert.deepEqual(Object.keys(h.stored[0].v), ['claude.weekly']);
});

test('append skips providers with auth_required, error or stale status but keeps the others', () => {
  const h = harness();
  const claude = provider('claude', [win('weekly', 40)], { status: 'auth_required', windows: [] });
  const codex = provider('codex', [win('primary', 7)]);
  h.history.append(snapshot(claude, codex));
  assert.deepEqual(h.stored[0].v, { 'codex.primary': 7 });

  const h2 = harness();
  h2.history.append(snapshot(provider('claude', [win('weekly', 40)], { status: 'error' }), provider('codex', [win('primary', 7)], { status: 'stale' })));
  assert.equal(h2.stored.length, 0, 'nothing appended when every provider is failed/stale');
});

test('append skips a provider whose windows carry no reset timestamps (dead-session heuristic)', () => {
  const h = harness();
  const dead = provider('claude', [win('session', 0, { resetsAt: null }), win('weekly', 0, { resetsAt: null })]);
  const codex = provider('codex', [win('primary', 9)]);
  h.history.append(snapshot(dead, codex));
  assert.deepEqual(h.stored[0].v, { 'codex.primary': 9 });
});

test('append returns false and writes nothing when no provider has usable data', () => {
  let writes = 0;
  const history = createHistory({ get: () => [], set: () => { writes += 1; }, now: () => T0 });
  assert.equal(history.append(snapshot(null, null)), false);
  assert.equal(history.append(null), false);
  assert.equal(writes, 0);
});

test('append prunes samples older than 8 days and caps at 10 000 samples', () => {
  const old = { t: T0 - RETENTION_MS - 1, v: { 'claude.weekly': 1 } };
  const edge = { t: T0 - RETENTION_MS + 1, v: { 'claude.weekly': 2 } };
  const h = harness([old, edge]);
  h.history.append(snapshot(provider('claude', [win('weekly', 3)]), null));
  assert.deepEqual(h.stored.map((s) => s.v['claude.weekly']), [2, 3]);

  const many = Array.from({ length: MAX_SAMPLES + 5 }, (_, i) => ({ t: T0 - 1000 + i, v: { 'claude.weekly': i } }));
  const h2 = harness(many);
  h2.history.append(snapshot(provider('claude', [win('weekly', 99)]), null));
  assert.equal(h2.stored.length, MAX_SAMPLES);
  assert.equal(h2.stored[MAX_SAMPLES - 1].v['claude.weekly'], 99, 'newest sample survives the cap');
  assert.equal(h2.stored[0].v['claude.weekly'], 6, 'oldest samples are dropped first');
});

test('get(days) returns only samples inside the window, sorted ascending', () => {
  const samples = [
    { t: T0 - 6 * DAY, v: { 'claude.weekly': 6 } },
    { t: T0 - 8 * DAY + 1000, v: { 'claude.weekly': 8 } },
    { t: T0 - 1 * DAY, v: { 'claude.weekly': 1 } },
    { t: T0 - 7 * DAY - 1, v: { 'claude.weekly': 7 } },
  ];
  const h = harness(samples);
  const { samples: out } = h.history.get(7, null);
  assert.deepEqual(out.map((s) => s.v['claude.weekly']), [6, 1]);

  const all = h.history.get(8, null).samples;
  assert.deepEqual(all.map((s) => s.v['claude.weekly']), [8, 7, 6, 1]);
});

test('get() builds series descriptors from the latest snapshot and falls back for leftover keys', () => {
  const h = harness([
    { t: T0 - 1000, v: { 'claude.weekly': 10, 'claude.weekly_opus': 4 } },
  ]);
  const latest = snapshot(
    provider('claude', [
      win('session', 1, { label: 'Current Session', kind: 'session', color: 'purple' }),
      win('weekly', 2, { label: 'Weekly Limit', kind: 'weekly', color: 'blue' }),
    ], { extra: { enabled: true, percent: 12 } }),
    provider('codex', [win('secondary', 5, { label: 'Weekly Limit', kind: 'weekly', color: 'teal' })]),
  );
  const { series } = h.history.get(7, latest);
  assert.deepEqual(series, [
    { key: 'claude.session', label: 'Claude Current Session', color: 'purple' },
    { key: 'claude.weekly', label: 'Claude Weekly Limit', color: 'blue' },
    { key: 'claude.extra', label: 'Claude Extra Usage', color: 'rose' },
    { key: 'codex.secondary', label: 'Codex Weekly Limit', color: 'teal' },
    { key: 'claude.weekly_opus', label: 'Claude Weekly Opus', color: 'slate' },
  ]);
});

test('get() with a null snapshot derives series from sample keys only', () => {
  const h = harness([{ t: T0 - 1000, v: { 'codex.primary': 3, 'claude.weekly': 10 } }]);
  const { series } = h.history.get(7, null);
  assert.deepEqual(series.map((s) => s.key), ['claude.weekly', 'codex.primary']);
});

test('corrupt storage is tolerated: non-arrays and malformed entries are ignored', () => {
  const h = harness({ not: 'an array' });
  assert.deepEqual(h.history.get().samples, []);

  const h2 = harness([null, 'junk', { t: 'nope', v: {} }, { t: T0 - 10, v: null }, { t: T0 - 5, v: { 'claude.weekly': 1 } }]);
  assert.equal(h2.history.get().samples.length, 1);

  const h3 = createHistory({ get: () => { throw new Error('disk'); }, set: () => {}, now: () => T0 });
  assert.deepEqual(h3.get().samples, []);
});

test('pruneAll trims expired samples and only writes when something changed', () => {
  let writes = 0;
  let stored = [
    { t: T0 - RETENTION_MS - 5, v: { 'claude.weekly': 1 } },
    { t: T0 - 5, v: { 'claude.weekly': 2 } },
  ];
  const history = createHistory({ get: () => stored, set: (arr) => { writes += 1; stored = arr; }, now: () => T0 });
  assert.equal(history.pruneAll(), 1);
  assert.equal(writes, 1);
  assert.equal(history.pruneAll(), 1);
  assert.equal(writes, 1, 'no rewrite when nothing was pruned');
});
