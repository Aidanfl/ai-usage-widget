'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const n = require('../src/main/providers/normalize.js');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const FIXED_NOW = 1788660000000; // 2026-09-05T14:40:00Z

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

test('normalizeClaude: real payload → session, weekly, Fable rows in order with merged severity/is_active', () => {
  const r = n.normalizeClaude({
    usage: fixture('claude-usage.json'),
    profile: fixture('claude-profile.json'),
    credentials: fixture('claude-credentials.json').claudeAiOauth,
  });
  assert.deepEqual(r.windows.map((w) => w.key), ['session', 'weekly', 'weekly_fable']);

  const [session, weekly, fable] = r.windows;
  assert.equal(session.label, 'Current Session');
  assert.equal(session.kind, 'session');
  assert.equal(session.percent, 20);
  assert.equal(session.windowSeconds, 18000);
  assert.equal(session.color, 'purple');
  assert.equal(session.severity, 'normal');
  assert.equal(session.isActive, false);
  assert.equal(session.resetsAt, '2026-09-06T06:29:59.979Z'); // microsecond ISO normalised to ms

  assert.equal(weekly.label, 'Weekly Limit');
  assert.equal(weekly.kind, 'weekly');
  assert.equal(weekly.percent, 22);
  assert.equal(weekly.windowSeconds, 604800);
  assert.equal(weekly.color, 'blue');
  assert.equal(weekly.isActive, true);

  assert.equal(fable.label, 'Fable Weekly');
  assert.equal(fable.kind, 'weekly_scoped');
  assert.equal(fable.percent, 10);
  assert.equal(fable.color, 'fuchsia');
  assert.equal(fable.scope, 'Fable');
  assert.equal(fable.windowSeconds, 604800);
  assert.equal(fable.isActive, false);

  assert.equal(r.plan, 'Max 20x');
  assert.equal(r.account, 'Tester');
});

test('normalizeClaude: extra usage from spend + extra_usage (no cap → percent null)', () => {
  const r = n.normalizeClaude({ usage: fixture('claude-usage.json') });
  assert.deepEqual(r.extra, {
    enabled: true, currency: 'USD', exponent: 2, usedMinor: 7519, limitMinor: null, percent: null,
    balanceMinor: null, promoMinor: null, paidMinor: null, nextExpiresAt: null, nextExpiryMinor: null, disabledReason: null,
  });
});

test('normalizeClaude: extra usage percent comes from spend.percent when a cap exists, computed otherwise', () => {
  const usage = fixture('claude-usage.json');
  usage.spend.limit = { amount_minor: 10000, currency: 'USD', exponent: 2 };
  usage.spend.percent = 75;
  let r = n.normalizeClaude({ usage });
  assert.equal(r.extra.limitMinor, 10000);
  assert.equal(r.extra.percent, 75);

  delete usage.spend.percent;
  r = n.normalizeClaude({ usage });
  assert.equal(r.extra.percent, 75.19); // 7519 / 10000
});

test('normalizeClaude: claude.ai web overage + prepaid payloads merge into extra', () => {
  const usage = { five_hour: { utilization: 1, resets_at: '2026-09-06T06:29:59Z' }, seven_day: { utilization: 2, resets_at: '2026-09-07T13:59:59Z' } };
  const web = {
    overage: { monthly_credit_limit: 5000, used_credits: 1250, is_enabled: true, currency: 'USD' },
    prepaid: {
      amount: 2500, currency: 'USD',
      promo_tranches: [{ remaining_amount_minor_units: 500, expires_at: '2026-10-01T00:00:00Z' }],
      tranches: [{ remaining_amount_minor_units: 2000, expires_at: '2027-01-01T00:00:00Z' }],
      next_expires_at: '2026-10-01T00:00:00Z',
    },
    org: { name: 'Web Org', raven_type: 'team', capabilities: ['chat'] },
  };
  const r = n.normalizeClaude({ usage, web });
  assert.equal(r.extra.enabled, true);
  assert.equal(r.extra.usedMinor, 1250);
  assert.equal(r.extra.limitMinor, 5000);
  assert.equal(r.extra.percent, 25);
  assert.equal(r.extra.balanceMinor, 2500);
  assert.equal(r.extra.promoMinor, 500);
  assert.equal(r.extra.paidMinor, 2000);
  assert.equal(r.extra.nextExpiresAt, '2026-10-01T00:00:00.000Z');
  assert.equal(r.extra.nextExpiryMinor, 500);
  assert.equal(r.plan, 'Team');
  assert.equal(r.account, 'Web Org');

  // Legacy overage field names + disabled flag.
  const r2 = n.normalizeClaude({ usage, web: { overage: { spend_limit_amount_cents: 1000, balance_cents: 10, is_enabled: false } } });
  assert.equal(r2.extra.enabled, false);
});

test('normalizeClaude: plan falls back to profile tier, then subscriptionType', () => {
  const usage = fixture('claude-usage.json');
  assert.equal(n.normalizeClaude({ usage, profile: fixture('claude-profile.json') }).plan, 'Max 20x');
  assert.equal(n.normalizeClaude({ usage, credentials: { subscriptionType: 'max' } }).plan, 'Max');
  assert.equal(n.normalizeClaude({ usage }).plan, null);
  assert.equal(n.normalizeClaude({ usage }).account, null);
});

test('normalizeClaude: null buckets are never rendered; codename buckets only when live', () => {
  const usage = fixture('claude-usage.json');
  // nimbus_quill is non-null but utilization 0 / resets_at null → ignored
  let r = n.normalizeClaude({ usage });
  assert.ok(!r.windows.some((w) => w.key === 'nimbus_quill'));
  assert.ok(!r.windows.some((w) => /tangelo|omelette|opus|sonnet|cowork|oauth/.test(w.key)));

  usage.nimbus_quill = { utilization: 12, resets_at: '2026-09-07T13:59:59Z' };
  r = n.normalizeClaude({ usage });
  const nq = r.windows.find((w) => w.key === 'nimbus_quill');
  assert.ok(nq, 'live codename bucket renders');
  assert.equal(nq.label, 'Nimbus Quill');
  assert.equal(nq.kind, 'other');
  assert.equal(nq.percent, 12);
  assert.equal(nq.windowSeconds, null);
  assert.equal(r.windows[r.windows.length - 1], nq, 'other rows sort last');
});

test('normalizeClaude: legacy seven_day_* buckets render only when non-null and not covered by a scoped limit', () => {
  const usage = fixture('claude-usage.json');
  usage.seven_day_opus = { utilization: 33, resets_at: '2026-09-07T13:59:59Z' };
  usage.seven_day_omelette = { utilization: 5, resets_at: '2026-09-07T13:59:59Z' };
  let r = n.normalizeClaude({ usage });
  const opus = r.windows.find((w) => w.key === 'weekly_opus');
  const design = r.windows.find((w) => w.key === 'weekly_design');
  assert.equal(opus.label, 'Opus Weekly');
  assert.equal(opus.kind, 'weekly_scoped');
  assert.equal(opus.percent, 33);
  assert.equal(design.label, 'Design Weekly');
  // Fable stays fuchsia; the extra rows rotate rose/amber/slate
  assert.equal(r.windows.find((w) => w.key === 'weekly_fable').color, 'fuchsia');
  assert.deepEqual([opus.color, design.color], ['rose', 'amber']);

  // A scoped limit for Opus makes the legacy bucket redundant.
  usage.limits.push({ kind: 'weekly_scoped', percent: 40, severity: 'warning', resets_at: '2026-09-07T13:59:59Z', scope: { model: { display_name: 'Opus' } }, is_active: false });
  r = n.normalizeClaude({ usage });
  const opusRows = r.windows.filter((w) => w.key === 'weekly_opus');
  assert.equal(opusRows.length, 1);
  assert.equal(opusRows[0].percent, 40, 'limits[] is authoritative');
  assert.equal(opusRows[0].severity, 'warning');
});

test('normalizeClaude: session/weekly rows come from limits[] when the bucket is null', () => {
  const usage = fixture('claude-usage.json');
  usage.five_hour = null;
  const r = n.normalizeClaude({ usage });
  const session = r.windows.find((w) => w.key === 'session');
  assert.ok(session);
  assert.equal(session.percent, 20);
  assert.equal(session.resetsAt, '2026-09-06T06:29:59.979Z');
});

test('normalizeClaude: empty / garbage input never throws', () => {
  assert.deepEqual(n.normalizeClaude({}), { windows: [], extra: null, plan: null, account: null });
  assert.deepEqual(n.normalizeClaude({ usage: null }).windows, []);
  assert.deepEqual(n.normalizeClaude({ usage: { limits: 'nope', five_hour: 'x' } }).windows, []);
});

test('normalizeClaude: the Fable row carries the 50 %-share note; every other row has note null', () => {
  const usage = fixture('claude-usage.json');
  usage.seven_day_opus = { utilization: 33, resets_at: '2026-09-07T13:59:59Z' };
  usage.nimbus_quill = { utilization: 12, resets_at: '2026-09-07T13:59:59Z' };
  const r = n.normalizeClaude({ usage });
  const fable = r.windows.find((w) => w.key === 'weekly_fable');
  assert.equal(fable.note, "Percent of Fable's 50% share of the weekly limit");
  assert.equal(fable.note, n.FABLE_NOTE);
  for (const w of r.windows) if (w.key !== 'weekly_fable') assert.equal(w.note, null, w.key);
  assert.ok(Object.prototype.hasOwnProperty.call(r.windows[0], 'note'), 'note is always present on UsageWindow');
  // A scoped limit for another model gets no note.
  usage.limits.push({ kind: 'weekly_scoped', percent: 4, severity: 'normal', resets_at: '2026-09-07T13:59:59Z', scope: { model: { display_name: 'Opus' } }, is_active: false });
  assert.equal(n.normalizeClaude({ usage }).windows.find((w) => w.key === 'weekly_opus').note, null);
  // Codex rows carry the field too (null).
  for (const w of n.normalizeCodex({ usage: fixture('codex-usage-plus.json'), now: () => FIXED_NOW }).windows) assert.equal(w.note, null);
});

test('normalizeClaude: juniper_tide (limit-reset eligibility block) is never rendered, even when populated', () => {
  const usage = fixture('claude-usage.json');
  usage.juniper_tide = {
    eligible: true, ineligible_reason: null, in_experiment: true, arm: 'reset', available: true,
    next_available_at: '2026-09-07T13:59:59Z', weekly_resets_at: '2026-09-07T13:59:59Z', resets_per_week: 1,
    utilization: 100, resets_at: '2026-09-07T13:59:59Z', // even with bucket-looking fields it must be ignored
  };
  const r = n.normalizeClaude({ usage });
  assert.deepEqual(r.windows.map((w) => w.key), ['session', 'weekly', 'weekly_fable']);
  assert.ok(!r.windows.some((w) => /juniper/.test(w.key) || /Juniper/.test(w.label)));
});

test('normalizeClaude: OAuth prepaid credits payload (research §1.7) maps to balance / paid / promo / next expiry', () => {
  const usage = fixture('claude-usage.json');
  const prepaid = {
    amount: 17481, currency: 'USD', balance: { money: null, credits: { amount_minor: 17481, exponent: 2 } }, balance_credits: 174,
    tranches: [{ remaining_amount_minor_units: 17480, currency: 'USD', expires_at: null, granted_amount_minor_units: 25000 }],
    promo_tranches: [], next_expires_at: null,
  };
  let r = n.normalizeClaude({ usage, prepaid });
  assert.equal(r.extra.balanceMinor, 17481, 'headline = top-level amount, not the tranche sum');
  assert.equal(r.extra.paidMinor, 17480);
  assert.equal(r.extra.promoMinor, 0);
  assert.equal(r.extra.nextExpiresAt, null);
  assert.equal(r.extra.nextExpiryMinor, null);
  assert.equal(r.extra.usedMinor, 7519, 'spend fields from /usage untouched');
  assert.equal(r.extra.currency, 'USD');

  // EUR account with promo credits only (research §8.8) and mixed expiries.
  const eur = {
    amount: 5597, currency: 'EUR', balance: { money: { amount_minor: 5597, currency: 'EUR', exponent: 2 }, credits: null }, balance_credits: null,
    tranches: [{ remaining_amount_minor_units: 1000, expires_at: '2026-12-01T00:00:00Z' }, { remaining_amount_minor_units: 200, expires_at: '2026-09-19T00:00:00Z' }],
    promo_tranches: [{ remaining_amount_minor_units: 4396, granted_amount_minor_units: 8500, currency: 'EUR', expires_at: '2026-09-19T00:00:00Z' }],
    next_expires_at: '2026-09-19T00:00:00Z',
  };
  r = n.normalizeClaude({ usage: { five_hour: { utilization: 1, resets_at: '2026-09-06T06:29:59Z' } }, prepaid: eur });
  assert.equal(r.extra.balanceMinor, 5597);
  assert.equal(r.extra.promoMinor, 4396);
  assert.equal(r.extra.paidMinor, 1200);
  assert.equal(r.extra.nextExpiresAt, '2026-09-19T00:00:00.000Z');
  assert.equal(r.extra.nextExpiryMinor, 4596, 'promo 4396 + paid 200 expiring on next_expires_at');
  assert.equal(r.extra.currency, 'EUR', 'currency from the prepaid payload when /usage has none');

  // `prepaid` wins over web.prepaid when both are given; null prepaid leaves extra as before.
  assert.equal(n.normalizeClaude({ usage, prepaid, web: { prepaid: { amount: 1 } } }).extra.balanceMinor, 17481);
  assert.equal(n.normalizeClaude({ usage, prepaid: null }).extra.balanceMinor, null);
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

test('normalizeCodex: weekly-only payload → exactly one Weekly row, never an invented 5h row', () => {
  const r = n.normalizeCodex({ usage: fixture('codex-usage-weekly-only.json'), now: () => FIXED_NOW });
  assert.equal(r.windows.length, 1);
  const [w] = r.windows;
  assert.equal(w.key, 'primary');
  assert.equal(w.label, 'Weekly Limit');
  assert.equal(w.kind, 'weekly');
  assert.equal(w.percent, 99);
  assert.equal(w.windowSeconds, 604800);
  assert.equal(w.color, 'teal');
  assert.equal(w.severity, null);
  assert.equal(w.isActive, null);
  assert.equal(w.resetsAt, new Date(1789243350 * 1000).toISOString());
  assert.equal(r.plan, 'Business');
  assert.equal(r.account, 'tester@example.com');
  assert.equal(r.credits.hasCredits, false);
  assert.equal(r.credits.limitReached, false);
  assert.equal(r.credits.allowed, true);
  assert.equal(r.credits.resetCreditsAvailable, 0);
  assert.deepEqual(r.credits.modelUsage, { 'gpt-6-astra': { available: true, availableAt: null, creditsWouldEnable: false } });
});

test('normalizeCodex: plus payload → 5h then weekly, credits populated', () => {
  const r = n.normalizeCodex({ usage: fixture('codex-usage-plus.json'), now: () => FIXED_NOW });
  assert.deepEqual(r.windows.map((w) => [w.key, w.label, w.kind, w.color, w.windowSeconds]), [
    ['primary', '5-Hour Limit', 'session', 'green', 18000],
    ['secondary', 'Weekly Limit', 'weekly', 'teal', 604800],
  ]);
  assert.equal(r.plan, 'Plus');
  assert.equal(r.credits.balance, '4.5');
  assert.deepEqual(r.credits.approxLocalMessages, [12, 40]);
  assert.equal(r.credits.resetCreditsAvailable, 1);
});

test('normalizeCodex: windows are classified by duration, not slot — a 5h window in the secondary slot sorts first', () => {
  const usage = fixture('codex-usage-plus.json');
  const { primary_window, secondary_window } = usage.rate_limit;
  usage.rate_limit.primary_window = secondary_window; // weekly now in primary
  usage.rate_limit.secondary_window = primary_window; // 5h now in secondary
  const r = n.normalizeCodex({ usage, now: () => FIXED_NOW });
  assert.deepEqual(r.windows.map((w) => [w.key, w.label]), [['secondary', '5-Hour Limit'], ['primary', 'Weekly Limit']]);
});

test('normalizeCodex: code review + additional buckets get their own rows and stable keys', () => {
  const r = n.normalizeCodex({ usage: fixture('codex-usage-additional.json'), now: () => FIXED_NOW });
  assert.deepEqual(r.windows.map((w) => w.key), [
    'primary',
    'code_review',
    'additional_gpt_5_3_codex_spark_5h',
    'additional_gpt_5_3_codex_spark_weekly',
    'additional_gpt_reserve_weekly',
  ]);
  const review = r.windows[1];
  assert.equal(review.label, 'Code Review Weekly');
  assert.equal(review.kind, 'other');
  assert.equal(review.percent, 5);
  const spark5h = r.windows[2];
  assert.equal(spark5h.label, 'GPT-5.3-Codex-Spark 5-Hour');
  assert.equal(spark5h.windowSeconds, 18000);
  assert.equal(spark5h.scope, 'GPT-5.3-Codex-Spark');
  assert.equal(r.windows[3].color, spark5h.color, 'both windows of a bucket share a colour');
  assert.equal(r.windows[4].scope, 'gpt-5.6-luna', 'normal_model_slug wins as scope');
  assert.equal(r.plan, 'Pro 20x');
  assert.deepEqual(r.credits.modelUsage['gpt-6-astra'], { available: false, availableAt: new Date(1789022293 * 1000).toISOString(), creditsWouldEnable: true });
});

test('normalizeCodex: blocked account → severity blocked on core windows; ±5 % duration matching; reached type unwrapped', () => {
  const r = n.normalizeCodex({ usage: fixture('codex-usage-blocked.json'), now: () => FIXED_NOW });
  assert.deepEqual(r.windows.map((w) => [w.label, w.severity, w.windowSeconds]), [
    ['5-Hour Limit', 'blocked', 17940],
    ['Weekly Limit', 'blocked', 604740],
  ]);
  assert.equal(r.credits.limitReached, true);
  assert.equal(r.credits.allowed, false);
  assert.equal(r.credits.limitReachedType, 'workspace_owner_credits_depleted');
  assert.equal(r.credits.overageLimitReached, true);
  assert.equal(r.credits.spendControlReached, true);
  assert.equal(r.credits.resetCreditsAvailable, 2);
  assert.equal(r.credits.resetCreditsApplicable, 1);
  assert.equal(r.credits.monthlyLimit.limit, '1000');
  assert.equal(r.credits.monthlyLimit.usedPercent, 100);
  assert.equal(r.plan, 'Team');
});

test('normalizeCodex: allowed=false alone blocks; plain-string reached type accepted', () => {
  const usage = fixture('codex-usage-plus.json');
  usage.rate_limit.allowed = false;
  usage.rate_limit_reached_type = 'rate_limit_reached';
  const r = n.normalizeCodex({ usage, now: () => FIXED_NOW });
  assert.ok(r.windows.every((w) => w.severity === 'blocked'));
  assert.equal(r.credits.limitReachedType, 'rate_limit_reached');
});

test('normalizeCodex: missing limit_window_seconds falls back to slot semantics; missing reset_at uses now + reset_after_seconds', () => {
  const usage = {
    plan_type: 'plus',
    rate_limit: {
      allowed: true, limit_reached: false,
      primary_window: { used_percent: 7, reset_after_seconds: 600 },
      secondary_window: { used_percent: 9, reset_after_seconds: 3600 },
    },
  };
  const r = n.normalizeCodex({ usage, now: () => FIXED_NOW });
  assert.deepEqual(r.windows.map((w) => [w.key, w.label, w.kind, w.windowSeconds]), [
    ['primary', '5-Hour Limit', 'session', null],
    ['secondary', 'Weekly Limit', 'weekly', null],
  ]);
  assert.equal(r.windows[0].resetsAt, new Date(FIXED_NOW + 600 * 1000).toISOString());
  assert.equal(r.windows[1].resetsAt, new Date(FIXED_NOW + 3600 * 1000).toISOString());
});

test('normalizeCodex: null rate_limit / empty payload → no windows, no throw, credits still shaped', () => {
  const r = n.normalizeCodex({ usage: { plan_type: 'business', rate_limit: null, credits: { has_credits: true, unlimited: false, balance: null } } });
  assert.deepEqual(r.windows, []);
  assert.equal(r.plan, 'Business');
  assert.equal(r.credits.hasCredits, true);
  assert.deepEqual(n.normalizeCodex({}).windows, []);
  assert.deepEqual(n.normalizeCodex({ usage: null }).windows, []);
});

test('codexWindowLabel: ±5 % classes, hour fallback, null for missing', () => {
  const pick = (s) => { const m = n.codexWindowLabel(s); return m && [m.label, m.kind, m.color]; };
  assert.deepEqual(pick(18000), ['5-Hour Limit', 'session', 'green']);
  assert.deepEqual(pick(17100), ['5-Hour Limit', 'session', 'green']); // -5 %
  assert.deepEqual(pick(18900), ['5-Hour Limit', 'session', 'green']); // +5 %
  assert.deepEqual(pick(86400), ['Daily Limit', 'other', 'slate']);
  assert.deepEqual(pick(604800), ['Weekly Limit', 'weekly', 'teal']);
  assert.deepEqual(pick(604740), ['Weekly Limit', 'weekly', 'teal']);   // 10079 minutes
  assert.deepEqual(pick(2592000), ['Monthly Limit', 'other', 'slate']);
  assert.deepEqual(pick(31536000), ['Annual Limit', 'other', 'slate']);
  assert.deepEqual(pick(25200), ['7-Hour Limit', 'other', 'slate']);    // outside every ±5 % band
  assert.deepEqual(pick(43200), ['12-Hour Limit', 'other', 'slate']);
  assert.deepEqual(pick(10800), ['3-Hour Limit', 'session', 'green']);  // ≤ 6 h → session kind
  assert.equal(n.codexWindowLabel(null), null);
  assert.equal(n.codexWindowLabel(undefined), null);
  assert.equal(n.codexWindowLabel(0), null);
  assert.equal(n.codexWindowLabel('abc'), null);
});

test('codexPlanLabel: research-codex §2.4 table + Title Case fallback', () => {
  const table = {
    free: 'Free', guest: 'Free', free_workspace: 'Free', go: 'Go', plus: 'Plus', prolite: 'Pro 5x', pro: 'Pro 20x',
    team: 'Team', self_serve_business_prolite: 'Business', self_serve_business_usage_based: 'Business',
    business: 'Business', ent26: 'Business', enterprise: 'Enterprise', enterprise_cbp_automation: 'Enterprise',
    enterprise_cbp_usage_based: 'Enterprise', education: 'Edu', edu: 'Edu', edu_plus: 'Edu', edu_pro: 'Edu', k12: 'Edu', quorum: 'Edu',
  };
  for (const [wire, label] of Object.entries(table)) assert.equal(n.codexPlanLabel(wire), label, wire);
  assert.equal(n.codexPlanLabel('PLUS'), 'Plus');
  assert.equal(n.codexPlanLabel('some_new_cbp_plan'), 'Some New CBP Plan');
  assert.equal(n.codexPlanLabel('future-k12-tier'), 'Future K12 Tier');
  assert.equal(n.codexPlanLabel('unknown'), null);
  assert.equal(n.codexPlanLabel(''), null);
  assert.equal(n.codexPlanLabel(null), null);
});

test('claudePlanLabel: tier mapping, generic patterns, subscriptionType fallback', () => {
  assert.equal(n.claudePlanLabel('default_claude_max_20x'), 'Max 20x');
  assert.equal(n.claudePlanLabel('default_claude_max_5x'), 'Max 5x');
  assert.equal(n.claudePlanLabel('default_claude_pro'), 'Pro');
  assert.equal(n.claudePlanLabel('default_claude_team_x'), 'Team');
  assert.equal(n.claudePlanLabel('enterprise_tier'), 'Enterprise');
  assert.equal(n.claudePlanLabel(null, 'max'), 'Max');
  assert.equal(n.claudePlanLabel(undefined, 'pro'), 'Pro');
  assert.equal(n.claudePlanLabel('something_odd', null), null);
  assert.equal(n.claudePlanLabel(null, null), null);
  assert.equal(n.claudeWebPlanLabel({ rate_limit_tier: 'default_claude_max_5x' }), 'Max 5x');
  assert.equal(n.claudeWebPlanLabel({ capabilities: ['chat', 'claude_pro'] }), 'Pro');
  assert.equal(n.claudeWebPlanLabel({}), null);
});

test('slug + sortWindows', () => {
  assert.equal(n.slug('Fable'), 'fable');
  assert.equal(n.slug('GPT-5.3-Codex-Spark'), 'gpt_5_3_codex_spark');
  assert.equal(n.slug('  OAuth Apps  '), 'oauth_apps');
  assert.equal(n.slug(null), '');

  const mk = (key, kind, windowSeconds) => ({ key, kind, windowSeconds });
  const sorted = n.sortWindows([
    mk('other2', 'other', 18000), mk('scoped', 'weekly_scoped', 604800), mk('weekly', 'weekly', 604800),
    mk('other1', 'other', 604800), mk('session', 'session', 18000),
  ]);
  assert.deepEqual(sorted.map((w) => w.key), ['session', 'weekly', 'scoped', 'other2', 'other1']);
});
