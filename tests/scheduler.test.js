'use strict';
// Scheduler behaviour that main.js relies on but that no provider test covers: last-good → stale,
// the 429 "skip next cycle" hint, provider forgetting on source switch, and the in-flight guard.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createScheduler } = require('../src/main/scheduler');

const T0 = 1_788_700_000_000;
const SETTINGS = { refreshInterval: '15', providers: { claude: true, codex: true } };

function okSnapshot(id, percent = 10) {
  return {
    id, name: id === 'claude' ? 'Claude' : 'Codex', status: 'ok', error: null,
    source: id === 'claude' ? 'claude_code' : 'codex_auth_file', plan: 'Pro', account: null, updatedAt: T0,
    windows: [{ key: 'weekly', label: 'Weekly Limit', kind: 'weekly', percent, resetsAt: '2026-09-07T13:59:00.000Z', windowSeconds: 604800, severity: null, isActive: null, color: 'blue', scope: null }],
    extra: null, credits: null, raw: { usage: { seven_day: { utilization: percent } } },
  };
}

function errorSnapshot(id, extraFields = {}) {
  return {
    id, name: id, status: 'error', error: { code: 'http_429', message: 'rate limited' }, source: null, plan: null,
    account: null, updatedAt: 0, windows: [], extra: null, credits: null, raw: {}, ...extraFields,
  };
}

/** Provider whose replies are dequeued per call; records how often it was asked. */
function scriptedProvider(id, replies) {
  const queue = [...replies];
  const provider = {
    id,
    name: id,
    calls: 0,
    async fetchSnapshot(ctx) {
      provider.calls += 1;
      provider.lastContext = ctx;
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(ctx) : next;
    },
  };
  return provider;
}

function harness(providers, extra = {}) {
  const snapshots = [];
  const scheduler = createScheduler({
    providers,
    getSettings: () => SETTINGS,
    onSnapshot: (s) => snapshots.push(s),
    log: { info() {}, warn() {}, error() {}, debug() {} },
    now: () => T0,
    ...extra,
  });
  return { scheduler, snapshots };
}

test('a failing cycle after a good one becomes stale with the last-good windows; auth_required passes through', async () => {
  const claude = scriptedProvider('claude', [okSnapshot('claude', 42), new Error('fetch failed: ENOTFOUND')]);
  const codex = scriptedProvider('codex', [
    okSnapshot('codex', 7),
    { ...errorSnapshot('codex'), status: 'auth_required', error: { code: 'no_credentials', message: 'Sign in' } },
  ]);
  const { scheduler, snapshots } = harness([claude, codex]);

  const first = await scheduler.refreshNow();
  assert.equal(first.providers.claude.status, 'ok');
  assert.equal(first.providers.codex.status, 'ok');
  assert.equal(snapshots.length, 1);

  const second = await scheduler.refreshNow();
  assert.equal(second.providers.claude.status, 'stale');
  assert.equal(second.providers.claude.windows[0].percent, 42, 'last-good windows carried');
  assert.equal(second.providers.claude.error.code, 'network');
  assert.equal(second.providers.codex.status, 'auth_required', 'auth_required is never turned into stale');
  assert.equal(scheduler.getLastSnapshot(), second);
  assert.ok(!('skipNextCycle' in second.providers.claude));
});

test('providers receive lastGood, an injected fetch, a callable log and the settings', async () => {
  const claude = scriptedProvider('claude', [okSnapshot('claude')]);
  const fakeFetch = async () => ({});
  const { scheduler } = harness([claude], { fetch: fakeFetch });
  await scheduler.refreshNow();
  assert.equal(claude.lastContext.lastGood, null);
  assert.equal(claude.lastContext.fetch, fakeFetch);
  assert.equal(typeof claude.lastContext.log, 'function');
  assert.equal(typeof claude.lastContext.log.warn, 'function');
  assert.equal(claude.lastContext.settings, SETTINGS);
  await scheduler.refreshNow();
  assert.equal(claude.lastContext.lastGood.status, 'ok', 'second call sees the first result as lastGood');
});

test('skipNextCycle: the provider sits out the next automatic tick (previous entry carried), never a manual one', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const claude = scriptedProvider('claude', [okSnapshot('claude', 5)]);
  const codex = scriptedProvider('codex', [
    okSnapshot('codex', 50),
    // 429 → provider returns stale last-good with the hint set
    (ctx) => ({ ...ctx.lastGood, status: 'stale', error: { code: 'http_429', message: 'slow down' }, skipNextCycle: true }),
    okSnapshot('codex', 60),
  ]);
  const { scheduler, snapshots } = harness([claude, codex]);
  const flush = () => new Promise((r) => setImmediate(r));

  scheduler.start(); // interval = 15 s from settings; also runs a 'start' tick
  await flush(); await flush();
  assert.equal(snapshots.length, 1);
  assert.equal(codex.calls, 1);

  t.mock.timers.tick(15000); // interval tick #1 → codex replies 429 + skipNextCycle
  await flush(); await flush();
  assert.equal(snapshots.length, 2);
  assert.equal(codex.calls, 2);
  assert.equal(snapshots[1].providers.codex.status, 'stale');
  assert.ok(!('skipNextCycle' in snapshots[1].providers.codex), 'hint is consumed, not forwarded');

  t.mock.timers.tick(15000); // interval tick #2 → codex must be skipped, claude still polled
  await flush(); await flush();
  assert.equal(snapshots.length, 3);
  assert.equal(codex.calls, 2, 'codex sat this cycle out');
  assert.equal(claude.calls, 3);
  assert.equal(snapshots[2].providers.codex.status, 'stale', 'previous entry carried forward');
  assert.equal(snapshots[2].providers.codex.windows[0].percent, 50);

  t.mock.timers.tick(15000); // interval tick #3 → back to normal
  await flush(); await flush();
  assert.equal(codex.calls, 3);
  assert.equal(snapshots[3].providers.codex.status, 'ok');
  assert.equal(snapshots[3].providers.codex.windows[0].percent, 60);

  scheduler.stop();
});

test('forgetProvider drops last-good so the next failure is an error, not stale from the other source', async () => {
  const claude = scriptedProvider('claude', [okSnapshot('claude', 33), new Error('boom')]);
  const { scheduler } = harness([claude]);
  await scheduler.refreshNow();
  scheduler.forgetProvider('claude');
  const snap = await scheduler.refreshNow();
  assert.equal(snap.providers.claude.status, 'error');
  assert.deepEqual(snap.providers.claude.windows, []);
});

test('a tick already in flight is reused instead of starting a second one; disabled providers are null', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const claude = scriptedProvider('claude', [async () => { await gate; return okSnapshot('claude'); }]);
  const codex = scriptedProvider('codex', [okSnapshot('codex')]);
  const { scheduler } = harness([claude, codex], { getSettings: () => ({ ...SETTINGS, providers: { claude: true, codex: false } }) });

  const p1 = scheduler.refreshNow();
  const p2 = scheduler.refreshNow();
  assert.equal(scheduler.isRefreshing(), true);
  release();
  const [s1, s2] = await Promise.all([p1, p2]);
  assert.equal(s1, s2, 'same snapshot object for both callers');
  assert.equal(claude.calls, 1);
  assert.equal(codex.calls, 0, 'disabled provider is not polled');
  assert.equal(s1.providers.codex, null);
  assert.equal(scheduler.isRefreshing(), false);
});

test('an invalid provider return value becomes a parse error snapshot instead of breaking the tick', async () => {
  const codex = scriptedProvider('codex', [null]);
  const { scheduler } = harness([codex]);
  const snap = await scheduler.refreshNow();
  assert.equal(snap.providers.codex.status, 'error');
  assert.equal(snap.providers.codex.error.code, 'parse');
  assert.equal(snap.providers.codex.name, 'codex');
});
