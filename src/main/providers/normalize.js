'use strict';

/**
 * normalize.js — PURE: raw provider payloads → ProviderSnapshot fragments.
 *
 * No I/O, no Electron, no clocks except the injected `now`. Everything here is
 * unit-tested against fixtures in tests/fixtures. See ARCHITECTURE.md §3 for the
 * UsageWindow / ExtraUsage / CodexCredits shapes and the row-derivation rules.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** "GPT-5.3-Codex-Spark" → "gpt_5_3_codex_spark"; "Fable" → "fable". Stable ids for window keys. */
function slug(displayName) {
  return String(displayName == null ? '' : displayName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** "nimbus_quill" → "Nimbus Quill" (labels for unknown codename buckets / unknown plans). */
function titleCase(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Finite number or null — API fields are frequently null and we never want NaN in the renderer. */
function num(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalise a timestamp to ISO-8601 with millisecond precision.
 * Claude sends microsecond ISO strings ("…59.979240+00:00"), Codex sends unix seconds;
 * the renderer only ever sees one format.
 */
function isoFromAny(value, { unixSeconds = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  let d;
  if (typeof value === 'number') d = new Date(unixSeconds ? value * 1000 : value);
  else d = new Date(value);
  if (Number.isNaN(d.getTime())) return typeof value === 'string' ? value : null; // keep unparseable strings as-is
  return d.toISOString();
}

/** Colour rotation for rows beyond the fixed ones (scoped models that are not Fable, legacy buckets…). */
function makeColorCycle(colors) {
  let i = 0;
  return () => colors[i++ % colors.length];
}

/**
 * Sort so that session (5h) rows precede weekly rows, which precede scoped weekly
 * rows, which precede everything else; shorter windows first inside the core groups.
 * `other` rows keep input order so a bucket's 5h/weekly pair stays together.
 * Stable: ties keep input order.
 */
const KIND_RANK = { session: 0, weekly: 1, weekly_scoped: 2, other: 3 };
function sortWindows(windows) {
  return windows
    .map((w, i) => ({ w, i }))
    .sort((a, b) => {
      const ra = KIND_RANK[a.w.kind] ?? 9;
      const rb = KIND_RANK[b.w.kind] ?? 9;
      if (ra !== rb) return ra - rb;
      if (a.w.kind !== 'other') {
        const sa = a.w.windowSeconds == null ? Infinity : a.w.windowSeconds;
        const sb = b.w.windowSeconds == null ? Infinity : b.w.windowSeconds;
        if (sa !== sb) return sa - sb;
      }
      return a.i - b.i;
    })
    .map((x) => x.w);
}

function makeWindow(fields) {
  return {
    key: fields.key,
    label: fields.label,
    kind: fields.kind,
    percent: fields.percent == null ? 0 : fields.percent,
    resetsAt: fields.resetsAt ?? null,
    windowSeconds: fields.windowSeconds ?? null,
    severity: fields.severity ?? null,
    isActive: fields.isActive ?? null,
    color: fields.color,
    scope: fields.scope ?? null,
    note: fields.note ?? null, // tooltip text for rows whose percent needs explaining (Fable); null otherwise
  };
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

const FIVE_HOURS = 18000;
const SEVEN_DAYS = 604800;

/** Legacy per-surface weekly buckets that predate `limits[]`; `omelette` is Claude Design's codename. */
const CLAUDE_LEGACY_BUCKETS = {
  seven_day_opus: { slug: 'opus', label: 'Opus Weekly', scope: 'Opus' },
  seven_day_sonnet: { slug: 'sonnet', label: 'Sonnet Weekly', scope: 'Sonnet' },
  seven_day_cowork: { slug: 'cowork', label: 'Cowork Weekly', scope: 'Cowork' },
  seven_day_oauth_apps: { slug: 'oauth_apps', label: 'OAuth Apps Weekly', scope: 'OAuth Apps' },
  seven_day_omelette: { slug: 'design', label: 'Design Weekly', scope: 'Design' },
};

/**
 * Top-level keys of /api/oauth/usage that are NOT usage buckets. `juniper_tide` is the `/limit-reset`
 * eligibility block (research-claude.md §1.4.6) — never a usage window, ignored entirely.
 */
const CLAUDE_NON_BUCKET_KEYS = new Set([
  'five_hour', 'seven_day', 'extra_usage', 'limits', 'spend', 'member_dashboard_available', 'juniper_tide',
  ...Object.keys(CLAUDE_LEGACY_BUCKETS),
]);

/**
 * Fable's `weekly_scoped.percent` is relative to Fable's own allotment — 50 % of the weekly pool — not
 * to the whole weekly limit (research-claude.md §1.4.3, numerically confirmed). The renderer shows this
 * as a tooltip on the row.
 */
const FABLE_NOTE = "Percent of Fable's 50% share of the weekly limit";

/**
 * Friendly plan label from Claude Code credentials.
 *   default_claude_max_20x → 'Max 20x', default_claude_max_5x → 'Max 5x', default_claude_pro → 'Pro',
 *   otherwise generic pattern matching, otherwise subscriptionType capitalised.
 */
function claudePlanLabel(rateLimitTier, subscriptionType) {
  const tier = typeof rateLimitTier === 'string' ? rateLimitTier.toLowerCase() : '';
  if (tier) {
    const max = tier.match(/max[_-]?(\d+)x/);
    if (max) return `Max ${max[1]}x`;
    if (/\bmax\b|_max$/.test(tier)) return 'Max';
    if (/enterprise/.test(tier)) return 'Enterprise';
    if (/team/.test(tier)) return 'Team';
    if (/pro\b|_pro$|_pro_/.test(tier)) return 'Pro';
    if (/free/.test(tier)) return 'Free';
  }
  if (typeof subscriptionType === 'string' && subscriptionType.trim()) return titleCase(subscriptionType);
  return null;
}

/**
 * Plan label from a claude.ai /api/organizations entry (claude_web source).
 * ASSUMPTION (research-claude.md was not available): orgs expose `rate_limit_tier`,
 * `raven_type` ('team') and `capabilities` (e.g. 'claude_max', 'claude_pro'). Anything
 * unknown → null so the chip is simply hidden.
 */
function claudeWebPlanLabel(org) {
  if (!org || typeof org !== 'object') return null;
  const fromTier = claudePlanLabel(org.rate_limit_tier, null);
  if (fromTier) return fromTier;
  if (org.raven_type === 'team') return 'Team';
  if (org.raven_type === 'enterprise') return 'Enterprise';
  const caps = Array.isArray(org.capabilities) ? org.capabilities : [];
  if (caps.includes('claude_max')) return 'Max';
  if (caps.includes('claude_pro')) return 'Pro';
  if (typeof org.organization_type === 'string') return claudePlanLabel(org.organization_type, null);
  return null;
}

/** Index `limits[]` by kind for O(1) merge into the bucket rows. */
function indexClaudeLimits(limits) {
  const byKind = { session: null, weekly_all: null, scoped: [] };
  if (!Array.isArray(limits)) return byKind;
  for (const l of limits) {
    if (!l || typeof l !== 'object') continue;
    if (l.kind === 'session' && !byKind.session) byKind.session = l;
    else if (l.kind === 'weekly_all' && !byKind.weekly_all) byKind.weekly_all = l;
    else if (l.kind === 'weekly_scoped') byKind.scoped.push(l);
  }
  return byKind;
}

/**
 * Build a session/weekly row from the bucket (`five_hour` / `seven_day`) with severity/is_active
 * merged from the matching `limits[]` entry. If the bucket is null but limits[] carries the row,
 * limits[] wins (it is the authoritative newer surface). Returns null when neither exists.
 */
function claudeCoreRow({ bucket, limit, key, label, kind, windowSeconds, color }) {
  const hasBucket = bucket && typeof bucket === 'object';
  const hasLimit = limit && typeof limit === 'object' && num(limit.percent) != null;
  if (!hasBucket && !hasLimit) return null;
  const percent = hasBucket && num(bucket.utilization) != null ? num(bucket.utilization) : num(limit && limit.percent);
  const resetsAt = isoFromAny(hasBucket && bucket.resets_at ? bucket.resets_at : (limit && limit.resets_at));
  return makeWindow({
    key, label, kind, windowSeconds, color,
    percent,
    resetsAt,
    severity: limit && typeof limit.severity === 'string' ? limit.severity : null,
    isActive: limit && typeof limit.is_active === 'boolean' ? limit.is_active : null,
  });
}

/**
 * Derive ExtraUsage from oauth `extra_usage` + `spend`, plus optional claude.ai web payloads
 * (`web.overage` = /overage_spend_limit, `web.prepaid` = /prepaid/credits) or the OAuth mirror of the
 * prepaid endpoint (`prepaidPayload` = /api/oauth/organizations/<org>/prepaid/credits — same shape,
 * research-claude.md §1.7). Amounts are minor units.
 */
function claudeExtra(usage, web, prepaidPayload) {
  const eu = usage && usage.extra_usage && typeof usage.extra_usage === 'object' ? usage.extra_usage : null;
  const sp = usage && usage.spend && typeof usage.spend === 'object' ? usage.spend : null;
  const overage = web && web.overage && typeof web.overage === 'object' ? web.overage : null;
  const prepaid = prepaidPayload && typeof prepaidPayload === 'object'
    ? prepaidPayload
    : (web && web.prepaid && typeof web.prepaid === 'object' ? web.prepaid : null);
  if (!eu && !sp && !overage && !prepaid) return null;

  const used = sp && sp.used && typeof sp.used === 'object' ? sp.used : null;
  const limit = sp && sp.limit && typeof sp.limit === 'object' ? sp.limit : null;
  const balance = sp && sp.balance && typeof sp.balance === 'object' ? sp.balance : null;

  let enabled = null;
  if (sp && typeof sp.enabled === 'boolean') enabled = sp.enabled;
  else if (eu && typeof eu.is_enabled === 'boolean') enabled = eu.is_enabled;

  let currency = (used && used.currency) || (eu && eu.currency) || null;
  let exponent = (used && num(used.exponent)) ?? (eu && num(eu.decimal_places)) ?? 2;

  // `spend.used.amount_minor` and `extra_usage.used_credits` are the same number on the wire (7519 == 7519.0).
  let usedMinor = (used && num(used.amount_minor)) ?? (eu && num(eu.used_credits)) ?? null;
  let limitMinor = (limit && num(limit.amount_minor)) ?? (eu && num(eu.monthly_limit)) ?? null;
  let balanceMinor = (balance && num(balance.amount_minor)) ?? null;
  let disabledReason = (sp && sp.disabled_reason) || (eu && eu.disabled_reason) || null;
  let promoMinor = null; let paidMinor = null; let nextExpiresAt = null; let nextExpiryMinor = null;

  // claude.ai /overage_spend_limit — two naming generations, see spec-main.md §4.6.
  if (overage) {
    const oLimit = num(overage.monthly_credit_limit ?? overage.spend_limit_amount_cents);
    const oUsed = num(overage.used_credits ?? overage.balance_cents);
    const oEnabled = overage.is_enabled !== undefined ? Boolean(overage.is_enabled) : oLimit != null;
    enabled = oEnabled;
    if (oEnabled && oLimit != null && oLimit > 0 && oUsed != null) { usedMinor = oUsed; limitMinor = oLimit; }
    if (overage.currency) currency = overage.currency;
  }
  // claude.ai /prepaid/credits — balance plus promo/paid tranche split and next expiry.
  if (prepaid && num(prepaid.amount) != null) {
    balanceMinor = num(prepaid.amount);
    if (!currency && prepaid.currency) currency = prepaid.currency;
    const sum = (arr) => (Array.isArray(arr) ? arr.reduce((s, t) => s + (num(t && t.remaining_amount_minor_units) || 0), 0) : null);
    promoMinor = sum(prepaid.promo_tranches);
    paidMinor = sum(prepaid.tranches);
    if (prepaid.next_expires_at) {
      nextExpiresAt = isoFromAny(prepaid.next_expires_at);
      const all = [...(Array.isArray(prepaid.promo_tranches) ? prepaid.promo_tranches : []),
        ...(Array.isArray(prepaid.tranches) ? prepaid.tranches : [])];
      nextExpiryMinor = all
        .filter((t) => t && t.expires_at === prepaid.next_expires_at)
        .reduce((s, t) => s + (num(t.remaining_amount_minor_units) || 0), 0);
    }
  }

  // Percent is only meaningful against a cap: API value when it has one, computed as fallback,
  // extra_usage.utilization as last resort. Without a cap → null (renderer hides the meter).
  let percent = null;
  if (limitMinor != null && limitMinor > 0) {
    if (sp && num(sp.percent) != null && limit) percent = num(sp.percent);
    else if (usedMinor != null) percent = (usedMinor / limitMinor) * 100;
  } else if (eu && num(eu.utilization) != null) {
    percent = num(eu.utilization);
  }

  return {
    enabled: enabled === null ? false : enabled,
    currency: currency || 'USD',
    exponent,
    usedMinor,
    limitMinor,
    percent,
    balanceMinor,
    promoMinor,
    paidMinor,
    nextExpiresAt,
    nextExpiryMinor,
    disabledReason: disabledReason || null,
  };
}

/**
 * normalizeClaude({ usage, profile, credentials, web, prepaid }) → { windows, extra, plan, account }
 *   usage       /api/oauth/usage (or claude.ai /usage — same shape)
 *   profile     /api/oauth/profile (optional)
 *   credentials the `claudeAiOauth` object from .credentials.json (optional; plan source #1)
 *   web         { overage, prepaid, org } raw claude.ai payloads (optional; claude_web source)
 *   prepaid     /api/oauth/organizations/<org>/prepaid/credits payload (optional; claude_code source)
 */
function normalizeClaude({ usage, profile, credentials, web, prepaid } = {}) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const limits = indexClaudeLimits(u.limits);
  const nextColor = makeColorCycle(['rose', 'amber', 'slate']);
  const windows = [];

  // 1–2. Core rows (+ severity / is_active merged from limits[]).
  const session = claudeCoreRow({
    bucket: u.five_hour, limit: limits.session, key: 'session', label: 'Current Session',
    kind: 'session', windowSeconds: FIVE_HOURS, color: 'purple',
  });
  const weekly = claudeCoreRow({
    bucket: u.seven_day, limit: limits.weekly_all, key: 'weekly', label: 'Weekly Limit',
    kind: 'weekly', windowSeconds: SEVEN_DAYS, color: 'blue',
  });
  if (session) windows.push(session);
  if (weekly) windows.push(weekly);

  // 3. Scoped weekly limits from limits[] (authoritative; e.g. Fable).
  const scopedSlugs = new Set();
  for (const l of limits.scoped) {
    const displayName = l.scope && l.scope.model && l.scope.model.display_name;
    if (!displayName || num(l.percent) == null) continue;
    const s = slug(displayName);
    if (!s || scopedSlugs.has(s)) continue;
    scopedSlugs.add(s);
    windows.push(makeWindow({
      key: `weekly_${s}`,
      label: `${displayName} Weekly`,
      kind: 'weekly_scoped',
      percent: num(l.percent),
      resetsAt: isoFromAny(l.resets_at),
      windowSeconds: SEVEN_DAYS,
      severity: typeof l.severity === 'string' ? l.severity : null,
      isActive: typeof l.is_active === 'boolean' ? l.is_active : null,
      color: s === 'fable' ? 'fuchsia' : nextColor(),
      scope: displayName,
      note: s === 'fable' ? FABLE_NOTE : null,
    }));
  }

  // 4a. Legacy named buckets — only when non-null and not already covered by a scoped limit.
  for (const [bucketKey, meta] of Object.entries(CLAUDE_LEGACY_BUCKETS)) {
    const b = u[bucketKey];
    if (!b || typeof b !== 'object' || scopedSlugs.has(meta.slug)) continue;
    scopedSlugs.add(meta.slug);
    windows.push(makeWindow({
      key: `weekly_${meta.slug}`,
      label: meta.label,
      kind: 'weekly_scoped',
      percent: num(b.utilization) ?? 0,
      resetsAt: isoFromAny(b.resets_at),
      windowSeconds: SEVEN_DAYS,
      color: nextColor(),
      scope: meta.scope,
    }));
  }

  // 4b. Unknown codename buckets (tangelo, nimbus_quill…): ignore unless clearly live.
  for (const [k, v] of Object.entries(u)) {
    if (CLAUDE_NON_BUCKET_KEYS.has(k) || !v || typeof v !== 'object' || !('utilization' in v)) continue;
    const pct = num(v.utilization);
    if (pct == null || pct <= 0 || !v.resets_at) continue;
    windows.push(makeWindow({
      key: k,
      label: titleCase(k),
      kind: 'other',
      percent: pct,
      resetsAt: isoFromAny(v.resets_at),
      windowSeconds: null,
      color: nextColor(),
      scope: null,
    }));
  }

  // 5–6. Extra usage, plan, account.
  const extra = claudeExtra(u, web, prepaid);
  const org = profile && profile.organization && typeof profile.organization === 'object' ? profile.organization : null;
  const acct = profile && profile.account && typeof profile.account === 'object' ? profile.account : null;
  const plan = (credentials && claudePlanLabel(credentials.rateLimitTier, credentials.subscriptionType))
    || (org && claudePlanLabel(org.rate_limit_tier, org.organization_type))
    || (web && web.org && claudeWebPlanLabel(web.org))
    || null;
  const account = (acct && (acct.display_name || acct.full_name || acct.email))
    || (web && web.org && web.org.name)
    || null;

  return { windows: sortWindows(windows), extra, plan, account };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/** Canonical durations. Matching is ±5 % because header-derived windows show 299/10079 minutes. */
const CODEX_DURATIONS = [
  { seconds: 18000, label: '5-Hour Limit', word: '5-Hour', kind: 'session', color: 'green', durSlug: '5h' },
  { seconds: 86400, label: 'Daily Limit', word: 'Daily', kind: 'other', color: 'slate', durSlug: 'daily' },
  { seconds: 604800, label: 'Weekly Limit', word: 'Weekly', kind: 'weekly', color: 'teal', durSlug: 'weekly' },
  { seconds: 2592000, label: 'Monthly Limit', word: 'Monthly', kind: 'other', color: 'slate', durSlug: 'monthly' },
  { seconds: 31536000, label: 'Annual Limit', word: 'Annual', kind: 'other', color: 'slate', durSlug: 'annual' },
];

/**
 * codexWindowLabel(limitWindowSeconds) → { label, kind, color, windowSeconds, word, durSlug }
 * Unknown durations → "<N>-Hour Limit" (kind session when ≤ 6 h, weekly when ≥ 6 d, else other).
 * null/undefined → null (caller falls back to slot semantics).
 */
function codexWindowLabel(limitWindowSeconds) {
  const secs = num(limitWindowSeconds);
  if (secs == null || secs <= 0) return null;
  for (const d of CODEX_DURATIONS) {
    if (secs >= d.seconds * 0.95 && secs <= d.seconds * 1.05) {
      return { label: d.label, kind: d.kind, color: d.color, windowSeconds: secs, word: d.word, durSlug: d.durSlug };
    }
  }
  const hours = Math.max(1, Math.round(secs / 3600));
  const kind = secs <= 6 * 3600 ? 'session' : secs >= 6 * 86400 ? 'weekly' : 'other';
  const color = kind === 'session' ? 'green' : kind === 'weekly' ? 'teal' : 'slate';
  return { label: `${hours}-Hour Limit`, kind, color, windowSeconds: secs, word: `${hours}-Hour`, durSlug: `${hours}h` };
}

/** Slot fallback when `limit_window_seconds` is absent (older payload shapes). */
const CODEX_SLOT_FALLBACK = {
  primary: { label: '5-Hour Limit', kind: 'session', color: 'green', windowSeconds: null, word: '5-Hour', durSlug: '5h' },
  secondary: { label: 'Weekly Limit', kind: 'weekly', color: 'teal', windowSeconds: null, word: 'Weekly', durSlug: 'weekly' },
};

/** Plan labels per research-codex.md §2.4 (Title Case for unknowns; cbp/k12 stay upper-case). */
const CODEX_PLAN_LABELS = {
  free: 'Free', guest: 'Free', free_workspace: 'Free',
  go: 'Go',
  plus: 'Plus',
  prolite: 'Pro 5x',
  pro: 'Pro 20x',
  team: 'Team',
  self_serve_business_prolite: 'Business',
  self_serve_business_usage_based: 'Business',
  business: 'Business', ent26: 'Business',
  enterprise: 'Enterprise', enterprise_cbp_automation: 'Enterprise', enterprise_cbp_usage_based: 'Enterprise',
  education: 'Edu', edu: 'Edu', edu_plus: 'Edu', edu_pro: 'Edu', k12: 'Edu', quorum: 'Edu',
};

function codexPlanLabel(planType) {
  if (typeof planType !== 'string' || !planType.trim()) return null;
  const key = planType.trim().toLowerCase();
  if (CODEX_PLAN_LABELS[key]) return CODEX_PLAN_LABELS[key];
  if (key === 'unknown') return null;
  if (key.startsWith('enterprise')) return 'Enterprise';
  return titleCase(key).replace(/\bCbp\b/g, 'CBP').replace(/\bK12\b/g, 'K12');
}

/**
 * One Codex rate-limit window → UsageWindow (or null when the slot is null — never invent windows).
 * `keyBase` is the stable id; `labelPrefix` is prepended for code-review / additional buckets.
 */
function codexRow({ win, slot, keyBase, keyMode = 'exact', labelPrefix, kindOverride, colorOverride, scope, blocked, now }) {
  if (!win || typeof win !== 'object') return null;
  const meta = codexWindowLabel(win.limit_window_seconds) || CODEX_SLOT_FALLBACK[slot];
  const resetAt = num(win.reset_at);
  const resetAfter = num(win.reset_after_seconds);
  const resetsAt = resetAt != null
    ? isoFromAny(resetAt, { unixSeconds: true })
    : (resetAfter != null ? new Date(now() + resetAfter * 1000).toISOString() : null);
  const label = labelPrefix ? `${labelPrefix} ${meta.word}` : meta.label;
  // keyMode 'exact':    <keyBase> as given (core rows: 'primary' / 'secondary').
  // keyMode 'slot':     <keyBase> for primary, <keyBase>_secondary for secondary (code_review).
  // keyMode 'duration': <keyBase>_<5h|weekly|…> — additional buckets whose slot layout varies by plan.
  let key = keyBase;
  if (keyMode === 'duration') key = `${keyBase}_${meta.durSlug}`;
  else if (keyMode === 'slot' && slot === 'secondary') key = `${keyBase}_secondary`;
  return makeWindow({
    key,
    label,
    kind: kindOverride || meta.kind,
    percent: num(win.used_percent) ?? 0,
    resetsAt,
    windowSeconds: meta.windowSeconds,
    severity: blocked ? 'blocked' : null,
    isActive: null,
    color: colorOverride || meta.color,
    scope: scope ?? null,
  });
}

function isBlocked(rateLimit) {
  return Boolean(rateLimit && typeof rateLimit === 'object' && (rateLimit.allowed === false || rateLimit.limit_reached === true));
}

/** Build both slots of a RateLimitStatusDetails object as rows (null slots are skipped, never invented). */
function codexRowsFor(rateLimit, opts) {
  if (!rateLimit || typeof rateLimit !== 'object') return [];
  const blocked = isBlocked(rateLimit);
  return [
    codexRow({ ...opts, win: rateLimit.primary_window, slot: 'primary', blocked }),
    codexRow({ ...opts, win: rateLimit.secondary_window, slot: 'secondary', blocked }),
  ].filter(Boolean);
}

/** `rate_limit_reached_type` arrives as `{type}` on wham/usage but as a plain string in app-server/session logs. */
function reachedType(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && typeof v.type === 'string') return v.type;
  return null;
}

function codexCredits(u) {
  const c = u.credits && typeof u.credits === 'object' ? u.credits : {};
  const rl = u.rate_limit && typeof u.rate_limit === 'object' ? u.rate_limit : {};
  const sc = u.spend_control && typeof u.spend_control === 'object' ? u.spend_control : {};
  const il = sc.individual_limit && typeof sc.individual_limit === 'object' ? sc.individual_limit : null;
  const modelUsage = {};
  if (u.model_usage && typeof u.model_usage === 'object') {
    for (const [model, mu] of Object.entries(u.model_usage)) {
      if (!mu || typeof mu !== 'object') continue;
      modelUsage[model] = {
        available: mu.available !== false,
        availableAt: num(mu.available_at) != null ? isoFromAny(num(mu.available_at), { unixSeconds: true }) : null,
        creditsWouldEnable: Boolean(mu.credits_would_enable),
      };
    }
  }
  const resetCredits = u.rate_limit_reset_credits && typeof u.rate_limit_reset_credits === 'object' ? u.rate_limit_reset_credits : null;
  return {
    hasCredits: Boolean(c.has_credits),
    unlimited: Boolean(c.unlimited),
    balance: c.balance === undefined ? null : c.balance, // string of a decimal credit count, or null when hidden
    overageLimitReached: Boolean(c.overage_limit_reached),
    approxLocalMessages: c.approx_local_messages ?? null,
    approxCloudMessages: c.approx_cloud_messages ?? null,
    limitReached: Boolean(rl.limit_reached),
    allowed: rl.allowed === undefined ? null : Boolean(rl.allowed),
    limitReachedType: reachedType(u.rate_limit_reached_type),
    modelUsage,
    resetCreditsAvailable: resetCredits ? (num(resetCredits.available_count) ?? 0) : 0,
    resetCreditsApplicable: resetCredits ? (num(resetCredits.applicable_available_count) ?? 0) : 0,
    spendControlReached: Boolean(sc.reached),
    monthlyLimit: il ? {
      limit: il.limit ?? null, used: il.used ?? null, remaining: il.remaining ?? null,
      usedPercent: num(il.used_percent), resetsAt: num(il.reset_at) != null ? isoFromAny(num(il.reset_at), { unixSeconds: true }) : null,
    } : null,
  };
}

/**
 * normalizeCodex({ usage, now }) → { windows, credits, plan, account }
 *   usage  wham/usage payload; `now` optional ms clock for the reset_after_seconds fallback.
 */
function normalizeCodex({ usage, now = Date.now } = {}) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const windows = [];

  // 1. Core windows (labelled by duration, never by slot; never invented). Slot names stay the
  //    stable ids (ARCHITECTURE §3: 'primary' | 'secondary') so history keys survive plan changes.
  const rl = u.rate_limit && typeof u.rate_limit === 'object' ? u.rate_limit : null;
  if (rl) {
    const blocked = isBlocked(rl);
    const primary = codexRow({ win: rl.primary_window, slot: 'primary', keyBase: 'primary', blocked, now });
    const secondary = codexRow({ win: rl.secondary_window, slot: 'secondary', keyBase: 'secondary', blocked, now });
    if (primary) windows.push(primary);
    if (secondary) windows.push(secondary);
  }

  // 2. Code-review quota and per-model / per-feature additional buckets.
  windows.push(...codexRowsFor(u.code_review_rate_limit, {
    keyBase: 'code_review', keyMode: 'slot', labelPrefix: 'Code Review', kindOverride: 'other', colorOverride: 'slate', scope: 'Code Review', now,
  }));
  const extraColor = makeColorCycle(['amber', 'rose', 'slate']);
  if (Array.isArray(u.additional_rate_limits)) {
    for (const a of u.additional_rate_limits) {
      if (!a || typeof a !== 'object') continue;
      const name = a.limit_name || a.metered_feature || 'Additional';
      const s = slug(name) || 'additional';
      const color = extraColor();
      windows.push(...codexRowsFor(a.rate_limit, {
        keyBase: `additional_${s}`, keyMode: 'duration', labelPrefix: name, kindOverride: 'other', colorOverride: color,
        scope: a.normal_model_slug || name, now,
      }));
    }
  }

  return {
    windows: sortWindows(windows),
    credits: codexCredits(u),
    plan: codexPlanLabel(u.plan_type),
    account: typeof u.email === 'string' && u.email ? u.email : null,
  };
}

module.exports = {
  normalizeClaude,
  normalizeCodex,
  codexWindowLabel,
  claudePlanLabel,
  claudeWebPlanLabel,
  codexPlanLabel,
  slug,
  titleCase,
  sortWindows,
  isoFromAny,
  FABLE_NOTE,
};
