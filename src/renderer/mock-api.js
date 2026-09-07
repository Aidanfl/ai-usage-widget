/*
 * mock-api.js — PREVIEW ONLY. Implements window.api with realistic fixtures so preview.html
 * can be rendered by the screenshot harness without the Electron main process.
 *
 * location.hash = comma list of states:
 *   expanded    both expand wells open           graph      graph card visible
 *   compact     compact mode                     settings   settings view opened after load
 *   light       light theme                      solid      solid background mode
 *   clear       Clear Acrylic (background acrylic_clear → bg-clear, dark text forced); default is Smoky Acrylic
 *   auth        Codex auth_required              stale      Claude stale (network error, last-good values)
 *   ratelimited Claude stale on HTTP 429 ("Rate limited, retrying at hh:mm")
 *   danger      Claude session 93%               twowindows Codex 5h + weekly
 *   nowindows   Codex ok but `windows: []`       noclaude / nocodex   snapshot.providers.<id> = null
 *   nocredits   Claude prepaid credits unknown (balance/expiry all null → hidden)
 *   expiring    $25 of credit expires in 5 days (danger colour) with a promo/paid split
 *   promo       balance is all promo credit (title shows the split)
 *   empty       no history                       loading    no snapshot ever arrives
 *   system      theme "system"                   noacrylic  acrylic unsupported (settings hint)
 *   capped      Claude extra usage with a $200 cap   web    claudeSource = claude_web
 *   ddt         date format "date-day-time"      24h        24-hour time format
 *   spinning    simulate a tray refresh (spinner) portable   portable build (autostart disabled)
 *   sparse      hourly history (default is a 2-minute cadence, like the real 60–120 s scheduler)
 *   titles      log every tooltip (dot / updated / row labels / compact labels / credits) to the console for the harness
 *   phone       phone sync paired + on, relay set, "Last pushed 2m ago"     (default: not paired, off, no relay)
 *   phonepairing  phone + the pairing panel (QR + code) opened after settings   phonewaiting  paired, no push yet
 *   phonefail   paired, last push failed (HTTP 401, retrying at hh:mm)        phonememkey   key kept in memory only
 *   phoneconfirm  phone + the inline Unpair confirmation shown
 *
 * The Fable row always carries `note` (as normalize.js produces it); every other row has `note: null`.
 */
(function () {
  'use strict';

  const states = new Set(String(location.hash || '').replace(/^#/, '').split(',').map((s) => s.trim()).filter(Boolean));
  const has = (s) => states.has(s);

  const MIN = 60000;
  const HOUR = 3600000;
  const DAY = 86400000;
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const FABLE_NOTE = "Percent of Fable's 50% share of the weekly limit";

  // "3:45 PM" — main formats the retry time into the 429 message itself (format.js loads after this file).
  function hhmm(ms) {
    const d = new Date(ms);
    const h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    if (has('24h')) return String(h).padStart(2, '0') + ':' + m;
    return ((h % 12) || 12) + ':' + m + ' ' + (h >= 12 ? 'PM' : 'AM');
  }

  const settings = {
    autoStart: false,
    hideFromTaskbar: false,
    alwaysOnTop: true,
    theme: has('light') ? 'light' : (has('system') ? 'system' : 'dark'),
    // main downgrades every material to solid at startup when acrylic is unsupported (noacrylic mirrors that).
    background: has('noacrylic') || has('solid') ? 'solid' : (has('clear') ? 'acrylic_clear' : 'acrylic'),
    warnThreshold: 75,
    dangerThreshold: 90,
    timeFormat: has('24h') ? '24h' : '12h',
    dateFormat: has('ddt') ? 'date-day-time' : 'date',
    usageAlerts: true,
    compactMode: has('compact'),
    refreshInterval: '60',
    graphVisible: has('graph'),
    expandedOpen: { claude: has('expanded'), codex: has('expanded') },
    providers: { claude: true, codex: true },
    claudeSource: has('web') ? 'claude_web' : 'claude_code',
    tokenAutoRefresh: true,
    trayStats: 'off',
    windowPosition: null,
    claudeOrganizationId: null,
    phoneSyncEnabled: false,
    phoneRelayUrl: '',
  };

  // ---- Phone sync fixtures (docs/PHONE-SYNC.md) ----
  const PHONE_STATES = ['phone', 'phonepairing', 'phonewaiting', 'phonefail', 'phonememkey', 'phoneconfirm'];
  const phone = {
    paired: PHONE_STATES.some(has),
    keyPersisted: !has('phonememkey'),
    lastPushAt: (has('phonefail') || has('phonewaiting')) ? null : now - 2 * MIN,
    lastError: has('phonefail') ? 'HTTP 401 — slot owned by another key (re-pair)' : null,
    nextRetryAt: has('phonefail') ? now + 4 * MIN : null,
  };
  if (phone.paired) {
    settings.phoneSyncEnabled = true;
    settings.phoneRelayUrl = 'https://aiusage-relay.aidan.workers.dev';
  }
  // Same vectors as tests/sync.test.js (K = bytes 0x00..0x1f).
  const PHONE_SLOT = 'c99b38a1696fd53885c484414e63a948';
  const PHONE_PAIR_STRING = 'aiusage://pair?v=1&r=https%3A%2F%2Faiusage-relay.aidan.workers.dev&k=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

  function phoneStatus() {
    return {
      enabled: !!settings.phoneSyncEnabled,
      relayUrl: settings.phoneRelayUrl || '',
      paired: phone.paired,
      keyPersisted: phone.paired && phone.keyPersisted,
      lastPushAt: phone.paired ? phone.lastPushAt : null,
      lastError: phone.paired ? phone.lastError : null,
      nextRetryAt: phone.paired ? phone.nextRetryAt : null,
      slotId: phone.paired ? PHONE_SLOT : null,
    };
  }

  function emitPhone() {
    const s = phoneStatus();
    setTimeout(() => listeners.phone.forEach((cb) => cb(s)), 0);
  }

  // QR-looking PNG (finder patterns + seeded noise) — the real one comes from the `qrcode` package in main.
  function fakeQrDataUrl(seed) {
    const N = 33; const cell = 6; const margin = cell; const size = N * cell + 2 * margin;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    const rnd = mulberry32(seed);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const inFinder = (x < 8 && y < 8) || (x >= N - 8 && y < 8) || (x < 8 && y >= N - 8);
        if (!inFinder && rnd() < 0.45) ctx.fillRect(margin + x * cell, margin + y * cell, cell, cell);
      }
    }
    const finder = (x0, y0) => {
      for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
        const ring = x === 0 || y === 0 || x === 6 || y === 6;
        const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        if (ring || core) ctx.fillRect(margin + (x0 + x) * cell, margin + (y0 + y) * cell, cell, cell);
      }
    };
    finder(0, 0); finder(N - 7, 0); finder(0, N - 7);
    return c.toDataURL('image/png');
  }

  function claudeExtra() {
    const base = {
      enabled: true,
      currency: 'USD',
      exponent: 2,
      usedMinor: 7519,
      limitMinor: has('capped') ? 20000 : null,
      percent: has('capped') ? 37.6 : null,
      disabledReason: null,
    };
    if (has('nocredits')) {
      // OAuth prepaid endpoint not fetched yet / failed → everything null → the credits column stays hidden.
      return Object.assign(base, { balanceMinor: null, promoMinor: null, paidMinor: null, nextExpiresAt: null, nextExpiryMinor: null });
    }
    if (has('expiring')) {
      return Object.assign(base, { balanceMinor: 17500, promoMinor: 2500, paidMinor: 15000, nextExpiresAt: iso(now + 5 * DAY + 3 * HOUR), nextExpiryMinor: 2500 });
    }
    if (has('promo')) {
      return Object.assign(base, { balanceMinor: 17500, promoMinor: 17500, paidMinor: 0, nextExpiresAt: iso(now + 40 * DAY), nextExpiryMinor: 17500 });
    }
    return Object.assign(base, { balanceMinor: 17500, promoMinor: 0, paidMinor: 17500, nextExpiresAt: iso(now + 18 * DAY), nextExpiryMinor: 5000 });
  }

  function claudeSnapshot() {
    const sessionReset = now + 43 * MIN;
    const weeklyReset = now + DAY + 8 * HOUR + 12 * MIN;
    const rateLimited = has('ratelimited');
    const stale = rateLimited || has('stale');
    let error = null;
    if (rateLimited) error = { code: 'http_429', message: 'Rate limited, retrying at ' + hhmm(now + 5 * MIN) };
    else if (stale) error = { code: 'network', message: 'Network error' };
    return {
      id: 'claude',
      name: 'Claude',
      status: stale ? 'stale' : 'ok',
      error,
      source: settings.claudeSource,
      plan: 'Max 20x',
      account: 'aidan@example.com',
      updatedAt: stale ? now - (rateLimited ? 7 : 5) * MIN : now - 12000,
      windows: [
        { key: 'session', label: 'Current Session', kind: 'session', percent: has('danger') ? 93 : 20, resetsAt: iso(sessionReset), windowSeconds: 18000, severity: has('danger') ? 'critical' : 'normal', isActive: false, color: 'purple', scope: null, note: null },
        { key: 'weekly', label: 'Weekly Limit', kind: 'weekly', percent: 22, resetsAt: iso(weeklyReset), windowSeconds: 604800, severity: 'normal', isActive: true, color: 'blue', scope: null, note: null },
        { key: 'weekly_fable', label: 'Fable Weekly', kind: 'weekly_scoped', percent: 10, resetsAt: iso(weeklyReset), windowSeconds: 604800, severity: 'normal', isActive: false, color: 'fuchsia', scope: 'Fable', note: FABLE_NOTE },
      ],
      extra: claudeExtra(),
      credits: null,
      raw: {},
    };
  }

  function codexSnapshot() {
    if (has('auth')) {
      return {
        id: 'codex', name: 'Codex', status: 'auth_required',
        error: { code: 'no_credentials', message: 'Sign in to Codex with ChatGPT to see usage' },
        source: 'codex_auth_file', plan: null, account: null, updatedAt: 0,
        windows: [], extra: null, credits: null, raw: {},
      };
    }
    const weeklyReset = now + 6 * DAY + 14 * HOUR + 3 * MIN;
    const windows = [];
    if (!has('nowindows')) {
      if (has('twowindows')) {
        windows.push({ key: 'primary', label: '5-Hour Limit', kind: 'session', percent: 34, resetsAt: iso(now + 2 * HOUR + 15 * MIN), windowSeconds: 18000, severity: null, isActive: null, color: 'green', scope: null, note: null });
      }
      windows.push({ key: 'secondary', label: 'Weekly Limit', kind: 'weekly', percent: 99, resetsAt: iso(weeklyReset), windowSeconds: 604800, severity: 'critical', isActive: null, color: 'teal', scope: null, note: null });
    }
    return {
      id: 'codex',
      name: 'Codex',
      status: 'ok',
      error: null,
      source: 'codex_auth_file',
      plan: 'Team',
      account: 'aidan@example.com',
      updatedAt: now - 40000,
      windows,
      extra: null,
      credits: {
        hasCredits: false, unlimited: false, balance: null, overageLimitReached: false,
        approxLocalMessages: null, approxCloudMessages: null,
        limitReached: false, limitReachedType: null,
        modelUsage: { 'gpt-6-astra': { available: true, availableAt: null } },
      },
      raw: {},
    };
  }

  function buildSnapshot() {
    return {
      fetchedAt: Date.now(),
      providers: {
        // `null` = provider disabled (settings) — noclaude/nocodex force it regardless of the settings toggles.
        claude: settings.providers.claude && !has('noclaude') ? claudeSnapshot() : null,
        codex: settings.providers.codex && !has('nocodex') ? codexSnapshot() : null,
      },
    };
  }

  // Deterministic PRNG so screenshots are reproducible.
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildHistory() {
    const series = [
      { key: 'claude.session', label: 'Claude · Current Session', color: 'purple' },
      { key: 'claude.weekly', label: 'Claude · Weekly Limit', color: 'blue' },
      { key: 'claude.weekly_fable', label: 'Claude · Fable Weekly', color: 'fuchsia' },
    ];
    if (has('twowindows')) series.push({ key: 'codex.primary', label: 'Codex · 5-Hour Limit', color: 'green' });
    if (!has('nowindows')) series.push({ key: 'codex.secondary', label: 'Codex · Weekly Limit', color: 'teal' });
    if (has('empty')) return { samples: [], series };

    const rnd = mulberry32(42);
    const samples = [];
    const start = now - 7 * DAY;
    // Real scheduler cadence is 60–120 s; 2 min over 7 days = 5 040 samples per series (the renderer downsamples).
    const step = has('sparse') ? HOUR : 2 * MIN;
    const perHour = HOUR / step;             // samples per hour (1 or 30) — hourly rates are divided by this
    let session = 5, weekly = 60, fable = 30, codex = 40, codex5 = 10;
    for (let k = 0, t = start; t <= now; k++, t += step) {
      const hr = new Date(t).getHours();
      const working = hr >= 9 && hr <= 23;
      const fiveHourBoundary = k % (5 * perHour) === 0;
      // session: 5-hour windows; only climbs during "working hours", otherwise sits idle
      if (fiveHourBoundary) session = working ? rnd() * 8 : 0;
      else if (working) session = Math.min(100, session + rnd() * 14 / perHour);
      // claude weekly: reset ~2.3 days in, then a slow ramp that lands near the fixture's 22% / 10%
      if (k === 55 * perHour) { weekly = 1; fable = 0; }
      else { weekly = Math.min(100, weekly + rnd() * 0.4 / perHour); fable = Math.min(100, fable + rnd() * 0.18 / perHour); }
      // codex weekly: ramps to 99 over ~5 days, reset ~ day 5, then a heavy 2-day climb back to the fixture's 99%
      if (k === 120 * perHour) codex = 4;
      else codex = Math.min(99, codex + rnd() * (k < 120 * perHour ? 1.0 : 4.0) / perHour);
      if (fiveHourBoundary) codex5 = rnd() * 5;
      else codex5 = Math.min(100, codex5 + rnd() * 9 / perHour);
      const v = {
        'claude.session': Math.round(session * 10) / 10,
        'claude.weekly': Math.round(weekly * 10) / 10,
        'claude.weekly_fable': Math.round(fable * 10) / 10,
      };
      if (!has('nowindows')) v['codex.secondary'] = Math.round(codex * 10) / 10;
      if (has('twowindows')) v['codex.primary'] = Math.round(codex5 * 10) / 10;
      samples.push({ t, v });
    }
    // Pin the latest sample to the fixture values so the live dots match the bars.
    const last = samples[samples.length - 1];
    last.t = now;
    last.v['claude.session'] = has('danger') ? 93 : 20;
    last.v['claude.weekly'] = 22;
    last.v['claude.weekly_fable'] = 10;
    if (!has('nowindows')) last.v['codex.secondary'] = 99;
    if (has('twowindows')) last.v['codex.primary'] = 34;
    return { samples, series };
  }

  const history = buildHistory();
  const listeners = { usage: [], settings: [], refresh: [], expired: [], phone: [] };

  window.api = {
    getSettings: async () => JSON.parse(JSON.stringify(settings)),
    saveSettings: async (patch) => {
      Object.keys(patch || {}).forEach((k) => {
        if (k === 'expandedOpen' || k === 'providers') settings[k] = Object.assign({}, settings[k], patch[k]);
        else settings[k] = patch[k];
      });
      console.log('[saveSettings] ' + JSON.stringify(patch));
      // Mirrors main.js: enabling phone sync without a key generates one; both phone keys re-broadcast the status.
      if (patch && patch.phoneSyncEnabled === true && !phone.paired) { phone.paired = true; phone.lastPushAt = null; }
      if (patch && ('phoneSyncEnabled' in patch || 'phoneRelayUrl' in patch)) emitPhone();
      const copy = JSON.parse(JSON.stringify(settings));
      setTimeout(() => listeners.settings.forEach((cb) => cb(copy)), 0);
      return copy;
    },
    getSnapshot: async () => (has('loading') ? null : buildSnapshot()),
    refreshNow: async () => {
      await delay(700);
      if (has('loading')) return null;
      const snap = buildSnapshot();
      setTimeout(() => listeners.usage.forEach((cb) => cb(snap)), 0);
      return snap;
    },
    getHistory: async () => JSON.parse(JSON.stringify(history)),
    // `background` = the backdrop the window was created with (main: getAppliedBackground); the mock has no
    // window to recreate, so it simply reports the current setting (downgraded to solid without acrylic).
    getAppInfo: async () => ({
      version: '0.1.1', platform: 'win32', acrylicSupported: !has('noacrylic'), isPortable: has('portable'),
      background: has('noacrylic') ? 'solid' : settings.background,
    }),
    claudeWebLogin: async () => { await delay(600); return { success: true }; },
    claudeWebLogout: async () => true,
    claudeWebOrgs: async () => [{ id: 'org_1', name: 'Aidan', isTeam: false }, { id: 'org_2', name: 'Acme Corp', isTeam: true }],
    claudeWebSelectOrg: async () => true,
    // Phone sync (same shapes as main.js / sync.js)
    phoneSyncStatus: async () => phoneStatus(),
    phoneSyncPairing: async () => {
      await delay(150);
      if (!phone.paired) { phone.paired = true; phone.lastPushAt = null; emitPhone(); }
      if (!settings.phoneRelayUrl) return { pairString: null, qrDataUrl: null, slotId: PHONE_SLOT, error: 'Set a relay URL first' };
      return { pairString: PHONE_PAIR_STRING, qrDataUrl: fakeQrDataUrl(7), slotId: PHONE_SLOT, error: null };
    },
    phoneSyncRepair: async () => {
      await delay(300);
      phone.paired = true; phone.lastPushAt = null; phone.lastError = null; phone.nextRetryAt = null;
      emitPhone();
      const pairString = PHONE_PAIR_STRING.replace(/k=.*/, 'k=' + 'Hx8eHRwbGhkYFxYVFBMSERAPDg0MCwoJCAcGBQQDAgEA');
      return { pairString, qrDataUrl: fakeQrDataUrl(11), slotId: 'f00d' + PHONE_SLOT.slice(4), error: null };
    },
    phoneSyncUnpair: async () => {
      await delay(200);
      phone.paired = false; phone.lastPushAt = null; phone.lastError = null; phone.nextRetryAt = null;
      settings.phoneSyncEnabled = false;
      emitPhone();
      const copy = JSON.parse(JSON.stringify(settings));
      setTimeout(() => listeners.settings.forEach((cb) => cb(copy)), 0);
      return true;
    },
    phoneSyncTest: async (url) => {
      await delay(500);
      console.log('[phoneSyncTest] ' + url);
      if (/bad|fail/.test(String(url))) return { ok: false, status: 404, latencyMs: 210, error: 'HTTP 404 — not a relay URL' };
      return { ok: true, status: 200, latencyMs: 123 };
    },
    phoneSyncPushNow: async () => {
      await delay(400);
      if (phone.lastError) return { ok: false, error: phone.lastError };
      phone.lastPushAt = Date.now();
      emitPhone();
      return { ok: true };
    },
    minimizeWindow: () => console.log('[minimize]'),
    closeWindow: () => console.log('[close]'),
    resizeWindow: (height) => console.log('[resize] ' + height),
    setCompactMode: (compact) => {
      // Mirrors main.js: set-compact-mode persists through the settings path and broadcasts.
      console.log('[compact] ' + compact);
      if (settings.compactMode !== !!compact) {
        settings.compactMode = !!compact;
        const copy = JSON.parse(JSON.stringify(settings));
        setTimeout(() => listeners.settings.forEach((cb) => cb(copy)), 0);
      }
    },
    openExternal: (url) => console.log('[openExternal] ' + url),
    onUsageUpdated: (cb) => listeners.usage.push(cb),
    onSettingsUpdated: (cb) => listeners.settings.push(cb),
    onRefreshRequested: (cb) => listeners.refresh.push(cb),
    onClaudeWebSessionExpired: (cb) => listeners.expired.push(cb),
    onPhoneSyncUpdated: (cb) => listeners.phone.push(cb),
  };

  // Harness hooks: open settings after load; simulate a tray refresh spinner; report chart point counts.
  window.addEventListener('load', () => {
    if (has('settings')) setTimeout(() => document.getElementById('settingsBtn').click(), 200);
    if (has('phonepairing')) setTimeout(() => document.getElementById('phonePairBtn').click(), 500);
    if (has('phoneconfirm')) setTimeout(() => document.getElementById('phoneUnpairBtn').click(), 500);
    if (has('spinning')) setTimeout(() => listeners.refresh.forEach((cb) => cb()), 200);
    if (has('graph')) {
      setTimeout(() => {
        const c = window.Chart && document.getElementById('usageChart') && window.Chart.getChart(document.getElementById('usageChart'));
        if (c) console.log('[chart] samples=' + history.samples.length + ' points=' + c.data.datasets.map((d) => d.label + ':' + d.data.length).join(' '));
      }, 1500);
    }
    if (has('titles')) {
      // Tooltips are invisible in screenshots — dump them so the harness log can verify note / stale wiring.
      setTimeout(() => {
        document.querySelectorAll('.card[data-provider]').forEach((card) => {
          const dot = card.querySelector('.dot');
          const upd = card.querySelector('.updated');
          console.log('[titles] ' + card.dataset.provider + ' dot="' + dot.title + '" updated="' + upd.textContent + '" updatedTitle="' + upd.title + '"');
        });
        document.querySelectorAll('.row .label').forEach((l) => console.log('[titles] row "' + l.textContent + '" has-note=' + l.classList.contains('has-note') + ' title="' + l.title + '"'));
        document.querySelectorAll('.crow .clabel').forEach((l) => console.log('[titles] compact "' + l.textContent + '" title="' + l.title + '"'));
        document.querySelectorAll('.sub.extra .kv.credits, .sub.extra .expiry').forEach((el) => { if (!el.hidden) console.log('[titles] credits "' + el.textContent + '" title="' + el.title + '"'); });
      }, 1200);
    }
  });
  window.addEventListener('error', (e) => console.log('[uncaught] ' + (e.message || e)));
  window.addEventListener('unhandledrejection', (e) => console.log('[unhandledrejection] ' + (e.reason && e.reason.message || e.reason)));

  console.log('[mock-api] states: ' + (Array.from(states).join(',') || '(default)'));
})();
