/*
 * format.js — PURE formatting helpers for the AI Usage widget renderer.
 *
 * Plain script: attaches `window.Format` in the renderer and exports the same
 * object through `module.exports` for node:test.  No DOM, no Electron.
 */
(function (root) {
  'use strict';

  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£' };

  var HOUR_MS = 3600000;
  var MINUTE_MS = 60000;
  var DAY_MS = 86400000;

  /** Elapsed-ring thresholds (fixed; independent from the usage thresholds — v1.7.6 rule). */
  var ELAPSED_AMBER_THRESHOLD = 75;
  var ELAPSED_GREEN_THRESHOLD = 90;

  /** Largest |ms| a Date can hold (ECMA-262 §21.4.1.1); beyond it `new Date(n)` is Invalid Date. */
  var MAX_DATE_MS = 8.64e15;

  /** ISO string | number | Date → ms epoch, or null when missing/unparseable. */
  function toMs(value) {
    if (value === null || value === undefined || value === '') return null;
    // A finite but out-of-range number would pass here and later render as "NaN:NaN PM" / "undefined NaN".
    if (typeof value === 'number') return isFinite(value) && Math.abs(value) <= MAX_DATE_MS ? value : null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value.getTime();
    if (typeof value !== 'string') return null;
    var t = Date.parse(value);
    return isNaN(t) ? null : t;
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** ms → "43m" | "4h 12m" | "1d 8h" (original v1.7.6 granularity). Negative/zero → "0m". */
  function formatDuration(ms) {
    if (ms === null || ms === undefined || !isFinite(ms) || ms <= 0) return '0m';
    var hours = Math.floor(ms / HOUR_MS);
    var minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
    if (hours >= 24) return Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h';
    if (hours > 0) return hours + 'h ' + minutes + 'm';
    return minutes + 'm';
  }

  /**
   * "Resets in" cell text.
   *  - no resetsAt and no usage → "Not started"
   *  - no resetsAt but usage > 0 → "—"
   *  - resetsAt in the past → "Resetting..."
   *  - otherwise the duration until reset.
   */
  function formatResetsIn(resetsAt, percent, now) {
    var t = toMs(resetsAt);
    var at = typeof now === 'number' ? now : Date.now();
    if (t === null) return (percent > 0) ? '—' : 'Not started';
    var diff = t - at;
    if (diff <= 0) return 'Resetting...';
    return formatDuration(diff);
  }

  /** Date/ms → "3:59 PM" (12h) or "15:59" (24h). */
  function formatTime(value, timeFormat) {
    var t = toMs(value);
    if (t === null) return '—';
    var d = new Date(t);
    var h = d.getHours();
    var m = pad2(d.getMinutes());
    if (timeFormat === '24h') return pad2(h) + ':' + m;
    var period = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12 || 12;
    return h12 + ':' + m + ' ' + period;
  }

  /**
   * Date/ms → 'date' "Sep 7" | 'date-day' "Mon Sep 7" | 'date-day-time' "Mon Sep 7 3:59 PM".
   * Day/month names are English 3-letter (as the original). Local timezone.
   */
  function formatDate(value, dateFormat, timeFormat) {
    var t = toMs(value);
    if (t === null) return '—';
    var d = new Date(t);
    var base = MONTH_NAMES[d.getMonth()] + ' ' + d.getDate();
    if (dateFormat === 'date-day') return DAY_NAMES[d.getDay()] + ' ' + base;
    if (dateFormat === 'date-day-time') return DAY_NAMES[d.getDay()] + ' ' + base + ' ' + formatTime(t, timeFormat);
    return base;
  }

  /**
   * "Resets at" cell text.
   * opts: { isWeekly: boolean, timeFormat: '12h'|'24h', dateFormat: 'date'|'date-day'|'date-day-time' }
   * Session-style windows show the time only; weekly-style windows use the date format.
   * Missing resetsAt → em dash.
   */
  function formatResetsAt(resetsAt, opts) {
    opts = opts || {};
    var t = toMs(resetsAt);
    if (t === null) return '—';
    if (!opts.isWeekly) return formatTime(t, opts.timeFormat || '12h');
    return formatDate(t, opts.dateFormat || 'date', opts.timeFormat || '12h');
  }

  /** Tooltip-style "Sep 7, 3:59 PM". */
  function formatDateTime(value, timeFormat) {
    var t = toMs(value);
    if (t === null) return '—';
    return formatDate(t, 'date') + ', ' + formatTime(t, timeFormat);
  }

  /**
   * Minor units + ISO currency → "$75.19" / "€12.00" / "£3.50" / "12.34 CHF".
   * Missing currency defaults to USD ("$"), fixing the original's "12.34 USD" fallback.
   * opts.exponent (default 2), opts.stripWholeCents (drop ".00" — used for caps: "$50").
   * Returns null when the amount is missing.
   */
  function formatCurrency(minor, currency, opts) {
    opts = opts || {};
    if (minor === null || minor === undefined || typeof minor !== 'number' || !isFinite(minor)) return null;
    var exponent = typeof opts.exponent === 'number' && isFinite(opts.exponent) ? opts.exponent : 2;
    // Number#toFixed throws a RangeError outside 0..100; a currency exponent past 20 is meaningless anyway.
    exponent = Math.min(20, Math.max(0, Math.floor(exponent)));
    var code = String(currency || 'USD').toUpperCase();
    var amount = Math.abs(minor) / Math.pow(10, exponent);
    var str = amount.toFixed(exponent);
    if (opts.stripWholeCents && exponent > 0 && /\.0+$/.test(str)) str = str.replace(/\.0+$/, '');
    var sign = minor < 0 ? '-' : '';
    var sym = CURRENCY_SYMBOLS[code];
    if (sym) return sign + sym + str;
    return sign + str + ' ' + code;
  }

  /** 0..100 clamp; non-numbers → 0. */
  function clampPercent(p) {
    if (typeof p !== 'number' || !isFinite(p)) return 0;
    return Math.min(100, Math.max(0, p));
  }

  /**
   * Fraction of the window that has elapsed (0..1) given the reset time and window length.
   * Returns null when either input is missing. Negative (reset further away than the window) clamps to 0.
   */
  function elapsedFraction(resetsAt, windowSeconds, now) {
    var t = toMs(resetsAt);
    if (t === null || !windowSeconds || windowSeconds <= 0) return null;
    var at = typeof now === 'number' ? now : Date.now();
    var windowMs = windowSeconds * 1000;
    var diff = t - at;
    if (diff <= 0) return 1;
    var frac = (windowMs - diff) / windowMs;
    return Math.min(1, Math.max(0, frac));
  }

  /** '' | 'warning' | 'danger' by the user thresholds (>= comparisons, as the original). */
  function thresholdClass(percent, warn, danger) {
    if (typeof percent !== 'number' || !isFinite(percent)) return '';
    var w = typeof warn === 'number' ? warn : 75;
    var d = typeof danger === 'number' ? danger : 90;
    if (percent >= d) return 'danger';
    if (percent >= w) return 'warning';
    return '';
  }

  /** Elapsed-ring override: '' | 'elapsed-warn' (>=75%) | 'elapsed-soon' (>=90%). */
  function ringClass(elapsedPercent) {
    if (typeof elapsedPercent !== 'number' || !isFinite(elapsedPercent)) return '';
    if (elapsedPercent >= ELAPSED_GREEN_THRESHOLD) return 'elapsed-soon';
    if (elapsedPercent >= ELAPSED_AMBER_THRESHOLD) return 'elapsed-warn';
    return '';
  }

  /**
   * Whether a window should use the date format for "resets at" (weekly-style / >= 1 day).
   * When `now` is given, a reset a day or more away also counts — a time-only "3:59 PM" is ambiguous for
   * `kind: 'other'` rows with an unknown window length (Codex code review, unknown Claude buckets).
   */
  function isWeeklyWindow(win, now) {
    if (!win) return false;
    if (win.kind === 'weekly' || win.kind === 'weekly_scoped') return true;
    if (typeof win.windowSeconds === 'number' && win.windowSeconds >= DAY_MS / 1000) return true;
    if (typeof now === 'number') {
      var t = toMs(win.resetsAt);
      if (t !== null && t - now >= DAY_MS) return true;
    }
    return false;
  }

  /** UsageWindow → "5H" | "7D" | "24H" | "30D" | "" */
  function shortWindowName(win) {
    if (!win) return '';
    var ws = win.windowSeconds;
    if (typeof ws === 'number' && ws > 0) {
      if (ws >= DAY_MS / 1000) return Math.round(ws / (DAY_MS / 1000)) + 'D';
      return Math.round(ws / 3600) + 'H';
    }
    if (win.kind === 'session') return '5H';
    if (win.kind === 'weekly' || win.kind === 'weekly_scoped') return '7D';
    return '';
  }

  /** Compact-row label: "CLAUDE 5H" / "CLAUDE 7D" / "FABLE 7D" / "CODEX 7D". */
  function compactLabel(providerName, win) {
    var base = (win && win.kind === 'weekly_scoped' && win.scope) ? win.scope : (providerName || '');
    var short = shortWindowName(win);
    var text = short ? base + ' ' + short : base + ' ' + ((win && win.label) || '');
    return text.trim().toUpperCase();
  }

  /** Legend label for the chart: "Claude 5h" / "Fable 7d" / "Codex 7d". */
  function seriesLabel(providerName, win) {
    var base = (win && win.kind === 'weekly_scoped' && win.scope) ? win.scope : (providerName || '');
    var short = shortWindowName(win);
    return short ? base + ' ' + short.toLowerCase() : (base + ' ' + ((win && win.label) || '')).trim();
  }

  /** "updated 12s ago" helper: ms epoch → "12s ago" | "3m ago" | "2h ago" | "5d ago" | "never". */
  function relativeAgo(ts, now) {
    var t = toMs(ts);
    if (t === null) return 'never';
    var at = typeof now === 'number' ? now : Date.now();
    var diff = Math.max(0, at - t);
    var s = Math.floor(diff / 1000);
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  /** Whole days until an ISO date (ceil), null when missing. */
  function daysUntil(value, now) {
    var t = toMs(value);
    if (t === null) return null;
    var at = typeof now === 'number' ? now : Date.now();
    return Math.ceil((t - at) / DAY_MS);
  }

  var Format = {
    ELAPSED_AMBER_THRESHOLD: ELAPSED_AMBER_THRESHOLD,
    ELAPSED_GREEN_THRESHOLD: ELAPSED_GREEN_THRESHOLD,
    toMs: toMs,
    formatDuration: formatDuration,
    formatResetsIn: formatResetsIn,
    formatTime: formatTime,
    formatDate: formatDate,
    formatResetsAt: formatResetsAt,
    formatDateTime: formatDateTime,
    formatCurrency: formatCurrency,
    clampPercent: clampPercent,
    elapsedFraction: elapsedFraction,
    thresholdClass: thresholdClass,
    ringClass: ringClass,
    isWeeklyWindow: isWeeklyWindow,
    shortWindowName: shortWindowName,
    compactLabel: compactLabel,
    seriesLabel: seriesLabel,
    relativeAgo: relativeAgo,
    daysUntil: daysUntil
  };

  root.Format = Format;
  if (typeof module !== 'undefined') module.exports = Format;
})(typeof window !== 'undefined' ? window : globalThis);
