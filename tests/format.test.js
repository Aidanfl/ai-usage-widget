'use strict';
// node --test tests/format.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const F = require(path.join(__dirname, '..', 'src', 'renderer', 'format.js'));

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;

// Local-time fixture: Monday 7 Sep 2026, 15:59 (Sep 7 2026 is a Monday).
const fixture = new Date(2026, 8, 7, 15, 59, 0, 0);
const fixtureIso = fixture.toISOString();
const morning = new Date(2026, 8, 7, 2, 29, 0, 0);

test('formatDuration', () => {
  assert.equal(F.formatDuration(43 * MIN), '43m');
  assert.equal(F.formatDuration(4 * HOUR + 12 * MIN), '4h 12m');
  assert.equal(F.formatDuration(DAY + 8 * HOUR + 5 * MIN), '1d 8h');
  assert.equal(F.formatDuration(6 * DAY + 14 * HOUR), '6d 14h');
  assert.equal(F.formatDuration(30 * 1000), '0m');
  assert.equal(F.formatDuration(0), '0m');
  assert.equal(F.formatDuration(-5000), '0m');
  assert.equal(F.formatDuration(null), '0m');
});

test('formatResetsIn', () => {
  const now = 1_788_700_000_000;
  assert.equal(F.formatResetsIn(new Date(now + 43 * MIN).toISOString(), 20, now), '43m');
  assert.equal(F.formatResetsIn(new Date(now + DAY + 8 * HOUR).toISOString(), 22, now), '1d 8h');
  assert.equal(F.formatResetsIn(null, 0, now), 'Not started');
  assert.equal(F.formatResetsIn(undefined, null, now), 'Not started');
  assert.equal(F.formatResetsIn(null, 12, now), '—');
  assert.equal(F.formatResetsIn(new Date(now - 1000).toISOString(), 50, now), 'Resetting...');
  assert.equal(F.formatResetsIn('not a date', 0, now), 'Not started');
});

test('formatTime 12h / 24h', () => {
  assert.equal(F.formatTime(fixture, '12h'), '3:59 PM');
  assert.equal(F.formatTime(fixture, '24h'), '15:59');
  assert.equal(F.formatTime(morning, '12h'), '2:29 AM');
  assert.equal(F.formatTime(morning, '24h'), '02:29');
  assert.equal(F.formatTime(new Date(2026, 8, 7, 0, 5), '12h'), '12:05 AM');
  assert.equal(F.formatTime(new Date(2026, 8, 7, 12, 0), '12h'), '12:00 PM');
  assert.equal(F.formatTime(null, '12h'), '—');
});

test('formatResetsAt — session windows show time only', () => {
  assert.equal(F.formatResetsAt(fixtureIso, { isWeekly: false, timeFormat: '12h' }), '3:59 PM');
  assert.equal(F.formatResetsAt(fixtureIso, { isWeekly: false, timeFormat: '24h' }), '15:59');
  assert.equal(F.formatResetsAt(fixtureIso, { isWeekly: false, timeFormat: '24h', dateFormat: 'date-day-time' }), '15:59');
});

test('formatResetsAt — weekly windows use the three date formats', () => {
  assert.equal(F.formatResetsAt(fixtureIso, { isWeekly: true, timeFormat: '12h', dateFormat: 'date' }), 'Sep 7');
  assert.equal(F.formatResetsAt(fixtureIso, { isWeekly: true, timeFormat: '12h', dateFormat: 'date-day' }), 'Mon Sep 7');
  assert.equal(F.formatResetsAt(fixtureIso, { isWeekly: true, timeFormat: '12h', dateFormat: 'date-day-time' }), 'Mon Sep 7 3:59 PM');
  assert.equal(F.formatResetsAt(fixtureIso, { isWeekly: true, timeFormat: '24h', dateFormat: 'date-day-time' }), 'Mon Sep 7 15:59');
  // defaults: date + 12h
  assert.equal(F.formatResetsAt(fixtureIso, { isWeekly: true }), 'Sep 7');
});

test('formatResetsAt — missing value is an em dash', () => {
  assert.equal(F.formatResetsAt(null, { isWeekly: true }), '—');
  assert.equal(F.formatResetsAt(undefined, { isWeekly: false }), '—');
  assert.equal(F.formatResetsAt('garbage', {}), '—');
});

test('formatDateTime', () => {
  assert.equal(F.formatDateTime(fixture, '12h'), 'Sep 7, 3:59 PM');
  assert.equal(F.formatDateTime(fixture, '24h'), 'Sep 7, 15:59');
});

test('formatCurrency — minor units + currency code', () => {
  assert.equal(F.formatCurrency(7519, 'USD'), '$75.19');
  assert.equal(F.formatCurrency(17500, 'USD'), '$175.00');
  assert.equal(F.formatCurrency(1200, 'EUR'), '€12.00');
  assert.equal(F.formatCurrency(350, 'GBP'), '£3.50');
  assert.equal(F.formatCurrency(1234, 'CHF'), '12.34 CHF');
  assert.equal(F.formatCurrency(1234, 'chf'), '12.34 CHF');
  assert.equal(F.formatCurrency(0, 'USD'), '$0.00');
});

test('formatCurrency — missing currency defaults to USD, not "12.34 USD"', () => {
  assert.equal(F.formatCurrency(1234, undefined), '$12.34');
  assert.equal(F.formatCurrency(1234, null), '$12.34');
  assert.equal(F.formatCurrency(1234, ''), '$12.34');
});

test('formatCurrency — options and edge cases', () => {
  assert.equal(F.formatCurrency(5000, 'USD', { stripWholeCents: true }), '$50');
  assert.equal(F.formatCurrency(5050, 'USD', { stripWholeCents: true }), '$50.50');
  assert.equal(F.formatCurrency(-250, 'USD'), '-$2.50');
  assert.equal(F.formatCurrency(12345, 'JPY', { exponent: 0 }), '12345 JPY');
  assert.equal(F.formatCurrency(null, 'USD'), null);
  assert.equal(F.formatCurrency(undefined, 'USD'), null);
  assert.equal(F.formatCurrency(NaN, 'USD'), null);
});

test('elapsedFraction', () => {
  const now = 1_788_700_000_000;
  const fiveHours = 18000;
  // 43 minutes left of a 5-hour window → (300-43)/300 elapsed
  const in43 = new Date(now + 43 * MIN).toISOString();
  const frac = F.elapsedFraction(in43, fiveHours, now);
  assert.ok(Math.abs(frac - (300 - 43) / 300) < 1e-9, `got ${frac}`);
  // 1d 8h left of a 7-day window
  const weekly = F.elapsedFraction(new Date(now + DAY + 8 * HOUR).toISOString(), 604800, now);
  assert.ok(Math.abs(weekly - (168 - 32) / 168) < 1e-9, `got ${weekly}`);
  // past reset → 1; reset further than the window → 0 (no negative offsets)
  assert.equal(F.elapsedFraction(new Date(now - 1).toISOString(), fiveHours, now), 1);
  assert.equal(F.elapsedFraction(new Date(now + 10 * HOUR).toISOString(), fiveHours, now), 0);
  // missing inputs → null (ring hidden)
  assert.equal(F.elapsedFraction(null, fiveHours, now), null);
  assert.equal(F.elapsedFraction(in43, null, now), null);
  assert.equal(F.elapsedFraction(in43, 0, now), null);
});

test('thresholdClass and ringClass', () => {
  assert.equal(F.thresholdClass(20, 75, 90), '');
  assert.equal(F.thresholdClass(75, 75, 90), 'warning');
  assert.equal(F.thresholdClass(89.9, 75, 90), 'warning');
  assert.equal(F.thresholdClass(90, 75, 90), 'danger');
  assert.equal(F.thresholdClass(120, 75, 90), 'danger');
  assert.equal(F.thresholdClass(50, 40, 60), 'warning');
  assert.equal(F.thresholdClass(NaN, 75, 90), '');
  assert.equal(F.ringClass(10), '');
  assert.equal(F.ringClass(75), 'elapsed-warn');
  assert.equal(F.ringClass(89), 'elapsed-warn');
  assert.equal(F.ringClass(90), 'elapsed-soon');
  assert.equal(F.ringClass(100), 'elapsed-soon');
});

test('clampPercent', () => {
  assert.equal(F.clampPercent(-5), 0);
  assert.equal(F.clampPercent(120), 100);
  assert.equal(F.clampPercent(42.4), 42.4);
  assert.equal(F.clampPercent(null), 0);
  assert.equal(F.clampPercent('x'), 0);
});

test('shortWindowName', () => {
  assert.equal(F.shortWindowName({ kind: 'session', windowSeconds: 18000 }), '5H');
  assert.equal(F.shortWindowName({ kind: 'weekly', windowSeconds: 604800 }), '7D');
  assert.equal(F.shortWindowName({ kind: 'weekly_scoped', windowSeconds: 604800 }), '7D');
  assert.equal(F.shortWindowName({ kind: 'other', windowSeconds: 86400 }), '1D');
  assert.equal(F.shortWindowName({ kind: 'other', windowSeconds: 2592000 }), '30D');
  assert.equal(F.shortWindowName({ kind: 'other', windowSeconds: 7200 }), '2H');
  // windowSeconds unknown → infer from kind
  assert.equal(F.shortWindowName({ kind: 'session', windowSeconds: null }), '5H');
  assert.equal(F.shortWindowName({ kind: 'weekly', windowSeconds: null }), '7D');
  assert.equal(F.shortWindowName({ kind: 'other', windowSeconds: null }), '');
  assert.equal(F.shortWindowName(null), '');
});

test('compactLabel and seriesLabel', () => {
  const session = { key: 'session', kind: 'session', windowSeconds: 18000, label: 'Current Session', scope: null };
  const weekly = { key: 'weekly', kind: 'weekly', windowSeconds: 604800, label: 'Weekly Limit', scope: null };
  const fable = { key: 'weekly_fable', kind: 'weekly_scoped', windowSeconds: 604800, label: 'Fable Weekly', scope: 'Fable' };
  const review = { key: 'code_review', kind: 'other', windowSeconds: null, label: 'Code Review', scope: null };
  assert.equal(F.compactLabel('Claude', session), 'CLAUDE 5H');
  assert.equal(F.compactLabel('Claude', weekly), 'CLAUDE 7D');
  assert.equal(F.compactLabel('Claude', fable), 'FABLE 7D');
  assert.equal(F.compactLabel('Codex', weekly), 'CODEX 7D');
  assert.equal(F.compactLabel('Codex', review), 'CODEX CODE REVIEW');
  assert.equal(F.seriesLabel('Claude', session), 'Claude 5h');
  assert.equal(F.seriesLabel('Claude', fable), 'Fable 7d');
  assert.equal(F.seriesLabel('Codex', weekly), 'Codex 7d');
});

test('isWeeklyWindow', () => {
  assert.equal(F.isWeeklyWindow({ kind: 'session', windowSeconds: 18000 }), false);
  assert.equal(F.isWeeklyWindow({ kind: 'weekly', windowSeconds: 604800 }), true);
  assert.equal(F.isWeeklyWindow({ kind: 'weekly_scoped', windowSeconds: null }), true);
  assert.equal(F.isWeeklyWindow({ kind: 'other', windowSeconds: 86400 }), true);
  assert.equal(F.isWeeklyWindow({ kind: 'other', windowSeconds: 7200 }), false);
  assert.equal(F.isWeeklyWindow(null), false);
});

test('toMs — out-of-range numbers and non-string junk are null, never an Invalid Date', () => {
  // 8.64e15 is the largest |ms| a Date can hold; anything past it used to slip through the isFinite check
  // and render as "NaN:NaN PM" / "undefined NaN".
  assert.equal(F.toMs(8.64e15), 8.64e15);
  assert.equal(F.toMs(8.64e15 + 1), null);
  assert.equal(F.toMs(-8.64e15 - 1), null);
  assert.equal(F.toMs(1e20), null);
  assert.equal(F.formatTime(1e20, '12h'), '—');
  assert.equal(F.formatDate(1e20, 'date-day-time', '24h'), '—');
  assert.equal(F.formatResetsAt(1e20, { isWeekly: true }), '—');
  // Objects/booleans are not dates either (Date.parse would stringify them) — and no exception.
  assert.equal(F.toMs({}), null);
  assert.equal(F.toMs(true), null);
  assert.equal(F.toMs([]), null);
  // The happy paths are untouched.
  assert.equal(F.toMs(fixtureIso), fixture.getTime());
  assert.equal(F.toMs(fixture), fixture.getTime());
  assert.equal(F.toMs(0), 0);
});

test('formatCurrency — a bogus exponent is clamped instead of throwing RangeError from toFixed', () => {
  assert.doesNotThrow(() => F.formatCurrency(1234, 'USD', { exponent: 101 }));
  assert.doesNotThrow(() => F.formatCurrency(1234, 'USD', { exponent: -1 }));
  assert.equal(F.formatCurrency(1234, 'USD', { exponent: -1 }), '$1234');
  assert.equal(F.formatCurrency(1234, 'USD', { exponent: NaN }), '$12.34');
  assert.equal(F.formatCurrency(1234, 'USD', { exponent: Infinity }), '$12.34'); // non-finite → default 2
  assert.equal(F.formatCurrency(1234, 'USD', { exponent: 101 }), '$' + (1234 / 1e20).toFixed(20)); // clamped to 20
  assert.equal(F.formatCurrency(1234, 'USD', { exponent: 2.7 }), '$12.34');
});

test('isWeeklyWindow — with `now`, a reset a day or more away uses the date format for unknown-length windows', () => {
  const now = 1_788_700_000_000;
  const other = (resetsAt) => ({ kind: 'other', windowSeconds: null, resetsAt });
  assert.equal(F.isWeeklyWindow(other(new Date(now + 2 * HOUR).toISOString()), now), false);
  assert.equal(F.isWeeklyWindow(other(new Date(now + DAY - 1).toISOString()), now), false);
  assert.equal(F.isWeeklyWindow(other(new Date(now + DAY).toISOString()), now), true);
  assert.equal(F.isWeeklyWindow(other(new Date(now + 6 * DAY).toISOString()), now), true);
  assert.equal(F.isWeeklyWindow(other(null), now), false);
  assert.equal(F.isWeeklyWindow(other('garbage'), now), false);
  // Without `now` the old kind/windowSeconds-only behaviour is unchanged.
  assert.equal(F.isWeeklyWindow(other(new Date(now + 6 * DAY).toISOString())), false);
  // Session/weekly classification by kind still wins regardless of the reset distance.
  assert.equal(F.isWeeklyWindow({ kind: 'session', windowSeconds: 18000, resetsAt: new Date(now + 2 * HOUR).toISOString() }, now), false);
  assert.equal(F.isWeeklyWindow({ kind: 'weekly', windowSeconds: 604800, resetsAt: new Date(now + 2 * HOUR).toISOString() }, now), true);
});

test('relativeAgo and daysUntil', () => {
  const now = 1_788_700_000_000;
  assert.equal(F.relativeAgo(now - 12000, now), '12s ago');
  assert.equal(F.relativeAgo(now - 3 * MIN - 5000, now), '3m ago');
  assert.equal(F.relativeAgo(now - 2 * HOUR, now), '2h ago');
  assert.equal(F.relativeAgo(now - 3 * DAY, now), '3d ago');
  assert.equal(F.relativeAgo(now + 5000, now), '0s ago');
  assert.equal(F.relativeAgo(null, now), 'never');
  assert.equal(F.daysUntil(new Date(now + 18 * DAY + 1000).toISOString(), now), 19);
  assert.equal(F.daysUntil(new Date(now + 7 * DAY).toISOString(), now), 7);
  assert.equal(F.daysUntil(null, now), null);
});
