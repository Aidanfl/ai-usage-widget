/*
 * app.js — AI Usage widget renderer.
 *
 * State → DOM, idempotent render, keyed reconciliation (bars keep their transitions
 * across refreshes), timers, settings UI and the Chart.js history graph.
 *
 * Expected preload surface (window.api, see ARCHITECTURE.md §8):
 *   getSettings() saveSettings(patch) getSnapshot() refreshNow() getHistory(days) getAppInfo()
 *   claudeWebLogin() claudeWebLogout() claudeWebOrgs() claudeWebSelectOrg(id)
 *   phoneSyncStatus() phoneSyncPairing() phoneSyncRepair() phoneSyncUnpair() phoneSyncTest(relayUrl) phoneSyncPushNow()
 *   minimizeWindow() closeWindow() resizeWindow(height) setCompactMode(bool) openExternal(url)
 *   onUsageUpdated(cb) onSettingsUpdated(cb) onRefreshRequested(cb) onClaudeWebSessionExpired(cb) onPhoneSyncUpdated(cb)
 */
(function () {
  'use strict';

  const F = window.Format;
  const api = window.api;

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const PROVIDER_ORDER = ['claude', 'codex'];
  const PROVIDER_HUE = { claude: '217,119,87', codex: '16,163,127' };
  const HUE_ON = '52,211,153';
  const HUE_OFF = '160,160,175';
  const HUE_AMBER = '245,158,11';
  const HUE_SLATE = '148,163,184';
  const SERIES_HEX = {
    purple: '#8b5cf6', blue: '#3b82f6', fuchsia: '#d946ef', green: '#10a37f', teal: '#14b8a6',
    amber: '#f59e0b', rose: '#f43f5e', slate: '#64748b', spend: '#10b981',
  };
  const STALE_MS = 2 * 60 * 1000;
  const TICK_MS = 30 * 1000;
  const RESET_REFETCH_DELAY_MS = 3000;
  const SPINNER_SAFETY_MS = 45 * 1000;
  const RESIZE_DEBOUNCE_MS = 50;
  const RING_CIRCUMFERENCE = 62.83; // 2π·10
  const RING_MIN_ARC = 8 / 360;
  const CREDIT_EXPIRY_WARN_DAYS = 21;
  const CREDIT_EXPIRY_DANGER_DAYS = 7;
  const DAY_MS = 86400000;
  const HISTORY_DAYS = 7;
  // Chart: at most one point per bucket per series (7 days at 60–120 s cadence would be ~5–10k points per line).
  const CHART_BUCKET_MS = 10 * 60 * 1000;

  // settings.background → body class. 'acrylic' is Smoky Acrylic (stored value kept from 0.1.0),
  // 'acrylic_clear' is Clear Acrylic (light glass base, no tint, forced dark text — see applyTheme).
  const BACKGROUND_CLASS = { acrylic: 'bg-acrylic', acrylic_clear: 'bg-clear', mica: 'bg-mica', solid: 'bg-solid' };

  const SETTINGS_DEFAULTS = {
    autoStart: false, hideFromTaskbar: false, alwaysOnTop: true, theme: 'dark', background: 'acrylic',
    warnThreshold: 75, dangerThreshold: 90, timeFormat: '12h', dateFormat: 'date', usageAlerts: true,
    compactMode: false, refreshInterval: '120', graphVisible: false, expandedOpen: { claude: false, codex: false },
    providers: { claude: true, codex: true }, claudeSource: 'claude_code', tokenAutoRefresh: true,
    trayStats: 'off', windowPosition: null, claudeOrganizationId: null,
    phoneSyncEnabled: false, phoneRelayUrl: '',
  };
  const LOCAL_RELAY_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
  const COPIED_FEEDBACK_MS = 1500;

  const ICONS = {
    claude: '<svg viewBox="0 0 24 24" aria-hidden="true"><g stroke="#d97757" stroke-width="2.6" stroke-linecap="round" style="filter: drop-shadow(0 0 3px rgba(217,119,87,0.55))">'
      + '<line x1="14.4" y1="12" x2="22" y2="12"/><line x1="14.08" y1="13.2" x2="18.93" y2="16"/><line x1="13.2" y1="14.08" x2="16.75" y2="20.23"/>'
      + '<line x1="12" y1="14.4" x2="12" y2="20.2"/><line x1="10.8" y1="14.08" x2="7" y2="20.66"/><line x1="9.92" y1="13.2" x2="5.07" y2="16"/>'
      + '<line x1="9.6" y1="12" x2="2.5" y2="12"/><line x1="9.92" y1="10.8" x2="4.9" y2="7.9"/><line x1="10.8" y1="9.92" x2="7" y2="3.34"/>'
      + '<line x1="12" y1="9.6" x2="12" y2="4"/><line x1="13.2" y1="9.92" x2="16.75" y2="3.77"/><line x1="14.08" y1="10.8" x2="19.1" y2="7.9"/></g></svg>',
    codex: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="#10a37f" stroke-width="1.8" stroke-linejoin="round" style="filter: drop-shadow(0 0 3px rgba(16,163,127,0.55))">'
      + '<polygon points="12,2.5 20.23,7.25 20.23,16.75 12,21.5 3.77,16.75 3.77,7.25"/><polygon points="17,12 14.5,16.33 9.5,16.33 7,12 9.5,7.67 14.5,7.67" opacity="0.75"/></g></svg>',
    // Neutral mark for a provider id without bespoke artwork (never borrow another provider's logo).
    generic: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6" fill="#8b5cf6" style="filter: drop-shadow(0 0 3px rgba(139,92,246,0.55))"/></svg>',
    chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>',
    ring: '<svg class="ring" viewBox="0 0 24 24" aria-hidden="true"><circle class="bg" cx="12" cy="12" r="10"/><circle class="fg" cx="12" cy="12" r="10" style="stroke-dashoffset: 62.83"/></svg>',
    alert: '<svg class="auth-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    settings: Object.assign({}, SETTINGS_DEFAULTS),
    snapshot: null,
    history: null,
    refreshing: false,
    compact: false,
    expanded: { claude: false, codex: false },
    graphVisible: false,
    settingsOpen: false,
    compactPending: false, // compact preference while the full-width (non-compact) settings view is open
    appInfo: null,
    loading: true,
    orgs: [],
    webStatus: '',
    webBusy: false,
    // Phone sync (docs/PHONE-SYNC.md). `status` mirrors phone-sync-status; the rest is transient UI state.
    phone: {
      status: null,        // { enabled, relayUrl, paired, keyPersisted, lastPushAt, lastError, nextRetryAt, slotId }
      pairing: null,       // { pairString, qrDataUrl, slotId } while revealed
      showPairing: false,
      confirmUnpair: false,
      busy: false,         // false | 'pairing' | 'repair' | 'unpair' | 'push'
      testBusy: false,
      testResult: null,    // { ok, text } under the relay URL field
      relayDraft: null,    // invalid text left in the relay field after a commit attempt (kept on screen with its hint)
      pairHint: '',
      pairHintCls: '',
      copied: null,        // 'Copied' | 'Copy failed' feedback on the Copy button
    },
  };

  const els = {};
  let chart = null;
  let chartDirty = true;
  const hiddenSeries = new Set();
  const dangerSeen = new Set();
  const resetHandled = new Map();
  let firstSnapshotRendered = false;
  let resizeTimer = null;
  let lastSentHeight = null;
  let tickTimer = null;
  let spinnerSafetyTimer = null;
  let resetRefetchTimer = null;
  let historyRequestId = 0;
  let systemThemeMq = null;
  let copiedTimer = null;

  // ---------------------------------------------------------------------------
  // Small DOM helpers
  // ---------------------------------------------------------------------------
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'style') el.style.cssText = v;
        else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c !== null && c !== undefined && c !== false) el.append(c);
    }
    return el;
  }

  function svgFrom(markup, className) {
    const wrap = document.createElement('div');
    wrap.innerHTML = markup;
    const svg = wrap.firstElementChild;
    if (className) svg.setAttribute('class', className);
    return svg;
  }

  function setClass(el, cls, on) { el.classList.toggle(cls, !!on); }

  /** Keyed reconciliation: keeps existing nodes (and their CSS transitions), reorders, removes leftovers. */
  function reconcile(parent, items, keyOf, create, update) {
    const existing = new Map();
    for (const child of Array.from(parent.children)) {
      if (child.dataset.key !== undefined) existing.set(child.dataset.key, child); // unkeyed children (e.g. captions) are left alone
    }
    items.forEach((item, i) => {
      const key = String(keyOf(item, i));
      let node = existing.get(key);
      if (node) existing.delete(key);
      else { node = create(item); node.dataset.key = key; }
      if (parent.children[i] !== node) parent.insertBefore(node, parent.children[i] || null);
      update(node, item);
    });
    for (const leftover of existing.values()) leftover.remove();
  }

  function safeCall(name) {
    if (!api || typeof api[name] !== 'function') {
      console.warn('[renderer] window.api.' + name + ' is not available');
      return undefined;
    }
    try {
      return api[name].apply(api, Array.prototype.slice.call(arguments, 1));
    } catch (err) {
      console.error('[renderer] api.' + name + ' threw', err);
      return undefined;
    }
  }

  async function safeInvoke(name) {
    try {
      const r = safeCall.apply(null, arguments);
      return r && typeof r.then === 'function' ? await r : r;
    } catch (err) {
      console.error('[renderer] api.' + name + ' rejected', err);
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Settings helpers
  // ---------------------------------------------------------------------------
  function withDefaults(raw) {
    const s = Object.assign({}, SETTINGS_DEFAULTS, raw || {});
    s.expandedOpen = Object.assign({}, SETTINGS_DEFAULTS.expandedOpen, (raw && raw.expandedOpen) || {});
    s.providers = Object.assign({}, SETTINGS_DEFAULTS.providers, (raw && raw.providers) || {});
    s.warnThreshold = clampThreshold(s.warnThreshold, 75);
    s.dangerThreshold = clampThreshold(s.dangerThreshold, 90);
    s.refreshInterval = String(s.refreshInterval || SETTINGS_DEFAULTS.refreshInterval);
    return s;
  }

  function clampThreshold(v, fallback) {
    const n = parseInt(v, 10);
    if (!isFinite(n) || n < 1 || n > 99) return fallback;
    return n;
  }

  /** Derive view state from settings (single source of truth is the settings object). */
  function applySettings(raw) {
    const prev = state.settings;
    state.settings = withDefaults(raw);
    const s = state.settings;
    state.compact = !!s.compactMode;
    state.graphVisible = !!s.graphVisible;
    state.expanded = Object.assign({}, s.expandedOpen);
    if (!prev || prev.theme !== s.theme || prev.timeFormat !== s.timeFormat
      || prev.dangerThreshold !== s.dangerThreshold || prev.warnThreshold !== s.warnThreshold) chartDirty = true;
    applyBackground(); // before the theme: Clear Acrylic forces the light palette
    applyTheme();
  }

  /**
   * Backdrop the window was actually created with: main's get-app-info value wins over the setting, because
   * the material is creation-only (a change is applied by recreating the window — this renderer then boots
   * fresh — and acrylic/mica may be downgraded to solid at runtime). Falls back to the setting until app
   * info has arrived so the first paint already carries the default class.
   */
  function appliedBackground() {
    const fromMain = state.appInfo && state.appInfo.background;
    if (BACKGROUND_CLASS[fromMain]) return fromMain;
    return BACKGROUND_CLASS[state.settings.background] ? state.settings.background : SETTINGS_DEFAULTS.background;
  }

  function applyTheme() {
    const t = state.settings.theme;
    const systemDark = systemThemeMq ? systemThemeMq.matches : true;
    // Clear Acrylic sits on Windows' light glass base, where white text is unreadable: the light (dark-text)
    // palette is forced whatever the theme setting says; Settings shows "Clear Acrylic uses dark text".
    const forcedLight = appliedBackground() === 'acrylic_clear';
    const dark = forcedLight ? false : (t === 'light' ? false : (t === 'system' ? systemDark : true));
    if (document.body.classList.contains('theme-light') === dark) chartDirty = true;
    setClass(document.body, 'theme-light', !dark);
  }

  function applyBackground() {
    const bg = appliedBackground();
    Object.keys(BACKGROUND_CLASS).forEach((key) => setClass(document.body, BACKGROUND_CLASS[key], key === bg));
  }

  /**
   * Re-read what main applied after a `background` change: either the window was recreated (then this is a
   * fresh renderer and init() already did it) or it was kept (downgrade / no-op) and the body class must keep
   * describing the material the window really has.
   */
  async function refreshAppInfo() {
    const info = await safeInvoke('getAppInfo');
    if (!info || typeof info !== 'object') return;
    state.appInfo = info;
    applyBackground();
    applyTheme();
    render();
  }

  async function saveSettings(patch) {
    // Optimistic local merge so the UI reacts instantly; main echoes the merged object.
    const local = Object.assign({}, state.settings, patch);
    if (patch.expandedOpen) local.expandedOpen = Object.assign({}, state.settings.expandedOpen, patch.expandedOpen);
    if (patch.providers) local.providers = Object.assign({}, state.settings.providers, patch.providers);
    applySettings(local);
    render();
    const merged = await safeInvoke('saveSettings', patch);
    if (merged && typeof merged === 'object') {
      applySettings(merged);
      render();
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering — root
  // ---------------------------------------------------------------------------
  function render(forceResize) {
    const compactVisible = state.compact && !state.settingsOpen;
    setClass(document.body, 'compact-mode', compactVisible);
    els.titleBar.hidden = state.settingsOpen;
    els.mainView.hidden = state.settingsOpen || compactVisible;
    els.compactView.hidden = !compactVisible;
    els.settingsView.hidden = !state.settingsOpen;

    renderTitleBar();
    if (state.settingsOpen) renderSettings();
    else if (compactVisible) renderCompact();
    else renderNormal();

    measureAndResize(forceResize);
  }

  function renderTitleBar() {
    setClass(els.refreshBtn, 'spinning', state.refreshing);
    els.refreshBtn.title = state.refreshing ? 'Refreshing…' : 'Refresh';
    els.refreshBtn.setAttribute('aria-label', els.refreshBtn.title); // icon-only button: AT hears the same state as the tooltip
    setClass(els.graphBtn, 'active', state.graphVisible);
    els.graphBtn.setAttribute('aria-pressed', state.graphVisible ? 'true' : 'false');
    els.graphBtn.hidden = state.compact && !state.settingsOpen;
  }

  // ---------------------------------------------------------------------------
  // Rendering — normal view
  // ---------------------------------------------------------------------------
  /** Known providers first, then anything else present in the object (data-driven, no fixed pair). */
  function orderedIds(obj) {
    const keys = Object.keys(obj || {});
    return PROVIDER_ORDER.filter((id) => keys.includes(id)).concat(keys.filter((id) => !PROVIDER_ORDER.includes(id)));
  }

  function enabledProviderIds() {
    const p = state.settings.providers || {};
    const ids = orderedIds(Object.assign({}, SETTINGS_DEFAULTS.providers, p));
    return ids.filter((id) => p[id] !== false);
  }

  /** Providers present in the snapshot; `null` entries (disabled providers) drop out → no card. */
  function providerList() {
    const snap = state.snapshot;
    if (!snap || !snap.providers || typeof snap.providers !== 'object') return [];
    return orderedIds(snap.providers).map((id) => {
      const p = snap.providers[id];
      if (!p || typeof p !== 'object') return null;
      if (!p.id) p.id = id;
      return p;
    }).filter(Boolean);
  }

  /** Always an array of window objects — `windows: []`, null or malformed entries never throw downstream. */
  function windowsOf(p) {
    if (!p || !Array.isArray(p.windows)) return [];
    return p.windows.filter((w) => w && typeof w === 'object');
  }

  /** Renderer-side staleness: no fresh snapshot for two refresh intervals (never under 2 min). */
  function staleAfterMs() {
    const sec = parseInt(state.settings.refreshInterval, 10);
    return Math.max(STALE_MS, (isFinite(sec) && sec > 0 ? sec : 60) * 2 * 1000);
  }

  function renderNormal() {
    const providers = providerList();
    let items;
    if (!state.snapshot) {
      items = enabledProviderIds().map((id) => ({ type: 'skeleton', key: 'skeleton-' + id }));
      if (!items.length) items = [{ type: 'skeleton', key: 'skeleton-claude' }];
    } else if (!providers.length) {
      items = [{ type: 'empty', key: 'empty' }];
    } else {
      items = providers.map((p) => ({ type: 'provider', key: p.id, provider: p }));
    }
    els.headersRow.style.visibility = (items[0] && items[0].type === 'empty') ? 'hidden' : '';
    reconcile(els.providers, items, (it) => it.key, createProviderNode, updateProviderNode);
    renderGraph();
    positionSideChevron();
  }

  function createProviderNode(item) {
    if (item.type === 'skeleton') return createSkeletonCard();
    if (item.type === 'empty') return createEmptyCard();
    return createCard(item.key);
  }

  function updateProviderNode(node, item) {
    if (item.type === 'provider') updateCard(node, item.provider);
  }

  function createSkeletonCard() {
    const card = h('div', { class: 'card skeleton', 'aria-busy': 'true', 'aria-label': 'Loading usage' });
    const prov = h('div', { class: 'prov' },
      h('span', { class: 'sk circle' }),
      h('span', { class: 'sk text', style: 'width: 52px' }),
      h('span', { class: 'sk text', style: 'width: 40px; height: 12px' }),
      h('span', { class: 'sk text', style: 'width: 70px; margin-left: auto' }));
    const rows = h('div', { class: 'rows' });
    for (let i = 0; i < 2; i++) {
      rows.append(h('div', { class: 'grid row' },
        h('span', { class: 'sk text', style: 'width: ' + (i ? 70 : 96) + 'px' }),
        h('span', { class: 'sk', style: 'height: 6px' }),
        h('span', { class: 'sk ring' }),
        h('span', { class: 'sk text', style: 'width: 36px; margin: 0 auto' }),
        h('span', { class: 'sk text', style: 'width: 44px; margin: 0 auto' })));
    }
    card.append(prov, rows);
    return card;
  }

  function createEmptyCard() {
    return h('div', { class: 'card' },
      h('div', { class: 'msg-row' },
        'Both providers are turned off. ',
        h('button', { class: 'pill-btn', type: 'button', text: 'Open Settings', onclick: openSettings, style: 'margin-left: 8px' })));
  }

  function createCard(pid) {
    const card = h('div', { class: 'card', 'data-provider': pid });
    const expandBtn = h('button', {
      class: 'expand-btn', type: 'button', title: 'Show details', 'aria-label': 'Toggle details', 'aria-expanded': 'false',
      html: ICONS.chevronDown, onclick: () => toggleExpanded(pid),
    });
    const prov = h('div', { class: 'prov' },
      svgFrom(ICONS[pid] || ICONS.generic, 'mark'),
      h('span', { class: 'name' }),
      h('span', { class: 'chip plan', style: '--h:' + (PROVIDER_HUE[pid] || '139,92,246') }),
      h('span', { class: 'dot', role: 'img' }),
      h('span', { class: 'updated' }),
      expandBtn);
    card.append(prov, h('div', { class: 'rows' }), h('div', { class: 'auth-row', hidden: true }), h('div', { class: 'well', hidden: true }));
    return card;
  }

  /**
   * Status dot class + tooltip, plus the header line shown instead of "updated Ns ago" while stale
   * (`line`, e.g. "Rate limited, retrying at 3:45 PM" from provider.error.message).
   */
  function statusOf(p, now) {
    const msg = p.error && typeof p.error.message === 'string' ? p.error.message.trim() : '';
    if (p.status === 'auth_required') return { cls: 'err', title: msg || 'Sign-in required', line: null };
    if (p.status === 'error') return { cls: 'err', title: msg || 'Could not fetch usage', line: null };
    const age = p.updatedAt ? now - p.updatedAt : Infinity;
    if (p.status === 'stale' || age > staleAfterMs()) {
      const ago = p.updatedAt ? 'updated ' + F.relativeAgo(p.updatedAt, now) : 'no successful fetch yet';
      return {
        cls: 'stale',
        title: msg ? msg + ' — showing last good values (' + ago + ')' : 'Showing last good values — ' + ago,
        line: msg || ('Last good values · ' + ago),
      };
    }
    return { cls: 'ok', title: 'Up to date', line: null };
  }

  /** A provider gets an expand well when the snapshot carries extra-usage and/or credits data. */
  function hasDetails(p) {
    return !!(p.extra || p.credits);
  }

  function updateCard(card, p) {
    const now = Date.now();
    const pid = p.id;
    card.querySelector('.name').textContent = p.name || pid;

    const chip = card.querySelector('.chip.plan');
    chip.hidden = !p.plan;
    if (p.plan) chip.textContent = p.plan;

    const st = statusOf(p, now);
    const dot = card.querySelector('.dot');
    dot.className = 'dot ' + st.cls;
    dot.title = st.title;
    dot.setAttribute('aria-label', st.title);

    // Header right side: "updated Ns ago" normally; while stale the provider's message (9px, muted) replaces it.
    const updated = card.querySelector('.updated');
    setClass(updated, 'stale', !!st.line);
    if (st.line) {
      updated.textContent = st.line;
      updated.title = st.title;
    } else {
      updated.textContent = p.updatedAt ? 'updated ' + F.relativeAgo(p.updatedAt, now) : 'not updated yet';
      updated.title = p.updatedAt ? 'Last successful fetch ' + F.formatDateTime(p.updatedAt, state.settings.timeFormat) : '';
    }

    const windows = windowsOf(p);
    const ctx = { pid, now, pulseAllowed: firstSnapshotRendered };
    reconcile(card.querySelector('.rows'), windows, (w, i) => (w.key !== undefined && w.key !== null ? String(w.key) : 'w' + i),
      createRow, (row, w) => updateRow(row, w, ctx));

    const authEl = card.querySelector('.auth-row');
    const needsAuthRow = p.status === 'auth_required' || p.status === 'error' || (!windows.length && p.status !== 'ok');
    renderAuthRow(authEl, p, needsAuthRow);
    if (!needsAuthRow && !windows.length) {
      // `windows: []` on a healthy provider → one quiet row instead of an empty card.
      authEl.hidden = false;
      authEl.className = 'auth-row';
      authEl.replaceChildren(h('div', { class: 'auth-text muted-note', text: 'No usage windows reported', title: 'The API returned no usage windows for this account' }));
    }

    const details = hasDetails(p);
    const expandBtn = card.querySelector('.expand-btn');
    expandBtn.hidden = !details;
    const open = details && !!state.expanded[pid];
    setClass(expandBtn, 'open', open);
    expandBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    expandBtn.title = open ? 'Hide details' : 'Show details';

    const well = card.querySelector('.well');
    well.hidden = !open;
    if (open) {
      // Sub-rows are chosen by the data present, not by provider id.
      const extraRow = well.querySelector('.sub.extra');
      const creditsRow = well.querySelector('.sub.credits');
      if (!p.extra && extraRow) extraRow.remove();
      if (!p.credits && creditsRow) creditsRow.remove();
      if (p.extra) renderExtraRow(well, p);
      if (p.credits) renderCreditsRow(well, p);
    }
  }

  function createRow() {
    return h('div', { class: 'grid row' },
      h('span', { class: 'label' }),
      h('div', { class: 'barwrap' }, h('div', { class: 'track' }, h('div', { class: 'fill' })), h('span', { class: 'pct' })),
      h('div', { class: 'ringbox', html: ICONS.ring }),
      h('span', { class: 'resin' }),
      h('span', { class: 'resat' }));
  }

  function updateRow(row, win, ctx) {
    const s = state.settings;
    const now = ctx.now;
    const pct = F.clampPercent(win.percent);
    const thr = win.severity === 'blocked' ? 'danger' : F.thresholdClass(win.percent, s.warnThreshold, s.dangerThreshold);
    const color = win.color || 'purple';

    const label = row.querySelector('.label');
    const labelText = String(win.label || win.key || '');
    const note = typeof win.note === 'string' && win.note.trim() ? win.note.trim() : null;
    label.textContent = labelText;
    // `note` explains the percent (Fable: "Percent of Fable's 50% share of the weekly limit") → tooltip + dotted hint.
    label.title = note || labelText;
    setClass(label, 'has-note', !!note);

    const fill = row.querySelector('.fill');
    const hadPulse = fill.classList.contains('pulse');
    fill.className = 'fill ' + color + (thr ? ' ' + thr : '') + (hadPulse ? ' pulse' : '');
    fill.style.width = pct + '%';
    // The row's reconcile key already falls back to the index for a missing `win.key`, so keyless rows
    // do not all collapse onto "<pid>.undefined" and share one pulse latch.
    const dkey = ctx.pid + '.' + row.dataset.key;
    if (thr === 'danger') {
      if (!dangerSeen.has(dkey)) {
        dangerSeen.add(dkey);
        if (ctx.pulseAllowed && !hadPulse) {
          fill.classList.add('pulse');
          fill.addEventListener('animationend', () => fill.classList.remove('pulse'), { once: true });
        }
      }
    } else {
      dangerSeen.delete(dkey);
    }

    const pctEl = row.querySelector('.pct');
    pctEl.textContent = Math.round(pct) + '%';
    setClass(pctEl, 'danger', thr === 'danger');
    pctEl.title = (typeof win.percent === 'number' && win.percent > 100) ? Math.round(win.percent) + '% (over limit)' : '';

    const ringbox = row.querySelector('.ringbox');
    const fg = ringbox.querySelector('.fg');
    // `windowSeconds: null` → ring hidden (§3); 0 / negative / non-numeric can never yield an elapsed
    // fraction either, so they get the same treatment instead of an empty ring with a blank tooltip.
    if (!(typeof win.windowSeconds === 'number' && win.windowSeconds > 0)) {
      ringbox.style.visibility = 'hidden';
    } else {
      ringbox.style.visibility = '';
      const frac = F.elapsedFraction(win.resetsAt, win.windowSeconds, now);
      let shown = frac === null ? 0 : frac;
      if (shown > 0) shown = Math.max(shown, RING_MIN_ARC);
      fg.style.strokeDashoffset = (RING_CIRCUMFERENCE * (1 - shown)).toFixed(2);
      const rc = F.ringClass((frac || 0) * 100);
      fg.setAttribute('class', 'fg ' + color + (rc ? ' ' + rc : ''));
      ringbox.title = frac === null ? '' : Math.round(frac * 100) + '% of the window elapsed';
    }

    const resin = row.querySelector('.resin');
    const resinText = F.formatResetsIn(win.resetsAt, win.percent, now);
    resin.textContent = resinText;
    setClass(resin, 'dim', resinText === 'Not started' || resinText === '—');
    resin.title = resinText === 'Not started' ? 'Starts when a message is sent' : '';

    const resat = row.querySelector('.resat');
    // Parse once: an unparseable `resetsAt` string is truthy but must render like a missing one
    // (dim em dash, no "Resets —" tooltip). A reset ≥ 24 h away is shown as date + time even for rows of
    // unknown window length, where a bare "3:59 PM" would not say which day.
    const resetMs = F.toMs(win.resetsAt);
    const weekly = F.isWeeklyWindow(win, now);
    if (resetMs === null) {
      resat.textContent = '—';
      resat.classList.add('dim');
      resat.title = '';
    } else {
      resat.classList.remove('dim');
      resat.textContent = F.formatResetsAt(resetMs, { isWeekly: weekly, timeFormat: s.timeFormat, dateFormat: s.dateFormat });
      resat.title = 'Resets ' + F.formatDate(resetMs, 'date-day-time', s.timeFormat);
    }
  }

  function renderAuthRow(el, p, show) {
    el.hidden = !show;
    if (!show) return;
    const s = state.settings;
    el.className = 'auth-row' + (p.status === 'error' ? ' err' : '');
    const msg = (p.error && p.error.message) || (p.status === 'auth_required' ? 'Sign-in required' : 'Could not fetch usage');
    let hint = '';
    let btnLabel = 'Retry';
    let action = () => doRefresh();
    let disabled = state.refreshing;
    if (p.status === 'auth_required') {
      // Keyed off the credential source reported in the snapshot (id is only a fallback).
      const source = p.source || (p.id === 'claude' ? s.claudeSource : (p.id === 'codex' ? 'codex_auth_file' : ''));
      if (source === 'claude_web') {
        btnLabel = state.webBusy ? 'Waiting…' : 'Sign in';
        action = claudeWebLogin;
        disabled = state.webBusy;
        hint = 'Opens the claude.ai login window.';
      } else if (source === 'claude_code') {
        hint = 'Run any Claude Code command to refresh the token, then retry.';
      } else if (source === 'codex_auth_file') {
        hint = 'Sign in to Codex with ChatGPT (codex login), then retry.';
      }
    }
    el.replaceChildren(
      svgFrom(ICONS.alert),
      h('div', { class: 'auth-text' }, h('b', { text: msg }), hint ? h('span', { class: 'hint', text: hint }) : null),
      h('button', { class: 'pill-btn', type: 'button', text: btnLabel, disabled: disabled || null, onclick: action }));
  }

  // ---- Extra usage sub-row (ProviderSnapshot.extra — Claude today) --------------
  function renderExtraRow(well, p) {
    const x = p.extra;
    const s = state.settings;
    let row = well.querySelector('.sub.extra');
    if (!row) {
      row = h('div', { class: 'sub extra' },
        h('span', { class: 'label' }, h('span', { class: 'chip pill' }), h('span', { class: 'ltext', text: 'Extra Usage' })),
        h('div', { class: 'track' }, h('div', { class: 'fill spend' })),
        h('div', { class: 'valslot' }, h('span', { class: 'val' }), h('span', { class: 'cap' })),
        h('div', { class: 'rightcol min130' }, h('span', { class: 'kv credits' }), h('span', { class: 'expiry' })));
      well.prepend(row); // extra usage always sits above credits
    }
    const currency = x.currency || 'USD';
    const opts = { exponent: typeof x.exponent === 'number' ? x.exponent : 2 };
    const fmt = (minor, strip) => F.formatCurrency(minor, currency, strip ? Object.assign({ stripWholeCents: true }, opts) : opts);

    const pill = row.querySelector('.chip.pill');
    if (typeof x.enabled === 'boolean') {
      pill.hidden = false;
      pill.textContent = x.enabled ? 'ON' : 'OFF';
      pill.style.setProperty('--h', x.enabled ? HUE_ON : HUE_OFF);
      pill.title = x.enabled ? 'Extra usage is enabled' : (x.disabledReason || 'Extra usage is disabled');
    } else {
      pill.hidden = true;
    }

    // Finite-only: `typeof NaN === 'number'`, and NaN/Infinity here would print "null / $50" or "NaN%".
    const used = Number.isFinite(x.usedMinor) ? x.usedMinor : null;
    const limit = Number.isFinite(x.limitMinor) && x.limitMinor > 0 ? x.limitMinor : null;
    let pct = Number.isFinite(x.percent) ? x.percent : null;
    if (pct === null && used !== null && limit !== null) pct = used / limit * 100;

    const fill = row.querySelector('.fill');
    const thr = (pct !== null && limit !== null) ? F.thresholdClass(pct, s.warnThreshold, s.dangerThreshold) : '';
    fill.className = 'fill spend' + (thr ? ' ' + thr : '');
    fill.style.width = (pct === null ? 0 : F.clampPercent(pct)) + '%';

    const val = row.querySelector('.val');
    const cap = row.querySelector('.cap');
    if (limit !== null) {
      val.textContent = Math.round(F.clampPercent(pct === null ? 0 : pct)) + '%';
      cap.textContent = (used !== null ? fmt(used) + ' ' : '') + '/ ' + fmt(limit, true);
    } else if (used !== null) {
      val.textContent = fmt(used);
      cap.textContent = 'no cap';
    } else if (pct !== null) {
      val.textContent = Math.round(pct) + '%';
      cap.textContent = '';
    } else {
      val.textContent = '—';
      cap.textContent = x.disabledReason || '';
    }
    setClass(val, 'danger', thr === 'danger');
    row.querySelector('.track').title = used !== null ? 'Spent this month: ' + fmt(used) + (limit !== null ? ' of ' + fmt(limit, true) : '') : '';

    const rightcol = row.querySelector('.rightcol');
    const credits = row.querySelector('.kv.credits');
    const expiry = row.querySelector('.expiry');
    // Prepaid credits (OAuth /prepaid/credits or claude.ai): shown only when the balance is known, hidden when null.
    if (typeof x.balanceMinor === 'number' && isFinite(x.balanceMinor)) {
      rightcol.hidden = false;
      credits.replaceChildren('Account Credits ', h('b', { text: fmt(x.balanceMinor) }));
      const promo = typeof x.promoMinor === 'number' ? x.promoMinor : null;
      const paid = typeof x.paidMinor === 'number' ? x.paidMinor : null;
      const parts = [];
      if (promo !== null && paid !== null && (promo > 0 || paid > 0)) parts.push('promo ' + fmt(promo) + ' / paid ' + fmt(paid));
      else if (promo !== null && promo > 0) parts.push('promo ' + fmt(promo));
      else if (paid !== null && paid > 0) parts.push('paid ' + fmt(paid));
      credits.title = parts.join(' · ');
      const expMs = F.toMs(x.nextExpiresAt);
      const expMinor = typeof x.nextExpiryMinor === 'number' && isFinite(x.nextExpiryMinor) ? x.nextExpiryMinor : null;
      // Expiry line when a date is known and something actually expires then (null amount → date only).
      if (expMs !== null && (expMinor === null || expMinor > 0)) {
        const days = F.daysUntil(expMs);
        const soon = days !== null && days <= CREDIT_EXPIRY_WARN_DAYS;
        expiry.hidden = false;
        expiry.className = 'expiry' + (days !== null && days <= CREDIT_EXPIRY_DANGER_DAYS ? ' danger' : (soon ? ' warn' : ''));
        expiry.textContent = (expMinor !== null ? fmt(expMinor) + ' ' : 'Credits ')
          + (soon ? 'expire' + (expMinor !== null ? 's' : '') + ' in ' + Math.max(0, days) + 'd'
            : 'expire' + (expMinor !== null ? 's' : '') + ' ' + F.formatDate(expMs, 'date'));
        expiry.title = (expMinor !== null ? fmt(expMinor) + ' of credit expires ' : 'Credits expire ') + F.formatDate(expMs, 'date-day-time', s.timeFormat);
      } else {
        expiry.hidden = true;
      }
    } else {
      rightcol.hidden = true;
      expiry.hidden = true;
    }
  }

  // ---- Credits sub-row (ProviderSnapshot.credits — Codex today) -----------------
  function renderCreditsRow(well, p) {
    const c = p.credits;
    const s = state.settings;
    let row = well.querySelector('.sub.credits');
    if (!row) {
      row = h('div', { class: 'sub credits' },
        h('span', { class: 'label', text: 'Credits' }),
        h('span', { class: 'textcell creditval' }),
        h('span', { class: 'sep', text: '·' }),
        h('span', { class: 'kv limit textcell' }),
        h('div', { class: 'chips' }));
      well.append(row);
    }

    const cv = row.querySelector('.creditval');
    if (c.unlimited) {
      cv.className = 'textcell creditval kv';
      cv.replaceChildren(h('b', { text: 'Unlimited' }));
    } else if (c.hasCredits && typeof c.balance === 'number') {
      cv.className = 'textcell creditval kv';
      const n = c.balance.toLocaleString(undefined, { maximumFractionDigits: 2 });
      cv.replaceChildren(h('b', { text: n }), ' credits');
    } else if (c.hasCredits) {
      cv.className = 'textcell creditval kv';
      cv.replaceChildren(h('b', { text: 'Available' }));
    } else {
      cv.className = 'textcell creditval muted-note';
      cv.textContent = 'No credits';
    }
    const extra = [];
    if (typeof c.approxLocalMessages === 'number') extra.push('~' + c.approxLocalMessages + ' local messages');
    if (typeof c.approxCloudMessages === 'number') extra.push('~' + c.approxCloudMessages + ' cloud messages');
    if (typeof c.resetCreditsAvailable === 'number' && c.resetCreditsAvailable > 0) extra.push(c.resetCreditsAvailable + ' reset credits available');
    if (c.overageLimitReached) extra.push('Overage limit reached');
    cv.title = extra.join(' · ');

    const limit = row.querySelector('.kv.limit');
    const reached = !!c.limitReached;
    limit.replaceChildren('Limit reached ', h('b', { class: reached ? 'warn' : '', text: reached ? 'Yes' : 'No' }));
    limit.title = reached && c.limitReachedType ? String(c.limitReachedType).replace(/_/g, ' ') : '';

    const chips = row.querySelector('.chips');
    const models = c.modelUsage && typeof c.modelUsage === 'object' ? Object.keys(c.modelUsage) : [];
    const MAX_CHIPS = 3;
    const nodes = models.slice(0, MAX_CHIPS).map((name) => {
      const m = c.modelUsage[name] || {};
      const available = m.available !== false;
      let statusText = available ? 'available' : 'unavailable';
      if (!available && m.availableAt) statusText = 'until ' + F.formatTime(m.availableAt, s.timeFormat);
      return h('span', {
        class: 'chip model ellipsis', style: '--h:' + (available ? HUE_ON : HUE_AMBER),
        title: name + ' — ' + statusText,
      }, h('i'), name + ' · ' + statusText);
    });
    if (models.length > MAX_CHIPS) {
      nodes.push(h('span', { class: 'chip', style: '--h:' + HUE_SLATE, text: '+' + (models.length - MAX_CHIPS), title: models.slice(MAX_CHIPS).join(', ') }));
    }
    chips.replaceChildren.apply(chips, nodes);
  }

  // ---- Side chevron -------------------------------------------------------------
  function positionSideChevron() {
    const btn = els.compactBtn;
    const firstCard = els.providers.querySelector('.card');
    const rows = firstCard && firstCard.querySelector('.rows');
    if (!firstCard || !rows || !rows.offsetHeight) { btn.style.top = '40px'; return; }
    const centre = firstCard.offsetTop + rows.offsetTop + rows.offsetHeight / 2;
    btn.style.top = Math.round(centre - btn.offsetHeight / 2) + 'px';
  }

  // ---------------------------------------------------------------------------
  // Rendering — graph
  // ---------------------------------------------------------------------------
  function renderGraph() {
    const show = state.graphVisible && !state.compact;
    els.graphCard.hidden = !show;
    if (!show) { destroyChart(); return; }
    const hist = state.history;
    const hasData = !!(hist && hist.samples && hist.samples.length && hist.series && hist.series.length);
    renderLegend(hist);
    els.chartEmpty.hidden = hasData;
    els.chartEmpty.textContent = state.history === null
      ? 'Loading history…'
      : 'No history yet — the graph fills in as usage is sampled over the next few refreshes.';
    els.chartCanvas.style.visibility = hasData ? '' : 'hidden';
    if (!hasData) { destroyChart(); return; }
    if (chartDirty || !chart) buildChart(hist);
  }

  function legendLabelFor(series) {
    const parts = String(series.key || '').split('.');
    const pid = parts[0];
    const wkey = parts.slice(1).join('.');
    const p = state.snapshot && state.snapshot.providers && state.snapshot.providers[pid];
    if (p) {
      if (wkey === 'extra') return (p.name || pid) + ' extra';
      const win = windowsOf(p).find((w) => w.key === wkey);
      if (win) return F.seriesLabel(p.name || pid, win);
    }
    return series.label || series.key || '?';
  }

  function seriesHex(series) {
    const c = series.color;
    if (!c) return '#8b5cf6';
    if (SERIES_HEX[c]) return SERIES_HEX[c];
    return /^#|^rgb/.test(c) ? c : '#8b5cf6';
  }

  function renderLegend(hist) {
    const series = (hist && hist.series) || [];
    const items = series.map((sr, i) => ({ key: sr.key, sr, i }));
    reconcile(els.legend, items, (it) => 'legend-' + it.key,
      (it) => h('button', {
        class: 'legend-item', type: 'button', 'aria-pressed': 'true',
        onclick: () => toggleSeries(it.key),
      }, h('i'), h('span')),
      (node, it) => {
        node.style.setProperty('--sc', seriesHex(it.sr));
        node.querySelector('span').textContent = legendLabelFor(it.sr);
        const off = hiddenSeries.has(it.key);
        setClass(node, 'off', off);
        node.setAttribute('aria-pressed', off ? 'false' : 'true');
        node.title = (off ? 'Show ' : 'Hide ') + legendLabelFor(it.sr);
      });
    let caption = els.legend.querySelector(':scope > .caption');
    if (!caption) {
      caption = h('span', { class: 'caption', text: 'Last ' + HISTORY_DAYS + ' days' });
    }
    els.legend.append(caption); // always last
  }

  function toggleSeries(key) {
    if (hiddenSeries.has(key)) hiddenSeries.delete(key); else hiddenSeries.add(key);
    if (chart) {
      chart.data.datasets.forEach((ds, i) => chart.setDatasetVisibility(i, !hiddenSeries.has(ds._key)));
      chart.update('none');
    }
    render();
  }

  function startOfDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function destroyChart() {
    if (chart) { try { chart.destroy(); } catch (e) { /* ignore */ } chart = null; }
  }

  /**
   * Client-side downsampling for one series: at most one point per `bucketMs` (first numeric sample in the
   * bucket wins; a bucket with only gaps keeps one null so spanGaps:false still breaks the line), and the
   * final sample is always kept exactly — it carries the live dot and must match the bar.
   */
  function downsample(points, bucketMs) {
    if (!Array.isArray(points) || points.length <= 2) return points || [];
    const out = [];
    let bucket = null;
    for (let i = 0; i < points.length - 1; i++) {
      const p = points[i];
      const b = Math.floor(p.x / bucketMs);
      if (b !== bucket) { out.push(p); bucket = b; }
      else if (p.y !== null && out[out.length - 1].y === null) out[out.length - 1] = p; // upgrade a gap to data
    }
    const lastPt = points[points.length - 1];
    // Drop a same-bucket predecessor so the last point stands alone in its bucket (keeps the "≤1 per bucket" bound)
    if (out.length && Math.floor(out[out.length - 1].x / bucketMs) === Math.floor(lastPt.x / bucketMs) && out.length > 1) out.pop();
    out.push(lastPt);
    return out;
  }

  function buildChart(hist) {
    if (typeof window.Chart === 'undefined') {
      els.chartEmpty.hidden = false;
      els.chartEmpty.textContent = 'Chart library failed to load.';
      return;
    }
    destroyChart();
    const css = getComputedStyle(document.body);
    const gridColor = css.getPropertyValue('--chart-grid').trim() || 'rgba(255,255,255,0.06)';
    const tickColor = css.getPropertyValue('--chart-tick').trim() || 'rgba(255,255,255,0.5)';
    const dangerColor = css.getPropertyValue('--chart-danger').trim() || 'rgba(239,68,68,0.35)';
    const s = state.settings;
    const tf = s.timeFormat;
    const samples = hist.samples;
    const now = Date.now();
    const lastT = samples[samples.length - 1].t;
    const maxX = Math.max(lastT, now);
    const minX = startOfDay(Math.max(samples[0].t, maxX - HISTORY_DAYS * DAY_MS));

    const datasets = hist.series.map((sr) => {
      const data = downsample(samples.map((smp) => ({
        x: smp.t,
        y: (smp.v && typeof smp.v[sr.key] === 'number') ? Math.min(100, Math.max(0, smp.v[sr.key])) : null,
      })), CHART_BUCKET_MS);
      let last = -1;
      for (let i = data.length - 1; i >= 0; i--) if (data[i].y !== null) { last = i; break; }
      const color = seriesHex(sr);
      return {
        _key: sr.key,
        label: legendLabelFor(sr),
        data,
        borderColor: color,
        backgroundColor: color,
        borderWidth: 1.5,
        stepped: 'before',
        spanGaps: false,
        // Scales with explicit min/max get a 0px clip in Chart.js, which halves the live dot at x = now / y = 100.
        clip: false,
        pointRadius: (ctx) => (ctx.dataIndex === last ? 2 : 0), // 4px live dot
        pointHoverRadius: 4,
        pointHitRadius: 8,
        pointBorderWidth: 0,
        pointBackgroundColor: color,
        pointStyle: 'circle',
        hidden: hiddenSeries.has(sr.key),
      };
    });

    const dangerLine = {
      id: 'dangerLine',
      afterDatasetsDraw(c) {
        const yScale = c.scales.y;
        if (!yScale) return;
        const y = Math.round(yScale.getPixelForValue(s.dangerThreshold)) + 0.5;
        const ctx = c.ctx;
        ctx.save();
        ctx.strokeStyle = dangerColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(c.chartArea.left, y);
        ctx.lineTo(c.chartArea.right, y);
        ctx.stroke();
        ctx.restore();
      },
    };

    chart = new window.Chart(els.chartCanvas, {
      type: 'line',
      data: { datasets },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 6, right: 8, left: 0, bottom: 0 } },
        scales: {
          x: {
            type: 'time',
            min: minX,
            max: maxX,
            time: { unit: 'day', displayFormats: { day: 'MMM d' } },
            ticks: { font: { size: 9 }, color: tickColor, maxRotation: 0, autoSkip: true, padding: 4 },
            grid: { display: false },
            border: { display: false },
          },
          y: {
            min: 0,
            max: 100,
            ticks: { stepSize: 25, font: { size: 9 }, color: tickColor, padding: 4, callback: (v) => v + '%' },
            grid: { color: gridColor, drawTicks: false },
            border: { display: false },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            displayColors: true,
            usePointStyle: true,
            boxWidth: 7,
            boxHeight: 7,
            boxPadding: 3,
            padding: 8,
            titleFont: { size: 11 },
            bodyFont: { size: 11 },
            filter: (item) => item.parsed && item.parsed.y !== null && item.parsed.y !== undefined,
            callbacks: {
              title: (items) => (items.length ? F.formatDateTime(items[0].parsed.x, tf) : ''),
              label: (item) => ' ' + item.dataset.label + ': ' + Math.round(item.parsed.y) + '%',
            },
          },
        },
      },
      plugins: [dangerLine],
    });
    chartDirty = false;
  }

  // ---------------------------------------------------------------------------
  // Rendering — compact view
  // ---------------------------------------------------------------------------
  function renderCompact() {
    const items = [];
    if (!state.snapshot) {
      enabledProviderIds().forEach((id, i) => {
        items.push({ type: 'skeleton', key: 'sk-' + id + '-a', group: i > 0 });
        items.push({ type: 'skeleton', key: 'sk-' + id + '-b', group: false });
      });
    } else {
      const providers = providerList();
      if (!providers.length) items.push({ type: 'note', key: 'none', label: 'AI USAGE', note: 'No providers enabled' });
      providers.forEach((p, pi) => {
        const wins = windowsOf(p);
        if (!wins.length) {
          const st = statusOf(p, Date.now());
          const note = st.cls === 'ok' ? 'No usage windows reported' : (st.line || st.title);
          items.push({ type: 'note', key: p.id + '.__status', p, label: String(p.name || p.id).toUpperCase(), note, title: st.title, group: pi > 0, err: st.cls === 'err' });
          return;
        }
        wins.forEach((w, i) => items.push({ type: 'win', key: p.id + '.' + (w.key !== undefined && w.key !== null ? w.key : 'w' + i), p, w, first: i === 0, group: pi > 0 && i === 0 }));
      });
    }
    reconcile(els.compactRows, items, (it) => it.key, createCompactRow, updateCompactRow);
  }

  function createCompactRow(item) {
    const row = h('div', { class: 'crow' }, h('span', { class: 'cmark' }), h('span', { class: 'clabel' }));
    if (item.type === 'win') {
      row.append(h('div', { class: 'cbar' }, h('div', { class: 'fill' })), h('span', { class: 'cpct' }));
    } else if (item.type === 'note') {
      row.append(h('span', { class: 'cnote' }));
    } else {
      row.append(h('span', { class: 'sk', style: 'flex:1; height: 10px; border-radius: 5px' }), h('span', { class: 'sk text', style: 'width: 26px' }));
    }
    return row;
  }

  function updateCompactRow(row, item) {
    setClass(row, 'group', !!item.group);
    const mark = row.querySelector('.cmark');
    const label = row.querySelector('.clabel');
    if (item.type === 'skeleton') {
      mark.replaceChildren(h('span', { class: 'sk circle', style: 'width: 12px; height: 12px' }));
      label.replaceChildren(h('span', { class: 'sk text', style: 'width: 48px' }));
      return;
    }
    const pid = item.p ? item.p.id : null;
    if (item.type === 'note') {
      mark.replaceChildren(pid ? svgFrom(ICONS[pid] || ICONS.generic) : h('i', { style: 'background:#8b5cf6' }));
      label.textContent = item.label;
      const note = row.querySelector('.cnote');
      note.textContent = item.note;
      note.title = item.title || item.note;
      note.style.color = item.err ? 'var(--danger-text)' : '';
      return;
    }
    const s = state.settings;
    const w = item.w;
    const color = w.color || 'purple';
    if (item.first) {
      if (!mark.querySelector('svg')) mark.replaceChildren(svgFrom(ICONS[pid] || ICONS.generic));
    } else {
      let dot = mark.querySelector('i');
      if (!dot) { dot = h('i'); mark.replaceChildren(dot); }
      dot.style.background = SERIES_HEX[color] || SERIES_HEX.purple;
      dot.style.boxShadow = '0 0 5px ' + (SERIES_HEX[color] || SERIES_HEX.purple);
    }
    const text = F.compactLabel(item.p.name || pid, w);
    label.textContent = text;
    const cnote = typeof w.note === 'string' && w.note.trim() ? w.note.trim() : null;
    label.title = (item.p.name || pid) + ' · ' + (w.label || w.key) + (cnote ? ' — ' + cnote : '');
    const pct = F.clampPercent(w.percent);
    const thr = w.severity === 'blocked' ? 'danger' : F.thresholdClass(w.percent, s.warnThreshold, s.dangerThreshold);
    const fill = row.querySelector('.fill');
    fill.className = 'fill ' + color + (thr ? ' ' + thr : '');
    fill.style.width = pct + '%';
    const pctEl = row.querySelector('.cpct');
    pctEl.textContent = Math.round(pct) + '%';
    setClass(pctEl, 'danger', thr === 'danger');
    row.querySelector('.cbar').title = F.formatResetsIn(w.resetsAt, w.percent) === 'Not started'
      ? 'Not started'
      : 'Resets in ' + F.formatResetsIn(w.resetsAt, w.percent);
  }

  // ---------------------------------------------------------------------------
  // Rendering — settings view
  // ---------------------------------------------------------------------------
  function setChecked(input, value) {
    if (document.activeElement !== input) input.checked = !!value;
  }
  function setValue(el, value) {
    if (document.activeElement !== el) el.value = value;
  }

  function renderSettings() {
    const s = state.settings;
    const info = state.appInfo || {};

    setChecked(els.autoStartToggle, s.autoStart);
    const portable = !!info.isPortable;
    els.autoStartToggle.disabled = portable;
    els.autoStartHint.hidden = !portable;
    setClass(els.autoStartCol, 'disabled', portable);

    setChecked(els.hideFromTaskbarToggle, s.hideFromTaskbar);
    setChecked(els.alwaysOnTopToggle, s.alwaysOnTop);
    setChecked(els.usageAlertsToggle, s.usageAlerts !== false);
    setChecked(els.compactModeToggle, state.settingsOpen ? state.compactPending : state.compact);

    els.themeSeg.querySelectorAll('.seg-btn').forEach((b) => {
      setClass(b, 'active', b.dataset.theme === s.theme);
      b.setAttribute('aria-pressed', b.dataset.theme === s.theme ? 'true' : 'false');
    });

    // Smoky Acrylic, Clear Acrylic and Mica all need the DWM material → the three are disabled together.
    // macOS has vibrancy instead: same two glass looks under different names, and no Mica.
    const acrylicOk = info.acrylicSupported !== false;
    const mac = info.platform === 'darwin';
    const MAC_LABELS = { acrylic: 'Smoky Glass', acrylic_clear: 'Clear Glass' };
    els.backgroundSeg.querySelectorAll('.seg-btn').forEach((b) => {
      const unsupported = !acrylicOk && b.dataset.bg !== 'solid';
      b.disabled = unsupported;
      b.title = unsupported ? 'Not supported on this Windows version' : '';
      b.hidden = mac && b.dataset.bg === 'mica';
      if (mac && MAC_LABELS[b.dataset.bg]) b.textContent = MAC_LABELS[b.dataset.bg];
      // On macOS a stored 'mica' is rendered as Smoky (window.js folds it), so highlight that button.
      const current = mac && s.background === 'mica' ? 'acrylic' : s.background;
      setClass(b, 'active', b.dataset.bg === current);
      b.setAttribute('aria-pressed', b.dataset.bg === current ? 'true' : 'false');
    });
    els.backgroundHint.hidden = acrylicOk;
    els.backgroundClearHint.textContent = mac ? 'Clear Glass uses dark text' : 'Clear Acrylic uses dark text';
    els.backgroundClearHint.hidden = s.background !== 'acrylic_clear';

    setChecked(els.providerClaudeToggle, s.providers.claude !== false);
    setChecked(els.providerCodexToggle, s.providers.codex !== false);

    setValue(els.claudeSourceSelect, s.claudeSource || 'claude_code');
    const web = s.claudeSource === 'claude_web';
    const claude = state.snapshot && state.snapshot.providers && state.snapshot.providers.claude;
    const signedIn = web && claude && claude.source === 'claude_web' && claude.status !== 'auth_required';
    els.claudeWebLoginBtn.hidden = !web || (signedIn && !state.webBusy);
    els.claudeWebLoginBtn.disabled = state.webBusy;
    els.claudeWebLoginBtn.textContent = state.webBusy ? 'Waiting…' : 'Log in';
    els.claudeWebLogoutBtn.hidden = !web || !signedIn;
    const orgs = Array.isArray(state.orgs) ? state.orgs : [];
    els.claudeOrgSelect.hidden = !web || orgs.length < 2;
    if (web && orgs.length >= 2 && document.activeElement !== els.claudeOrgSelect) {
      els.claudeOrgSelect.replaceChildren.apply(els.claudeOrgSelect, orgs.map((o) => h('option', {
        value: o.id, text: o.name + (o.isTeam ? ' (Team)' : ''),
        selected: o.id === s.claudeOrganizationId ? true : null,
      })));
    }
    const status = web ? (state.webStatus || (signedIn ? (claude.account ? 'Signed in as ' + claude.account : 'Signed in') : 'Not signed in')) : '';
    els.claudeWebStatus.hidden = !web || !status;
    els.claudeWebStatus.textContent = status;
    els.claudeWebStatus.title = status;
    setClass(els.claudeWebStatus, 'err', /fail|expired|error|invalid/i.test(status));

    setChecked(els.tokenAutoRefreshToggle, s.tokenAutoRefresh !== false);
    setValue(els.trayStatsSelect, s.trayStats || 'off');

    if (document.activeElement !== els.warnThreshold && document.activeElement !== els.dangerThreshold) {
      els.warnThreshold.value = s.warnThreshold;
      els.dangerThreshold.value = s.dangerThreshold;
      els.warnThreshold.classList.remove('invalid');
      els.dangerThreshold.classList.remove('invalid');
      els.thresholdHint.hidden = true;
    }

    setValue(els.timeFormatSelect, s.timeFormat || '12h');
    // The two options preview the real "resets at" cell, so they have to follow the Time format setting
    // (a static "3:59 PM" label would be wrong for a 24h user). Sample = today at 15:59.
    const dateSample = new Date();
    dateSample.setHours(15, 59, 0, 0);
    els.dateFormatSelect.querySelectorAll('option').forEach((o) => {
      o.textContent = F.formatResetsAt(dateSample, { isWeekly: true, timeFormat: s.timeFormat, dateFormat: o.value });
    });
    setValue(els.dateFormatSelect, s.dateFormat || 'date');
    setValue(els.refreshIntervalSelect, String(s.refreshInterval || '60'));

    renderPhoneSettings();

    els.versionLabel.textContent = 'AI Usage Widget' + (info.version ? ' v' + info.version : '');
  }

  // ---------------------------------------------------------------------------
  // Settings — Phone sync (docs/PHONE-SYNC.md)
  // ---------------------------------------------------------------------------
  /** Mirror of main's validateRelayUrl so the field validates before saving (main re-validates anyway). */
  function normalizeRelayUrl(text) {
    const s = String(text || '').trim();
    if (!s || s.length > 512) return null;
    let u;
    try { u = new URL(s); } catch (e) { return null; }
    if (u.username || u.password || u.search || u.hash || !u.hostname) return null;
    if (u.protocol === 'http:') { if (!LOCAL_RELAY_HOSTS.includes(u.hostname)) return null; }
    else if (u.protocol !== 'https:') return null;
    return u.origin + u.pathname.replace(/\/+$/, '');
  }

  /** Status line text + tone from the phone-sync-status shape. */
  function phoneStatusInfo(st) {
    if (!st) return { text: 'Checking…', cls: '' };
    if (!st.paired) return { text: 'Not paired', cls: '' };
    const memNote = st.keyPersisted ? '' : ' · key kept for this session only (safeStorage unavailable)';
    if (!st.enabled) return { text: 'Paired · sync is off' + memNote, cls: '' };
    if (!st.relayUrl) return { text: 'Set a relay URL' + memNote, cls: 'warn' };
    if (st.lastError) {
      const retry = st.nextRetryAt ? ', retrying at ' + F.formatTime(st.nextRetryAt, state.settings.timeFormat) : '';
      return { text: 'Failed: ' + st.lastError + retry, cls: 'err' };
    }
    if (!st.lastPushAt) return { text: 'Paired · waiting for first push' + memNote, cls: '' };
    return { text: 'Paired · last pushed ' + F.relativeAgo(st.lastPushAt, Date.now()) + memNote, cls: 'ok' };
  }

  function renderPhoneSettings() {
    const s = state.settings;
    const ph = state.phone;
    const st = ph.status;
    const paired = !!(st && st.paired);
    const relay = normalizeRelayUrl(s.phoneRelayUrl);

    setChecked(els.phoneSyncToggle, !!s.phoneSyncEnabled);
    els.phoneSyncToggle.disabled = !!ph.busy;

    const info = phoneStatusInfo(st);
    els.phoneStatusLine.textContent = info.text;
    els.phoneStatusLine.title = info.text;
    els.phoneStatusLine.className = 'phone-status' + (info.cls ? ' ' + info.cls : '');

    // Relay URL field: an invalid draft stays on screen with its hint instead of snapping back to the stored value.
    if (document.activeElement !== els.phoneRelayUrl && ph.relayDraft === null) els.phoneRelayUrl.value = s.phoneRelayUrl || '';
    setClass(els.phoneRelayUrl, 'invalid', ph.relayDraft !== null);
    els.phoneTestBtn.disabled = ph.testBusy || !normalizeRelayUrl(els.phoneRelayUrl.value);
    els.phoneTestBtn.textContent = ph.testBusy ? 'Testing…' : 'Test';
    const invalid = ph.relayDraft !== null;
    const relayHint = invalid ? 'Use an https:// URL (http:// only for localhost)' : (ph.testResult ? ph.testResult.text : '');
    els.phoneRelayHint.hidden = !relayHint;
    els.phoneRelayHint.textContent = relayHint;
    els.phoneRelayHint.title = relayHint;
    els.phoneRelayHint.className = 'shint' + (invalid || (ph.testResult && !ph.testResult.ok) ? ' error' : (ph.testResult && ph.testResult.ok ? ' ok' : ''));

    els.phonePairBtn.disabled = !!ph.busy || !relay;
    els.phonePairBtn.title = relay ? '' : 'Set a relay URL first';
    els.phonePairBtn.textContent = ph.busy === 'pairing' ? 'Preparing…' : (ph.showPairing ? 'Hide pairing code' : 'Show pairing code');
    els.phonePairBtn.setAttribute('aria-expanded', ph.showPairing ? 'true' : 'false');
    els.phoneRepairBtn.hidden = !paired;
    els.phoneRepairBtn.disabled = !!ph.busy || !relay;
    els.phoneRepairBtn.textContent = ph.busy === 'repair' ? 'Re-pairing…' : 'Re-pair';
    els.phoneUnpairBtn.hidden = !paired || ph.confirmUnpair;
    els.phoneUnpairBtn.disabled = !!ph.busy;
    els.phonePushBtn.hidden = !paired;
    els.phonePushBtn.disabled = !!ph.busy || !s.phoneSyncEnabled || !relay;
    els.phonePushBtn.textContent = ph.busy === 'push' ? 'Pushing…' : 'Push now';
    els.phonePushBtn.title = !s.phoneSyncEnabled ? 'Turn on "Sync to phone" first' : '';

    els.phoneUnpairConfirm.hidden = !ph.confirmUnpair;
    els.phoneUnpairYesBtn.disabled = !!ph.busy;
    els.phoneUnpairYesBtn.textContent = ph.busy === 'unpair' ? 'Unpairing…' : 'Unpair';

    const pairing = ph.showPairing && ph.pairing && ph.pairing.pairString ? ph.pairing : null;
    els.phonePairing.hidden = !pairing;
    if (pairing) {
      // Only touch `src` when it changes: reassigning reloads the image and flickers.
      if (els.phoneQr.getAttribute('src') !== (pairing.qrDataUrl || '')) els.phoneQr.src = pairing.qrDataUrl || '';
      if (document.activeElement !== els.phonePairString) els.phonePairString.value = pairing.pairString;
      els.phoneCopyBtn.textContent = ph.copied || 'Copy';
    }
    const pairHint = ph.pairHint || '';
    els.phonePairHint.hidden = !pairHint;
    els.phonePairHint.textContent = pairHint;
    els.phonePairHint.title = pairHint;
    els.phonePairHint.className = 'shint' + (ph.pairHintCls ? ' ' + ph.pairHintCls : '');
  }

  async function loadPhoneStatus() {
    const st = await safeInvoke('phoneSyncStatus');
    if (st && typeof st === 'object') state.phone.status = st;
    if (state.settingsOpen) render();
  }

  function setPairHint(text, cls) {
    state.phone.pairHint = text || '';
    state.phone.pairHintCls = cls || '';
  }

  /** Relay URL field commit (change / blur / Enter): save when valid or cleared, otherwise keep the draft + hint. */
  function commitRelayUrl() {
    const raw = els.phoneRelayUrl.value;
    if (!String(raw).trim()) {
      state.phone.relayDraft = null;
      state.phone.testResult = null;
      if (state.settings.phoneRelayUrl) saveSettings({ phoneRelayUrl: '' });
      else render();
      return;
    }
    const normalized = normalizeRelayUrl(raw);
    if (!normalized) {
      state.phone.relayDraft = String(raw);
      render();
      return;
    }
    state.phone.relayDraft = null;
    if (document.activeElement !== els.phoneRelayUrl) els.phoneRelayUrl.value = normalized;
    if (normalized !== state.settings.phoneRelayUrl) {
      state.phone.testResult = null;
      saveSettings({ phoneRelayUrl: normalized }).then(loadPhoneStatus);
    } else {
      render();
    }
  }

  async function phoneTest() {
    if (state.phone.testBusy) return;
    const url = normalizeRelayUrl(els.phoneRelayUrl.value);
    if (!url) return;
    state.phone.testBusy = true;
    state.phone.testResult = null;
    render();
    const r = await safeInvoke('phoneSyncTest', url);
    state.phone.testBusy = false;
    state.phone.testResult = r && r.ok
      ? { ok: true, text: 'Relay OK · ' + Math.round(r.latencyMs || 0) + ' ms' }
      : { ok: false, text: 'Test failed: ' + ((r && r.error) || 'no response') };
    render();
  }

  /** Show/hide the QR + pairing string. Revealing asks main for the pairing (which creates K when absent). */
  async function togglePairing() {
    const ph = state.phone;
    if (ph.showPairing) {
      ph.showPairing = false;
      render();
      return;
    }
    if (ph.busy) return;
    ph.busy = 'pairing';
    setPairHint('');
    render();
    const p = await safeInvoke('phoneSyncPairing');
    ph.busy = false;
    if (p && p.pairString) {
      ph.pairing = p;
      ph.showPairing = true;
    } else {
      setPairHint((p && p.error) || 'Could not create the pairing code', 'error');
    }
    await loadPhoneStatus(); // renders (the QR <img> load also re-measures the window height)
  }

  async function phoneRepair() {
    const ph = state.phone;
    if (ph.busy) return;
    ph.busy = 'repair';
    ph.confirmUnpair = false;
    setPairHint('');
    render();
    const p = await safeInvoke('phoneSyncRepair');
    ph.busy = false;
    if (p && p.pairString) {
      ph.pairing = p;
      ph.showPairing = true;
      setPairHint('New key generated — scan the new code on the phone; the old pairing no longer works.', '');
    } else {
      setPairHint((p && p.error) || 'Re-pairing failed', 'error');
    }
    await loadPhoneStatus();
  }

  async function phoneUnpair() {
    const ph = state.phone;
    if (ph.busy) return;
    ph.busy = 'unpair';
    render();
    await safeInvoke('phoneSyncUnpair'); // main also turns phoneSyncEnabled off and broadcasts settings-updated
    ph.busy = false;
    ph.confirmUnpair = false;
    ph.showPairing = false;
    ph.pairing = null;
    setPairHint('Unpaired — the relay slot was deleted and sync is off.', '');
    await loadPhoneStatus();
  }

  async function phonePushNow() {
    const ph = state.phone;
    if (ph.busy) return;
    ph.busy = 'push';
    setPairHint('');
    render();
    const r = await safeInvoke('phoneSyncPushNow');
    ph.busy = false;
    if (r && r.ok) setPairHint('Pushed to the relay.', 'ok');
    else setPairHint('Push failed: ' + ((r && r.error) || 'unknown error'), 'error');
    await loadPhoneStatus();
  }

  async function copyPairString() {
    const text = state.phone.pairing && state.phone.pairing.pairString;
    if (!text) return;
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (e) { ok = false; }
    if (!ok) {
      // Fallback: select the readonly field and use the legacy command.
      try {
        els.phonePairString.focus();
        els.phonePairString.select();
        ok = document.execCommand('copy');
      } catch (e) { ok = false; }
    }
    state.phone.copied = ok ? 'Copied' : 'Copy failed';
    render();
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      state.phone.copied = null;
      if (state.settingsOpen) render();
    }, COPIED_FEEDBACK_MS);
  }

  function readThresholds() {
    const warn = parseInt(els.warnThreshold.value, 10);
    const danger = parseInt(els.dangerThreshold.value, 10);
    const warnOk = isFinite(warn) && warn >= 1 && warn <= 99;
    const dangerOk = isFinite(danger) && danger >= 1 && danger <= 99;
    const orderOk = warnOk && dangerOk && warn < danger;
    setClass(els.warnThreshold, 'invalid', !warnOk || (warnOk && dangerOk && !orderOk));
    setClass(els.dangerThreshold, 'invalid', !dangerOk || (warnOk && dangerOk && !orderOk));
    els.thresholdHint.hidden = orderOk;
    if (!orderOk) return null;
    return { warnThreshold: warn, dangerThreshold: danger };
  }

  function commitThresholds() {
    const t = readThresholds();
    if (!t) return;
    if (t.warnThreshold !== state.settings.warnThreshold || t.dangerThreshold !== state.settings.dangerThreshold) {
      saveSettings(t);
    }
  }

  // ---------------------------------------------------------------------------
  // Window sizing
  // ---------------------------------------------------------------------------
  function measureAndResize(force) {
    if (force) lastSentHeight = null;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const height = els.container.offsetHeight;
      if (!height) return;
      if (height !== lastSentHeight) {
        lastSentHeight = height;
        safeCall('resizeWindow', height);
      }
    }, RESIZE_DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  function applySnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    state.snapshot = snap;
    state.loading = false;
    state.refreshing = false;
    clearTimeout(spinnerSafetyTimer);
    render();
    firstSnapshotRendered = true;
    if (state.graphVisible) loadHistory();
    checkResetBoundaries();
  }

  function armSpinnerSafety() {
    clearTimeout(spinnerSafetyTimer);
    spinnerSafetyTimer = setTimeout(() => {
      if (state.refreshing) { state.refreshing = false; renderTitleBar(); }
    }, SPINNER_SAFETY_MS);
  }

  async function doRefresh() {
    if (state.refreshing) return;
    state.refreshing = true;
    renderTitleBar();
    armSpinnerSafety();
    const snap = await safeInvoke('refreshNow');
    if (snap && snap.providers) applySnapshot(snap);
    else { state.refreshing = false; render(); }
  }

  async function loadHistory() {
    const id = ++historyRequestId;
    const raw = await safeInvoke('getHistory', HISTORY_DAYS);
    if (id !== historyRequestId) return;
    state.history = normalizeHistory(raw);
    chartDirty = true;
    render();
  }

  function normalizeHistory(raw) {
    if (!raw) return { samples: [], series: [] };
    let samples = Array.isArray(raw) ? raw : (Array.isArray(raw.samples) ? raw.samples : []);
    samples = samples.filter((s) => s && typeof s.t === 'number').sort((a, b) => a.t - b.t);
    let series = (!Array.isArray(raw) && Array.isArray(raw.series)) ? raw.series.filter((s) => s && s.key) : [];
    if (!series.length) {
      // Derive descriptors from the current snapshot when main did not provide them.
      providerList().forEach((p) => windowsOf(p).forEach((w) => {
        series.push({ key: p.id + '.' + w.key, label: (p.name || p.id) + ' · ' + w.label, color: w.color || 'purple' });
      }));
    }
    return { samples, series };
  }

  /**
   * One extra refresh shortly after a window's reset time passes, so the bars drop without waiting for
   * the next scheduled tick. Fires once per boundary CROSSING (future → past), not once per distinct
   * `resetsAt` value: Codex's `now + reset_after_seconds` fallback yields a fresh, already-past timestamp
   * on every poll when the API reports 0, and keying on the value turned that into a 3 s refresh loop
   * against an endpoint with no polling floor. A single pending timer also stops stacking.
   */
  function checkResetBoundaries() {
    const now = Date.now();
    let scheduled = false;
    const seen = new Set();
    providerList().forEach((p) => windowsOf(p).forEach((w, i) => {
      const key = p.id + '.' + (w.key !== undefined && w.key !== null ? w.key : 'w' + i);
      seen.add(key);
      const t = F.toMs(w.resetsAt);
      if (t === null || t > now) { resetHandled.delete(key); return; } // unknown or still ahead → re-armed
      if (!resetHandled.has(key)) { resetHandled.set(key, true); scheduled = true; }
    }));
    for (const key of Array.from(resetHandled.keys())) if (!seen.has(key)) resetHandled.delete(key); // stays bounded
    if (scheduled && resetRefetchTimer === null) {
      resetRefetchTimer = setTimeout(() => { resetRefetchTimer = null; doRefresh(); }, RESET_REFETCH_DELAY_MS);
    }
  }

  function toggleExpanded(pid) {
    const next = Object.assign({}, state.expanded);
    next[pid] = !next[pid];
    saveSettings({ expandedOpen: next });
    // The claude.ai source only polls the spend/credit endpoints while the panel is open.
    const p = state.snapshot && state.snapshot.providers && state.snapshot.providers[pid];
    if (next[pid] && p && p.source === 'claude_web') doRefresh();
  }

  function toggleGraph() {
    const next = !state.graphVisible;
    saveSettings({ graphVisible: next });
    if (next) loadHistory();
  }

  function setCompact(compact) {
    state.compact = compact;
    state.settings.compactMode = compact;
    safeCall('setCompactMode', compact);
    render(true);
    saveSettings({ compactMode: compact });
  }

  // The settings view needs the full-width (non-compact) window, so compact mode is suspended while it is open and
  // restored on Done. Main persists `compactMode` on every set-compact-mode, hence the separate
  // `compactPending` preference (the original's "settings-from-compact dance", minus the lost setting).
  function openSettings() {
    if (state.settingsOpen) return;
    state.settingsOpen = true;
    state.compactPending = state.compact;
    if (state.compact) safeCall('setCompactMode', false);
    if (state.settings.claudeSource === 'claude_web') loadOrgs();
    loadPhoneStatus();
    render(true);
    els.doneBtn.focus({ preventScroll: true });
  }

  function closeSettings() {
    if (!state.settingsOpen) return;
    state.settingsOpen = false;
    // The pairing code carries the encryption key: never leave it revealed for the next visit.
    state.phone.showPairing = false;
    state.phone.pairing = null;
    state.phone.confirmUnpair = false;
    state.phone.testResult = null;
    setPairHint('');
    const wantCompact = !!state.compactPending;
    if (wantCompact !== state.compact) {
      state.compact = wantCompact;
      state.settings.compactMode = wantCompact;
      safeCall('setCompactMode', wantCompact);
      saveSettings({ compactMode: wantCompact });
    }
    render(true);
    // The Done button that held focus is now `hidden`; without this, keyboard focus falls to <body>.
    if (!els.settingsBtn.hidden) els.settingsBtn.focus({ preventScroll: true });
  }

  async function loadOrgs() {
    const orgs = await safeInvoke('claudeWebOrgs');
    state.orgs = Array.isArray(orgs) ? orgs : [];
    if (state.settingsOpen) render();
  }

  async function claudeWebLogin() {
    if (state.webBusy) return;
    state.webBusy = true;
    state.webStatus = 'Waiting for the login window…';
    render();
    const r = await safeInvoke('claudeWebLogin');
    if (r && r.success) {
      state.webStatus = 'Signed in';
      await loadOrgs();
      doRefresh();
    } else {
      state.webStatus = (r && r.error) || 'Login failed';
    }
    state.webBusy = false;
    render();
  }

  async function claudeWebLogout() {
    await safeInvoke('claudeWebLogout');
    state.webStatus = 'Logged out';
    state.orgs = [];
    render();
    doRefresh();
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  function bindStaticEvents() {
    els.settingsBtn.addEventListener('click', openSettings);
    els.doneBtn.addEventListener('click', closeSettings);
    els.refreshBtn.addEventListener('click', () => doRefresh());
    els.graphBtn.addEventListener('click', toggleGraph);
    els.minimizeBtn.addEventListener('click', () => safeCall('minimizeWindow'));
    els.closeBtn.addEventListener('click', () => safeCall('closeWindow'));
    els.compactBtn.addEventListener('click', () => setCompact(true));
    els.expandBtn.addEventListener('click', () => setCompact(false));

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !state.settingsOpen) return;
      e.preventDefault();
      // Escape backs out of the inline Unpair confirmation / pairing reveal before it closes the view.
      if (state.phone.confirmUnpair) { state.phone.confirmUnpair = false; render(); return; }
      if (state.phone.showPairing) { state.phone.showPairing = false; render(); return; }
      closeSettings();
    });

    // External links anywhere in the page go through the allow-listed bridge.
    document.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      e.preventDefault();
      safeCall('openExternal', a.getAttribute('href'));
    });

    // Settings controls — every change saves a partial patch immediately.
    els.autoStartToggle.addEventListener('change', (e) => saveSettings({ autoStart: e.target.checked }));
    els.hideFromTaskbarToggle.addEventListener('change', (e) => {
      const patch = { hideFromTaskbar: e.target.checked };
      if (e.target.checked && state.settings.trayStats === 'off') patch.trayStats = 'both'; // never leave the app unreachable
      saveSettings(patch);
    });
    els.alwaysOnTopToggle.addEventListener('change', (e) => saveSettings({ alwaysOnTop: e.target.checked }));
    els.usageAlertsToggle.addEventListener('change', (e) => saveSettings({ usageAlerts: e.target.checked }));
    els.compactModeToggle.addEventListener('change', (e) => {
      // Applied (and persisted) when the settings view closes — the 290px layout cannot host it.
      state.compactPending = e.target.checked;
    });
    els.themeSeg.addEventListener('click', (e) => {
      const b = e.target.closest('.seg-btn');
      if (b && b.dataset.theme) saveSettings({ theme: b.dataset.theme });
    });
    els.backgroundSeg.addEventListener('click', (e) => {
      const b = e.target.closest('.seg-btn');
      if (b && !b.disabled && b.dataset.bg) saveSettings({ background: b.dataset.bg });
    });
    els.providerClaudeToggle.addEventListener('change', (e) => saveSettings({ providers: { claude: e.target.checked } }));
    els.providerCodexToggle.addEventListener('change', (e) => saveSettings({ providers: { codex: e.target.checked } }));
    els.claudeSourceSelect.addEventListener('change', async (e) => {
      await saveSettings({ claudeSource: e.target.value });
      if (e.target.value === 'claude_web') loadOrgs();
      doRefresh();
    });
    els.claudeWebLoginBtn.addEventListener('click', claudeWebLogin);
    els.claudeWebLogoutBtn.addEventListener('click', claudeWebLogout);
    els.claudeOrgSelect.addEventListener('change', async (e) => {
      const id = e.target.value;
      await safeInvoke('claudeWebSelectOrg', id);
      state.settings.claudeOrganizationId = id;
      doRefresh();
    });
    els.tokenAutoRefreshToggle.addEventListener('change', (e) => saveSettings({ tokenAutoRefresh: e.target.checked }));
    els.trayStatsSelect.addEventListener('change', (e) => {
      const patch = { trayStats: e.target.value };
      if (e.target.value === 'off' && state.settings.hideFromTaskbar) patch.hideFromTaskbar = false;
      saveSettings(patch);
    });
    [els.warnThreshold, els.dangerThreshold].forEach((input) => {
      input.addEventListener('input', readThresholds);
      input.addEventListener('change', commitThresholds);
      input.addEventListener('blur', commitThresholds);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commitThresholds(); input.blur(); } });
    });
    els.timeFormatSelect.addEventListener('change', (e) => saveSettings({ timeFormat: e.target.value }));
    els.dateFormatSelect.addEventListener('change', (e) => saveSettings({ dateFormat: e.target.value }));
    els.refreshIntervalSelect.addEventListener('change', (e) => saveSettings({ refreshInterval: String(e.target.value) }));

    // Phone sync. Main generates the pair key when the toggle turns on without one; its status broadcast
    // (phone-sync-updated) keeps the status line current, loadPhoneStatus() covers the first paint.
    els.phoneSyncToggle.addEventListener('change', (e) => saveSettings({ phoneSyncEnabled: e.target.checked }).then(loadPhoneStatus));
    els.phoneRelayUrl.addEventListener('input', () => {
      state.phone.relayDraft = null;
      state.phone.testResult = null;
      render(); // hint/Test button follow the text live; the field itself is never overwritten while focused
    });
    els.phoneRelayUrl.addEventListener('change', commitRelayUrl);
    els.phoneRelayUrl.addEventListener('blur', commitRelayUrl);
    els.phoneRelayUrl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitRelayUrl(); els.phoneRelayUrl.blur(); }
    });
    els.phoneTestBtn.addEventListener('click', phoneTest);
    els.phonePairBtn.addEventListener('click', togglePairing);
    els.phoneRepairBtn.addEventListener('click', phoneRepair);
    els.phoneUnpairBtn.addEventListener('click', () => {
      state.phone.confirmUnpair = true;
      render();
      els.phoneUnpairNoBtn.focus({ preventScroll: true }); // safe default under the keyboard
    });
    els.phoneUnpairYesBtn.addEventListener('click', phoneUnpair);
    els.phoneUnpairNoBtn.addEventListener('click', () => { state.phone.confirmUnpair = false; render(); });
    els.phonePushBtn.addEventListener('click', phonePushNow);
    els.phoneCopyBtn.addEventListener('click', copyPairString);
    els.phonePairString.addEventListener('focus', () => els.phonePairString.select());
    // The QR is a data URL that decodes after the panel is shown — the window height must follow it.
    els.phoneQr.addEventListener('load', () => measureAndResize());

    // Re-measure when fonts swap in or anything else nudges the layout.
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => measureAndResize()).observe(els.container);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => measureAndResize());
  }

  function subscribe() {
    safeCall('onUsageUpdated', (snap) => applySnapshot(snap));
    safeCall('onSettingsUpdated', (s) => {
      const wasCompact = state.compact;
      const prevBackground = state.settings.background;
      applySettings(s);
      if (!state.settingsOpen && wasCompact !== state.compact) safeCall('setCompactMode', state.compact);
      render(wasCompact !== state.compact);
      if (state.graphVisible && !state.history) loadHistory();
      if (state.settings.background !== prevBackground) refreshAppInfo();
    });
    safeCall('onRefreshRequested', () => {
      state.refreshing = true;
      renderTitleBar();
      armSpinnerSafety();
    });
    safeCall('onClaudeWebSessionExpired', () => {
      state.webStatus = 'claude.ai session expired — log in again';
      doRefresh();
    });
    safeCall('onPhoneSyncUpdated', (st) => {
      if (!st || typeof st !== 'object') return;
      state.phone.status = st;
      if (state.settingsOpen) render();
    });
  }

  function startTicker() {
    clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      render();
      checkResetBoundaries();
    }, TICK_MS);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  function cacheElements() {
    const ids = ['widgetContainer', 'titleBar', 'settingsBtn', 'refreshBtn', 'graphBtn', 'minimizeBtn', 'closeBtn',
      'mainView', 'compactBtn', 'headersRow', 'providers', 'graphCard', 'legend', 'usageChart', 'chartEmpty',
      'compactView', 'compactRows', 'expandBtn', 'settingsView', 'doneBtn', 'autoStartCol', 'autoStartToggle',
      'autoStartHint', 'hideFromTaskbarToggle', 'alwaysOnTopToggle', 'usageAlertsToggle', 'compactModeToggle',
      'themeSeg', 'backgroundSeg', 'backgroundHint', 'backgroundClearHint', 'providerClaudeToggle', 'providerCodexToggle',
      'claudeSourceSelect', 'claudeWebLoginBtn', 'claudeWebLogoutBtn', 'claudeOrgSelect', 'claudeWebStatus',
      'tokenAutoRefreshToggle', 'trayStatsSelect', 'warnThreshold', 'dangerThreshold', 'thresholdHint',
      'timeFormatSelect', 'dateFormatSelect', 'refreshIntervalSelect', 'versionLabel',
      'phoneSyncToggle', 'phoneStatusLine', 'phoneRelayUrl', 'phoneTestBtn', 'phoneRelayHint', 'phonePairBtn',
      'phoneRepairBtn', 'phoneUnpairBtn', 'phonePushBtn', 'phoneUnpairConfirm', 'phoneUnpairYesBtn', 'phoneUnpairNoBtn',
      'phonePairing', 'phoneQr', 'phonePairString', 'phoneCopyBtn', 'phonePairHint'];
    ids.forEach((id) => { els[id] = document.getElementById(id); });
    els.container = els.widgetContainer;
    els.chartCanvas = els.usageChart;
  }

  async function init() {
    cacheElements();
    if (!api) {
      els.mainView.replaceChildren(h('div', { class: 'fatal', text: 'The preload bridge (window.api) is missing — the widget cannot talk to the main process.' }));
      measureAndResize(true);
      return;
    }
    systemThemeMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    if (systemThemeMq && systemThemeMq.addEventListener) {
      systemThemeMq.addEventListener('change', () => {
        if (state.settings.theme === 'system') { applyTheme(); render(); }
      });
    }
    bindStaticEvents();
    subscribe();
    applyBackground(); // default backdrop class on the very first paint (no flash when app info lands)
    applyTheme();
    render(); // skeleton immediately — never a blank panel

    const [info, settings, snapshot] = await Promise.all([
      safeInvoke('getAppInfo'), safeInvoke('getSettings'), safeInvoke('getSnapshot'),
    ]);
    state.appInfo = info || {};
    applySettings(settings || {});
    if (snapshot && snapshot.providers) {
      state.snapshot = snapshot;
      state.loading = false;
    }
    render(true);
    firstSnapshotRendered = !!state.snapshot;
    if (state.graphVisible) loadHistory();
    checkResetBoundaries();
    startTicker();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
