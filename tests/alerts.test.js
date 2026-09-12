'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAlertEngine, formatResetTime } = require('../src/main/alerts');

const CYCLE_A = '2026-09-07T13:59:00.000Z';
const CYCLE_B = '2026-09-14T13:59:00.000Z';

function win(key, label, kind, percent, resetsAt = CYCLE_A, severity = null) {
  return { key, label, kind, percent, resetsAt, windowSeconds: null, severity, isActive: null, color: 'blue', scope: null };
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
    updatedAt: 0,
    windows,
    extra: null,
    credits: null,
    raw: {},
    ...overrides,
  };
}

function claudeSnapshot(weeklyPercent, weeklyReset = CYCLE_A, sessionPercent = 5, sessionReset = '2026-09-06T17:00:00.000Z') {
  return {
    fetchedAt: 0,
    providers: {
      claude: provider('claude', [
        win('session', 'Current Session', 'session', sessionPercent, sessionReset),
        win('weekly', 'Weekly Limit', 'weekly', weeklyPercent, weeklyReset),
      ]),
      codex: null,
    },
  };
}

function engine() {
  const calls = [];
  const alerts = createAlertEngine({ notify: (title, body) => calls.push({ title, body }), now: () => 0 });
  return { alerts, calls };
}

const SETTINGS = { usageAlerts: true, warnThreshold: 75, dangerThreshold: 90, timeFormat: '12h' };

test('first evaluation seeds silently, then warn → danger → blocked → available fire exactly once each', () => {
  const { alerts, calls } = engine();

  alerts.evaluate(claudeSnapshot(10), SETTINGS);
  assert.equal(calls.length, 0, 'seed is silent');

  alerts.evaluate(claudeSnapshot(78), SETTINGS);
  assert.equal(calls.length, 1);
  assert.match(calls[0].title, /Claude · Weekly Limit at 78%/);

  alerts.evaluate(claudeSnapshot(80), SETTINGS);
  assert.equal(calls.length, 1, 'no duplicate warn inside the same cycle');

  alerts.evaluate(claudeSnapshot(91), SETTINGS);
  assert.equal(calls.length, 2);
  assert.match(calls[1].title, /Claude · Weekly Limit at 91%/);
  assert.match(calls[1].body, /danger/i);

  alerts.evaluate(claudeSnapshot(95), SETTINGS);
  assert.equal(calls.length, 2, 'no duplicate danger inside the same cycle');

  alerts.evaluate(claudeSnapshot(100), SETTINGS);
  assert.equal(calls.length, 3);
  assert.match(calls[2].title, /Claude · Weekly Limit reached/);
  assert.match(calls[2].body, /Resets Sep \d+, \d+:\d\d (AM|PM)/);

  alerts.evaluate(claudeSnapshot(100), SETTINGS);
  alerts.evaluate(claudeSnapshot(104), SETTINGS);
  assert.equal(calls.length, 3, 'blocked fires once per cycle');

  // Reset cycle: new resetsAt, usage back to 3 % → "available again", once.
  alerts.evaluate(claudeSnapshot(3, CYCLE_B), SETTINGS);
  assert.equal(calls.length, 4);
  assert.match(calls[3].title, /Claude · usage available again/);
  assert.match(calls[3].body, /Weekly Limit has reset/);

  alerts.evaluate(claudeSnapshot(4, CYCLE_B), SETTINGS);
  assert.equal(calls.length, 4);
});

test('a new reset cycle re-arms warn and danger', () => {
  const { alerts, calls } = engine();
  alerts.evaluate(claudeSnapshot(0), SETTINGS);
  alerts.evaluate(claudeSnapshot(80), SETTINGS);
  alerts.evaluate(claudeSnapshot(92), SETTINGS);
  assert.equal(calls.length, 2);

  alerts.evaluate(claudeSnapshot(80, CYCLE_B), SETTINGS);
  assert.equal(calls.length, 3, 'warn fires again in the new cycle');
  alerts.evaluate(claudeSnapshot(92, CYCLE_B), SETTINGS);
  assert.equal(calls.length, 4, 'danger fires again in the new cycle');
});

test('jumping straight past danger fires only the danger alert (warn is folded in)', () => {
  const { alerts, calls } = engine();
  alerts.evaluate(claudeSnapshot(0), SETTINGS);
  alerts.evaluate(claudeSnapshot(93), SETTINGS);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body, /danger/i);
  alerts.evaluate(claudeSnapshot(94), SETTINGS);
  assert.equal(calls.length, 1);
});

test('usageAlerts=false silences notifications while state keeps tracking', () => {
  const { alerts, calls } = engine();
  const muted = { ...SETTINGS, usageAlerts: false };
  alerts.evaluate(claudeSnapshot(0), muted);
  alerts.evaluate(claudeSnapshot(80), muted);
  alerts.evaluate(claudeSnapshot(100), muted);
  assert.equal(calls.length, 0);

  // Re-enabling does not replay the muted escalations for the same cycle...
  alerts.evaluate(claudeSnapshot(100), SETTINGS);
  assert.equal(calls.length, 0);
  // ...but new events in a new cycle fire normally.
  alerts.evaluate(claudeSnapshot(2, CYCLE_B), SETTINGS);
  assert.equal(calls.length, 1);
  assert.match(calls[0].title, /available again/);
});

test('available again waits until no window of the provider is blocked', () => {
  const { alerts, calls } = engine();
  const both = (session, sessionReset, weekly, weeklyReset) => claudeSnapshot(weekly, weeklyReset, session, sessionReset);
  alerts.evaluate(both(0, 'S1', 0, CYCLE_A), SETTINGS);
  alerts.evaluate(both(100, 'S1', 100, CYCLE_A), SETTINGS);
  assert.equal(calls.length, 1, 'both windows blocking at once produce one grouped toast');
  assert.match(calls[0].title, /Claude · limits reached/);
  assert.match(calls[0].body, /Current Session, Weekly Limit/);

  alerts.evaluate(both(5, 'S2', 100, CYCLE_A), SETTINGS);
  assert.equal(calls.length, 1, 'session reset while weekly is still blocked → no "available"');

  alerts.evaluate(both(6, 'S2', 1, CYCLE_B), SETTINGS);
  assert.equal(calls.length, 2);
  assert.match(calls[1].title, /available again/);
});

test('Codex limit_reached blocks every window and clearing it fires available within the same cycle', () => {
  const { alerts, calls } = engine();
  const codex = (limitReached, severity) => ({
    fetchedAt: 0,
    providers: {
      claude: null,
      codex: provider('codex', [
        win('primary', '5-Hour Limit', 'session', 60, '2026-09-06T17:00:00.000Z', severity),
        win('secondary', 'Weekly Limit', 'weekly', 40, CYCLE_A, severity),
      ], { credits: { hasCredits: false, unlimited: false, balance: null, overageLimitReached: false, approxLocalMessages: null, approxCloudMessages: null, limitReached, limitReachedType: null, modelUsage: {} } }),
    },
  });
  alerts.evaluate(codex(false, null), SETTINGS);
  alerts.evaluate(codex(true, 'blocked'), SETTINGS);
  assert.equal(calls.length, 1);
  assert.match(calls[0].title, /Codex · limits reached/);
  alerts.evaluate(codex(true, 'blocked'), SETTINGS);
  assert.equal(calls.length, 1);
  alerts.evaluate(codex(false, null), SETTINGS);
  assert.equal(calls.length, 2);
  assert.match(calls[1].title, /Codex · usage available again/);
});

test('providers in auth_required/error state and null providers are ignored', () => {
  const { alerts, calls } = engine();
  const snap = { fetchedAt: 0, providers: { claude: provider('claude', [win('weekly', 'Weekly Limit', 'weekly', 99)], { status: 'auth_required' }), codex: null } };
  alerts.evaluate(snap, SETTINGS);
  alerts.evaluate(snap, SETTINGS);
  assert.equal(calls.length, 0);
  assert.deepEqual(alerts.evaluate(null, SETTINGS), []);
});

test('reset() clears state so the next evaluation seeds silently again', () => {
  const { alerts, calls } = engine();
  alerts.evaluate(claudeSnapshot(0), SETTINGS);
  alerts.evaluate(claudeSnapshot(80), SETTINGS);
  assert.equal(calls.length, 1);
  alerts.reset();
  alerts.evaluate(claudeSnapshot(95), SETTINGS);
  assert.equal(calls.length, 1, 'post-reset seed is silent');
  alerts.evaluate(claudeSnapshot(100), SETTINGS);
  assert.equal(calls.length, 2);
});

test('formatResetTime honours 12h/24h and the optional date', () => {
  const iso = new Date(2026, 8, 7, 13, 59).toISOString(); // local 1:59 PM, Sep 7
  assert.equal(formatResetTime(iso, '12h', false), '1:59 PM');
  assert.equal(formatResetTime(iso, '24h', false), '13:59');
  assert.equal(formatResetTime(iso, '12h', true), 'Sep 7, 1:59 PM');
  assert.equal(formatResetTime(null, '12h', true), null);
  assert.equal(formatResetTime('garbage', '12h', true), null);
});

// Regression: claude.ai recomputes `resets_at` as (server clock + whole seconds remaining) on every
// request, so one logical reset instant arrives as a slightly different ISO string each poll. These three
// values are real, captured ~5 s apart from a live account — note they straddle a second, a minute AND an
// hour boundary, which is why quantising the timestamp is not a sufficient fix. Before the drift tolerance
// the blocked latch re-armed every poll and toasted every refresh, forever.
const DRIFT = [
  '2026-09-14T13:59:59.665Z',
  '2026-09-14T13:59:59.884Z',
  '2026-09-14T14:00:00.086Z',
];

test('a drifting resetsAt is absorbed: a blocked window toasts once, not once per poll', () => {
  const { alerts, calls } = engine();

  // Seed below the warning threshold so the later 100% is a genuine transition, not a state the user
  // was already looking at when the widget launched.
  alerts.evaluate(claudeSnapshot(10, DRIFT[0]), SETTINGS);
  assert.equal(calls.length, 0, 'seed is silent');

  for (const reset of [DRIFT[1], DRIFT[2], DRIFT[0], DRIFT[1], DRIFT[2]]) {
    alerts.evaluate(claudeSnapshot(100, reset), SETTINGS);
  }
  assert.equal(calls.length, 1, 'exactly one blocked toast across five drifting polls');
  assert.match(calls[0].title, /Claude · Weekly Limit reached/);
});

test('drift tolerance does not swallow a genuine rollover', () => {
  const { alerts, calls } = engine();

  alerts.evaluate(claudeSnapshot(100, CYCLE_A), SETTINGS);   // seed, silent
  alerts.evaluate(claudeSnapshot(100, DRIFT[0]), SETTINGS);  // real new cycle (7 days on)
  assert.equal(calls.length, 1, 'a week-long jump still re-arms and fires');
  alerts.evaluate(claudeSnapshot(100, DRIFT[1]), SETTINGS);  // drift within the new cycle
  assert.equal(calls.length, 1, 'and then stays quiet');
});

test('a window recovering while a sibling is still blocked keeps its latch', () => {
  const { alerts, calls } = engine();
  const snap = (sessionPct, weeklyPct) => claudeSnapshot(weeklyPct, DRIFT[0], sessionPct, DRIFT[0]);

  alerts.evaluate(snap(100, 100), SETTINGS);        // seed, silent
  assert.equal(calls.length, 0);
  alerts.evaluate(snap(10, 100), SETTINGS);         // session recovers, weekly still blocked
  assert.equal(calls.length, 0, 'no "available again" while the provider is still blocked');
  alerts.evaluate(snap(100, 100), SETTINGS);        // session blocked again
  assert.equal(calls.length, 0, 'and no fresh "reached" toast — the latch was never cleared');
});
