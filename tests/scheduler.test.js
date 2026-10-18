'use strict';
// Scheduler behaviour that main.js relies on but that no provider test covers: last-good → stale,
// the 429 "skip next cycle" hint, provider forgetting on source switch, the in-flight guard, and (several
// Claude accounts) one entry per resolved provider id plus the dedupe hook.
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

// ---------------------------------------------------------------------------------------------
// Several Claude accounts: dynamic provider ids and the dedupe hook
// ---------------------------------------------------------------------------------------------
const { dedupeSnapshot, identityHash } = require('../src/main/accounts');

const SAME = { account: identityHash('11111111-1111-4111-8111-111111111111'), org: null, personalOrg: null };
const OTHER = { account: identityHash('22222222-2222-4222-8222-222222222222'), org: null, personalOrg: null };

function accountSnapshot(id, identity, percent = 10) {
  return { ...okSnapshot('claude', percent), id, name: id, identity };
}

function spies() {
  const seen = { history: [], tray: [], alerts: [], onSnapshot: [] };
  return {
    seen,
    history: { append: (s) => seen.history.push(s) },
    tray: { update: (s) => seen.tray.push(s) },
    alerts: { evaluate: (s) => seen.alerts.push(s) },
    onSnapshot: (s) => seen.onSnapshot.push(s),
  };
}

test('every resolved provider id gets an entry (null when disabled), in resolution order, plus duplicates: {}', async () => {
  const ids = ['claude', 'claude-2', 'claude-3', 'claude-4', 'codex'];
  const list = ids.map((id) => scriptedProvider(id, [id === 'codex' ? okSnapshot('codex') : accountSnapshot(id, null)]));
  const { scheduler } = harness(list, { getSettings: () => ({ ...SETTINGS, providers: { claude: true, 'claude-2': false, 'claude-4': false, codex: false } }) });
  const snap = await scheduler.refreshNow();
  assert.deepEqual(Object.keys(snap.providers), ids);
  assert.equal(snap.providers['claude-2'], null);
  assert.equal(snap.providers['claude-4'], null);
  assert.equal(snap.providers.codex, null);
  assert.equal(snap.providers['claude-3'].status, 'ok', 'an id with no flag is enabled');
  assert.deepEqual(list.map((p) => p.calls), [1, 0, 1, 0, 0], 'disabled accounts are not polled');
  assert.deepEqual(snap.duplicates, {}, 'always present, empty without a dedupe hook');

  // Removing an account from the registry removes its key (no fixed id list any more).
  const fewer = harness(list.slice(2));
  assert.deepEqual(Object.keys((await fewer.scheduler.refreshNow()).providers), ['claude-3', 'claude-4', 'codex']);
});

test('history, tray, alerts, onSnapshot and getLastSnapshot all see the deduped snapshot', async () => {
  const claude = scriptedProvider('claude', [accountSnapshot('claude', SAME, 30)]);
  const twin = scriptedProvider('claude-2', [accountSnapshot('claude-2', SAME, 30)]);
  const third = scriptedProvider('claude-3', [accountSnapshot('claude-3', OTHER, 5)]);
  const codex = scriptedProvider('codex', [okSnapshot('codex')]);
  const s = spies();
  let dedupeInput = null;
  const { scheduler } = harness([claude, twin, third, codex], {
    ...s,
    dedupe: (providers) => { dedupeInput = providers; return dedupeSnapshot(providers); },
  });
  const snap = await scheduler.refreshNow();
  assert.equal(dedupeInput['claude-2'].status, 'ok', 'the hook gets every account as fetched');
  assert.equal(snap.providers['claude-2'], null, 'the twin is shown once');
  assert.deepEqual(snap.duplicates, { 'claude-2': 'claude' });
  assert.equal(snap.providers['claude-3'].status, 'ok', 'a different account stays');
  assert.equal(snap.providers.codex.status, 'ok');
  for (const step of ['history', 'tray', 'alerts', 'onSnapshot']) {
    assert.equal(s.seen[step].length, 1, step);
    assert.equal(s.seen[step][0], snap, `${step} receives the deduped snapshot`);
  }
  assert.equal(scheduler.getLastSnapshot(), snap);
});

test('distinct accounts pass the dedupe hook untouched', async () => {
  const claude = scriptedProvider('claude', [accountSnapshot('claude', SAME)]);
  const other = scriptedProvider('claude-2', [accountSnapshot('claude-2', OTHER)]);
  const { scheduler } = harness([claude, other], { dedupe: dedupeSnapshot });
  const snap = await scheduler.refreshNow();
  assert.equal(snap.providers.claude.status, 'ok');
  assert.equal(snap.providers['claude-2'].status, 'ok');
  assert.deepEqual(snap.duplicates, {});
});

test('a throwing (or broken) dedupe falls back to every account and never kills the tick', async () => {
  for (const [label, dedupe] of [
    ['throws', () => { throw new Error('dedupe exploded'); }],
    ['returns nothing', () => undefined],
    ['returns an array', () => ({ providers: [], duplicates: {} })],
  ]) {
    const errors = [];
    const claude = scriptedProvider('claude', [accountSnapshot('claude', SAME)]);
    const twin = scriptedProvider('claude-2', [accountSnapshot('claude-2', SAME)]);
    const s = spies();
    const { scheduler } = harness([claude, twin], {
      ...s, dedupe, log: { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.join(' ')) },
    });
    const snap = await scheduler.refreshNow();
    assert.equal(snap.providers.claude.status, 'ok', label);
    assert.equal(snap.providers['claude-2'].status, 'ok', `${label}: shown rather than lost`);
    assert.deepEqual(snap.duplicates, {}, label);
    assert.equal(s.seen.onSnapshot.length, 1, `${label}: the tick still completed`);
    assert.equal(s.seen.history[0], snap, label);
    assert.ok(errors.some((e) => /dedupe/.test(e)), `${label}: logged`);
  }
});

test('a dedupe result without a duplicates map is tolerated (duplicates defaults to {})', async () => {
  const claude = scriptedProvider('claude', [accountSnapshot('claude', SAME)]);
  const { scheduler } = harness([claude], { dedupe: (providers) => ({ providers }) });
  const snap = await scheduler.refreshNow();
  assert.deepEqual(snap.duplicates, {});
  assert.equal(snap.providers.claude.status, 'ok');
});

test('last-good stays per account id, also for an account the dedupe hides; failures keep last good identity', async () => {
  const claude = scriptedProvider('claude', [accountSnapshot('claude', SAME, 30)]);
  const twin = scriptedProvider('claude-2', [accountSnapshot('claude-2', SAME, 31), new Error('fetch failed')]);
  const fresh = scriptedProvider('claude-3', [new Error('fetch failed')]);
  const { scheduler } = harness([claude, twin, fresh], { dedupe: dedupeSnapshot });
  const first = await scheduler.refreshNow();
  assert.equal(first.providers['claude-2'], null);
  assert.equal(first.providers['claude-3'].status, 'error');
  assert.equal(first.providers['claude-3'].identity, null, 'a failure without last good has identity: null');

  await scheduler.refreshNow();
  assert.equal(twin.lastContext.lastGood.id, 'claude-2', 'its own last good, not account 1\'s');
  assert.equal(twin.lastContext.lastGood.windows[0].percent, 31);

  // Without the dedupe the stale entry shows what last good carried, identity included.
  const plain = harness([scriptedProvider('claude-2', [accountSnapshot('claude-2', OTHER, 12), new Error('fetch failed')])]);
  await plain.scheduler.refreshNow();
  const stale = (await plain.scheduler.refreshNow()).providers['claude-2'];
  assert.equal(stale.status, 'stale');
  assert.deepEqual(stale.identity, OTHER, 'a stale snapshot built from last good keeps its identity');
});

test('a rate-limited account that the dedupe hides still sits out its next automatic tick', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const claude = scriptedProvider('claude', [accountSnapshot('claude', SAME, 30)]);
  const twin = scriptedProvider('claude-2', [
    accountSnapshot('claude-2', SAME, 30),
    (ctx) => ({ ...ctx.lastGood, status: 'stale', error: { code: 'http_429', message: 'slow down' }, skipNextCycle: true }),
    accountSnapshot('claude-2', SAME, 30),
  ]);
  const { scheduler, snapshots } = harness([claude, twin], { dedupe: dedupeSnapshot });
  const flush = () => new Promise((r) => setImmediate(r));

  scheduler.start();
  await flush(); await flush();
  t.mock.timers.tick(15000); // interval #1 → claude-2 answers 429 + skipNextCycle (and is still a duplicate)
  await flush(); await flush();
  assert.equal(twin.calls, 2);
  assert.equal(snapshots[1].providers['claude-2'], null);

  t.mock.timers.tick(15000); // interval #2 → claude-2 must sit out even though the shown snapshot has it as null
  await flush(); await flush();
  assert.equal(twin.calls, 2, 'the 429 etiquette is per account, whatever the dedupe shows');
  assert.equal(claude.calls, 3);
  assert.deepEqual(snapshots[2].duplicates, { 'claude-2': 'claude' }, 'the carried entry is deduped again');

  t.mock.timers.tick(15000);
  await flush(); await flush();
  assert.equal(twin.calls, 3, 'back to normal');
  scheduler.stop();
});

test('a tick that crashes before its first snapshot returns an empty snapshot with every resolved id', async () => {
  let calls = 0;
  const now = () => { calls += 1; if (calls === 1) throw new Error('clock broke'); return T0; };
  const list = ['claude', 'claude-2', 'codex'].map((id) => scriptedProvider(id, [id === 'codex' ? okSnapshot('codex') : accountSnapshot(id, null)]));
  const { scheduler, snapshots } = harness(list, { now });
  const snap = await scheduler.refreshNow();
  assert.deepEqual(snap, { fetchedAt: T0, providers: { claude: null, 'claude-2': null, codex: null }, duplicates: {} });
  assert.equal(snapshots.length, 0, 'nothing was emitted');
});

test('an account renamed while it is failing shows its NEW name on the stale card, in both stale branches', async () => {
  // Both stale paths copy the last good snapshot; the name must still come from this cycle (main.js stamps the
  // current display name on every result), or a rename only shows up after the account recovers.
  const good = { ...okSnapshot('claude-2', 30), name: 'Claude 2' };
  const failingError = { ...errorSnapshot('claude-2'), name: 'Work' };
  const failingStaleEmpty = { ...errorSnapshot('claude-2'), status: 'stale', name: 'Work' };
  const p = scriptedProvider('claude-2', [good, failingError, failingStaleEmpty]);
  const { scheduler } = harness([p], { getSettings: () => ({ ...SETTINGS, providers: { 'claude-2': true } }) });
  await scheduler.refreshNow();
  const viaError = (await scheduler.refreshNow()).providers['claude-2'];
  assert.equal(viaError.status, 'stale');
  assert.equal(viaError.windows[0].percent, 30, 'last good windows kept');
  assert.equal(viaError.name, 'Work', 'error → stale branch keeps the fresh name');
  const viaStale = (await scheduler.refreshNow()).providers['claude-2'];
  assert.equal(viaStale.status, 'stale');
  assert.equal(viaStale.name, 'Work', 'stale-without-windows branch keeps the fresh name');
});

test('a provider forgotten while its fetch is in flight (account switched login) neither keeps that result as last good nor shows old values as stale', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const oldLogin = { ...okSnapshot('claude-2', 70), name: 'Claude 2', skipNextCycle: true };
  let phase = 'first';
  const p = scriptedProvider('claude-2', [
    okSnapshot('claude-2', 20),                                   // tick 1: the old login's good values
    async () => { await gate; return oldLogin; },                 // tick 2: in flight across the switch (+ a 429 hint)
    () => ({ ...errorSnapshot('claude-2'), status: 'error' }),    // tick 3: the new login fails
  ]);
  const { scheduler } = harness([p], { getSettings: () => ({ ...SETTINGS, providers: { 'claude-2': true } }) });
  await scheduler.refreshNow();
  const tick2 = scheduler.refreshNow();
  scheduler.forgetProvider('claude-2'); // main.js: source / folder changed mid-fetch
  release();
  phase = 'released';
  await tick2;
  const tick3 = (await scheduler.refreshNow()).providers['claude-2'];
  assert.equal(phase, 'released');
  assert.equal(tick3.status, 'error', 'no last good survives from either the forgotten value or the in-flight one');
  assert.deepEqual(tick3.windows, []);
  assert.equal(p.calls, 3, "the old login's 429 hint did not make the new login sit out a cycle");
});

test('an account forgotten or removed while ANOTHER provider is still loading is not published: placeholder for a switch, gone for a removal', async () => {
  // claude-2 answers at once; codex is slow. The account changes in between — the case the per-fetch check cannot see.
  let releaseCodex;
  const codexGate = new Promise((r) => { releaseCodex = r; });
  const two = scriptedProvider('claude-2', [{ ...okSnapshot('claude-2', 85), name: 'Person X', identity: { account: 'aaaa', org: null, personalOrg: null } }]);
  const three = scriptedProvider('claude-3', [{ ...okSnapshot('claude-3', 40), name: 'Claude 3' }]);
  const codex = scriptedProvider('codex', [async () => { await codexGate; return okSnapshot('codex', 5); }]);
  let list = [two, three, codex];
  const appended = [];
  const evaluated = [];
  const { scheduler } = harness(() => list, {
    getSettings: () => ({ ...SETTINGS, providers: { 'claude-2': true, 'claude-3': true, codex: true } }),
    history: { append: (s) => appended.push(s) },
    alerts: { evaluate: (s) => evaluated.push(s) },
  });
  const tick = scheduler.refreshNow();
  await new Promise((r) => setImmediate(r));
  scheduler.forgetProvider('claude-2');          // claude-2 switched to another login
  scheduler.forgetProvider('claude-3');          // claude-3 removed …
  list = [two, codex];                           // … so it no longer resolves
  releaseCodex();
  const snap = await tick;
  assert.equal(snap.providers['claude-2'].status, 'error', 'the old login is not published as this account');
  assert.deepEqual(snap.providers['claude-2'].windows, []);
  assert.equal(snap.providers['claude-2'].identity, null);
  assert.ok(!('claude-3' in snap.providers), 'a removed account drops out of the snapshot');
  assert.equal(snap.providers.codex.status, 'ok');
  for (const s of [...appended, ...evaluated]) {
    assert.ok(!(s.providers['claude-2'] && s.providers['claude-2'].windows.length), 'history / alerts never see the old login');
    assert.ok(!s.providers['claude-3'], 'nor the removed account');
  }
});
