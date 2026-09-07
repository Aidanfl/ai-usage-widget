# AI Usage Widget — Architecture & Contracts

Desktop widget (Windows first) showing **Claude** and **Codex** usage limits in one panel.
Successor to SlavomirDurej's `claude-usage-widget` v1.7.6 (MIT; original source is the reference for
look/feel and feature parity). Everything below is the contract implementation agents must follow.

Reference material (read-only):
- Original source: `C:/Users/Aidan/AppData/Local/Temp/claude/C--Users-Aidan/206cac6e-ebfe-44c7-a145-7cb5cb8dfa1e/scratchpad/src/claude-usage-widget-1.7.6/`
- Specs/research: `.../scratchpad/spec-renderer.md`, `spec-main.md`, `research-claude.md`, `research-codex.md`
- Mockup render harness (acrylic screenshots): `.../scratchpad/harness/shoot.ps1`

## 1. Stack

- Electron `^41.10.7` (CommonJS main process; `require`), `electron-store@^8` (v11 is ESM-only — do NOT upgrade),
  `chart.js@4` UMD + `chartjs-adapter-date-fns` + `date-fns` (loaded via `<script src="../../node_modules/...">`),
  `qrcode@^1.5` (main process only; pairing QR for phone sync, §14), `electron-builder@26` (nsis + portable).
  Node 24 on the dev machine.
- No bundler. Renderer is vanilla HTML/CSS/JS with `contextIsolation: true`, `nodeIntegration: false`, strict CSP
  (`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'none'`).
  All network I/O happens in the main process with Node `fetch` (no BrowserWindow tricks except the optional claude.ai web source).
- Unit tests: `npm test` → `node --test "tests/**/*.test.js"` (Node ≥ 21 treats positional args as globs, so a bare
  `tests/` directory does not work). Pure modules only; no Electron imports in tested modules — inject dependencies.

## 2. File layout

```
package.json                     main = src/main/main.js
ARCHITECTURE.md                  this file
assets/                          icon.ico, logo.png (Claude), tray-icon.png, fonts/LibreBaskerville-{Regular,Bold}.ttf
                                 codex-logo.svg (inline SVG also acceptable), claude-logo.svg
src/main/main.js                 app lifecycle, single-instance lock, wiring of modules, IPC registration
src/main/window.js               createMainWindow(), backdrop material handling, sizing (see §4), position persistence/recovery, show/hide logic
src/main/store.js                electron-store instance, SETTINGS_DEFAULTS, getSettings()/saveSettings(patch)
src/main/history.js              usage history append/prune/read (see §7)
src/main/scheduler.js            refresh loop: fetch all enabled providers → snapshot → history → tray → alerts → renderer
src/main/tray.js                 tray badges (bitmap font port from original), tooltips, context menu
src/main/alerts.js               threshold/blocked/available notification state machine (pure; Electron Notification injected)
src/main/sync.js                 PURE-ish: phone sync — key derivation, AES-GCM envelope, PhonePayload, push policy, relay client (§14)
src/main/providers/claude.js     Claude provider via Claude Code credentials (~/.claude/.credentials.json) → api.anthropic.com
src/main/providers/claude-web.js Claude provider via claude.ai browser login (sessionKey cookie) — port of original; optional
src/main/providers/codex.js      Codex provider via ~/.codex/auth.json → chatgpt.com/backend-api/wham/usage
src/main/providers/normalize.js  PURE: raw payloads → ProviderSnapshot (both providers); label/colour derivation
src/main/providers/tokens.js     PURE-ish: JWT decode, expiry checks, atomic credential file write, refresh calls (fetch injected)
src/preload.js                   contextBridge → window.api (see §8)
src/renderer/index.html
src/renderer/styles.css
src/renderer/app.js              state, rendering, timers, settings UI, chart
src/renderer/format.js           PURE formatting helpers (durations, reset times, currency) — also unit-tested
tests/*.test.js
docs/PHONE-SYNC.md               phone sync protocol (derivations, envelope, relay HTTP API, PhonePayload, push policy)
relay/                           Cloudflare Worker relay (src/worker.js, wrangler.toml, README.md) — no dependencies, tested under Node
```

Pure modules (`normalize.js`, `tokens.js`, `alerts.js`, `format.js`, `history.js` logic, `sync.js`) must not `require('electron')`.

## 3. Data model — `Snapshot`

Produced by the scheduler after every refresh and pushed to the renderer over IPC (`usage-updated`).

```js
Snapshot = {
  fetchedAt: 1788700000000,                 // ms epoch of this refresh
  providers: {
    claude: ProviderSnapshot | null,        // null when the provider is disabled in settings
    codex:  ProviderSnapshot | null,
  }
}

ProviderSnapshot = {
  id: 'claude' | 'codex',
  name: 'Claude' | 'Codex',
  status: 'ok' | 'stale' | 'auth_required' | 'error',
  //  ok            fresh data this cycle
  //  stale         this cycle failed but `windows` carry the last good values (main keeps last good per provider)
  //  auth_required no usable credentials (file missing, token expired and refresh disabled/failed, web session dead)
  //  error         other failure and no last-good data
  error: null | { code: string, message: string },   // codes: 'no_credentials','token_expired','refresh_failed','http_401','http_403','http_429','http_5xx','network','parse'
  source: 'claude_code' | 'claude_web' | 'codex_auth_file',
  plan: string | null,                      // friendly plan label, e.g. 'Max 20x', 'Pro', 'Team', 'Plus'
  account: string | null,                   // display name or email (renderer shows it only in settings)
  updatedAt: number,                        // ms epoch of the last successful fetch for this provider
  windows: UsageWindow[],                   // ordered rows to render (see below)
  extra: ExtraUsage | null,                 // Claude extra usage / spend + credits (null if unknown)
  credits: CodexCredits | null,             // Codex credits (null for Claude)
  raw: object                               // the raw API payload(s) — for debugging only, never rendered
}

UsageWindow = {
  key: string,            // stable id: claude: 'session' | 'weekly' | 'weekly_<scope>' (e.g. 'weekly_fable') | '<bucket>'
                          //            codex:  'primary' | 'secondary' | 'code_review' | 'additional_<name>'
  label: string,          // UPPERCASE-able row label: 'Current Session', 'Weekly Limit', 'Fable Weekly', '5-Hour Limit', ...
  kind: 'session' | 'weekly' | 'weekly_scoped' | 'other',
  percent: number,        // 0..100 (may exceed 100 — clamp in renderer)
  resetsAt: string|null,  // ISO 8601 (Codex reset_at unix seconds → ISO)
  windowSeconds: number|null,  // 18000 for 5h, 604800 for 7d; used for the elapsed ring; null → ring hidden
  severity: 'normal'|'warning'|'critical'|'blocked' | null,  // from API when present (Claude `limits[].severity`), else null
  isActive: boolean|null, // Claude limits[].is_active (the limit currently constraining the user); null when unknown
  color: 'purple'|'blue'|'fuchsia'|'green'|'teal'|'amber'|'rose'|'slate',  // series colour token (renderer maps to CSS)
  scope: string|null,     // 'Fable' for scoped model limits; Codex model name for per-model limits
  note: string|null,      // tooltip text explaining the percent; Fable row: "Percent of Fable's 50% share of the weekly limit"; null otherwise
}

ExtraUsage = {            // Claude only. Amounts are MINOR units (cents) unless stated
  enabled: boolean,
  currency: 'USD' | string,
  exponent: 2,
  usedMinor: number|null,        // spent this month
  limitMinor: number|null,       // monthly cap (null = no cap set)
  percent: number|null,          // used/limit*100 when both known, else API-provided utilization, else null
  balanceMinor: number|null,     // prepaid credit balance = prepaid `amount` (claude_web /prepaid/credits, or for claude_code the OAuth
                                 // mirror GET /api/oauth/organizations/<org uuid>/prepaid/credits); falls back to oauth `spend.balance`
  promoMinor: number|null, paidMinor: number|null,   // sum of promo_tranches[] / tranches[] remaining_amount_minor_units
  nextExpiresAt: string|null, nextExpiryMinor: number|null,  // next_expires_at + sum of remaining of ALL tranches expiring then
  disabledReason: string|null,
}

CodexCredits = {
  hasCredits: boolean, unlimited: boolean, balance: number|null,   // balance as returned (units per research-codex.md)
  overageLimitReached: boolean,
  approxLocalMessages: number|null, approxCloudMessages: number|null,
  limitReached: boolean,          // rate_limit.limit_reached
  limitReachedType: string|null,  // rate_limit_reached_type
  modelUsage: { [model: string]: { available: boolean, availableAt: string|null } },
}
```

### Row derivation rules (normalize.js)

**Claude** (`/api/oauth/usage` or claude.ai `/usage` — same shape):
1. `session` ← `five_hour` (percent = utilization, resetsAt, windowSeconds 18000, color purple, label "Current Session").
2. `weekly` ← `seven_day` (windowSeconds 604800, color blue, label "Weekly Limit").
3. For each `limits[]` entry with `kind === 'weekly_scoped'` and `scope.model.display_name`: key `weekly_<slug>`,
   label `<DisplayName> Weekly` (e.g. "Fable Weekly"), kind `weekly_scoped`, color fuchsia for Fable, otherwise rotate
   rose/amber/slate. The Fable row gets `note: "Percent of Fable's 50% share of the weekly limit"` (its percent is relative
   to Fable's 50 % allotment, not the whole weekly pool — research-claude.md §1.4.3); every other row has `note: null`.
   Also merge `severity`/`is_active` from `limits[]` into the session/weekly rows (`kind` session/weekly_all).
4. Legacy non-null buckets `seven_day_opus`, `seven_day_sonnet`, `seven_day_cowork`, `seven_day_oauth_apps`,
   `seven_day_omelette` (Design) → rows labelled "Opus Weekly", "Sonnet Weekly", "Cowork Weekly", "OAuth Apps Weekly",
   "Design Weekly" ONLY when non-null and not already represented by a scoped limit. Unknown codename buckets
   (`tangelo`, `nimbus_quill`, ...) are ignored unless `utilization > 0` AND `resets_at` non-null (then a generic row
   labelled by key). `juniper_tide` is the `/limit-reset` eligibility block, never a usage window — ignored entirely.
   Never render a null bucket.
5. `extra` ← `extra_usage` + `spend` (+ web `overage_spend_limit`/`prepaid/credits` when using claude_web; + the OAuth
   `prepaid/credits` payload when using claude_code — `normalizeClaude({ prepaid })`): see §3 amounts.
6. `plan` ← credentials `rateLimitTier` mapping: `default_claude_max_20x`→'Max 20x', `default_claude_max_5x`→'Max 5x',
   `default_claude_pro`→'Pro', else `subscriptionType` capitalised; claude_web: from `/api/organizations` fields per spec-main.md.

**Codex** (`wham/usage`):
1. `primary` ← `rate_limit.primary_window`, `secondary` ← `rate_limit.secondary_window` (skip null windows).
   Label by `limit_window_seconds`: ≤ 6h → "5-Hour Limit" (kind session, color green), ≥ 6 days → "Weekly Limit"
   (kind weekly, color teal), else `"<N>-Hour Limit"`. Order rows shortest window first. `resetsAt` = `reset_at*1000`
   → ISO (fallback `now + reset_after_seconds`). percent = `used_percent`.
2. `code_review_rate_limit` and `additional_rate_limits` → extra rows if non-null (shape per research-codex.md).
3. `credits` ← `credits` + `rate_limit` flags + `model_usage`.
4. `plan` ← `plan_type` mapping: `plus`→'Plus', `pro`→'Pro', `team`/`self_serve_business*`→'Team', `business`→'Business',
   `enterprise`→'Enterprise', `edu`→'Edu', `free`→'Free', unknown → Title Case of the raw value.

## 4. Window & backdrop (window.js)

- Frameless, `resizable: false`, `alwaysOnTop` per setting (level `'floating'`), `skipTaskbar` per setting,
  `useContentSize: true`, `roundedCorners: true`, `hasShadow: true`.
- **Backdrop setting** `settings.background`: `'acrylic'` (UI label **Smoky Acrylic**; default on Windows 11 build ≥ 22621;
  the stored value predates the rename and is kept for compatibility) | `'acrylic_clear'` (**Clear Acrylic**) | `'mica'` | `'solid'`.
  - acrylic / acrylic_clear / mica: `transparent: false`, `backgroundMaterial: materialFor(bg)` (`'acrylic'` for both acrylics,
    `'mica'` for mica). **Windows fixes the acrylic blur strength (verified 2026-09-06, Electron 41.10.7)**; the only knobs are
    the DWM immersive theme of the window and our CSS tint. Immediately before `new BrowserWindow`, `createMainWindow()` sets
    `nativeTheme.themeSource = themeSourceFor(bg)`: `'dark'` for acrylic (dark grey glass base even when Windows is in light
    mode), `'light'` for acrylic_clear (bright, milky, clearly see-through light glass), `'system'` for mica/solid. themeSource
    is app-global, so it also drives the renderer's `prefers-color-scheme` (the `system` theme follows the backdrop; accepted).
    Renderer tint (styles.css, body class `bg-acrylic` / `bg-clear` / `bg-mica` / `bg-solid` chosen from the *applied*
    backdrop reported by `get-app-info`): Smoky dark = panel `rgba(24,22,40,0.30)`, title band `rgba(0,0,0,0.14)` (cards
    `rgba(255,255,255,0.035)`, wells `rgba(0,0,0,0.14)`, text-shadow kept); Smoky + light theme = the light tint
    `rgba(250,250,255,0.55)`; Mica keeps the heavier 0.1.0 tint (`0.46` / `0.22`). Clear = **no tint at all** (panel
    `transparent`), title band `rgba(255,255,255,0.10)`, cards `rgba(255,255,255,0.22)` + 1px `rgba(0,0,0,0.06)` border, wells
    `rgba(0,0,0,0.05)`, no text-shadow, and the renderer FORCES the light (dark-text) palette while `bg-clear` is active
    regardless of `theme` (white text is unreadable on the light base) — Settings shows "Clear Acrylic uses dark text".
    Bars/rings keep their series colours. The page/body background MUST be `transparent` so the blur shows through. Rounded
    corners are drawn by DWM (no CSS radius needed on the outer container).
  - solid: `transparent: true`, no material; renderer draws the original opaque-ish panel with CSS `border-radius: 12px`.
  - `transparent`, `backgroundMaterial` and the creation-time immersive theme are creation-only in Electron → changing
    `background` (including acrylic ↔ acrylic_clear) recreates the window (same position); main compares
    `getAppliedBackground(win)` with `resolveBackground(next)` so a no-op change (unsupported → still solid) does nothing.
  - Do NOT try the user32 accent-policy blur (`SetWindowCompositionAttribute` ACCENT_ENABLE_BLURBEHIND/ACRYLICBLURBEHIND) on a
    transparent window: it renders solid black in Electron 41 (verified on this machine).
  - Capability probe: `process.platform === 'win32' && parseInt(os.release().split('.')[2]) >= 22621` → materials allowed; else
    force solid (all three material values downgrade together).
- **Sizing quirk (verified on this machine, Electron 41.10.7):** a frameless window with a `backgroundMaterial` is created
  64×32 px smaller than requested, and every later `setContentSize(w,h)` lands 16×8 px short (the invisible resize border).
  `thickFrame: false` fixes the size but loses rounded corners and the shadow, so keep the thick frame and compensate:
  ```js
  function applyContentSize(win, w, h) {           // call after 'ready-to-show' and for every resize
    win.setContentSize(w, h);
    const [cw, ch] = win.getContentSize();
    if (cw !== w || ch !== h) win.setContentSize(w + (w - cw), h + (h - ch));
  }
  ```
  Verify with `getContentSize()` and log a warning if it still differs. Apply the same helper in solid/transparent mode
  (it is a no-op there).
- Widths: normal **560**, compact **290** (match original). Height is owned by the renderer: it measures its content and
  calls `api.resizeWindow(height)`; main applies `applyContentSize(WIDTH, height)`.
- Position persistence (`windowPosition`), off-screen recovery (center on primary work area when not intersecting any
  display), single-instance lock, `before-quit` flag, close → hide when a tray icon exists else quit, minimize → hide
  to tray when `hideFromTaskbar` and tray exists else normal minimize. Periodic (5 s) always-on-top re-assertion.
- Dragging: title bar uses `-webkit-app-region: drag`; controls inside it `no-drag`.

## 5. Settings (store.js) — keys, defaults, side effects

| key | default | notes |
|---|---|---|
| `autoStart` | false | `app.setLoginItemSettings({openAtLogin, path: exe})`; disabled in portable builds |
| `hideFromTaskbar` | false | `setSkipTaskbar`; forces `trayStats !== 'off'` when true (coupling as original) |
| `alwaysOnTop` | true | |
| `theme` | 'dark' | 'dark' \| 'light' \| 'system' (system via `prefers-color-scheme`) |
| `background` | 'acrylic' | 'acrylic' (Smoky Acrylic) \| 'acrylic_clear' (Clear Acrylic; forces the dark-text palette) \| 'mica' \| 'solid' (all materials auto-downgraded to 'solid' when unsupported; a change recreates the window, §4) |
| `warnThreshold` | 75 | amber at/above |
| `dangerThreshold` | 90 | red at/above |
| `timeFormat` | '12h' | '12h' \| '24h' |
| `dateFormat` | 'date' | 'date' (Sep 7) \| 'date-day' (Sun Sep 7) \| 'date-day-time' |
| `usageAlerts` | true | desktop notifications |
| `compactMode` | false | |
| `refreshInterval` | '120' | seconds as string: '15','30','60','120','300' (the Claude provider additionally enforces a 60 s floor, §6) |
| `graphVisible` | false | |
| `expandedOpen` | `{claude:false, codex:false}` | per-provider expand panel state |
| `providers` | `{claude:true, codex:true}` | show/hide provider groups |
| `claudeSource` | 'claude_code' | 'claude_code' \| 'claude_web' |
| `tokenAutoRefresh` | true | allow refreshing Claude Code / Codex tokens when expired (writes files back; see §6) |
| `trayStats` | 'off' | 'off' \| 'claude' \| 'codex' \| 'both' |
| `windowPosition` | null | `{x,y}` |
| `claudeOrganizationId` | null | claude_web only |
| `phoneSyncEnabled` | false | phone sync (§14): turning it on without a pair key generates one (`phonePairKey`, safeStorage-encrypted, NOT a setting) and triggers the first push |
| `phoneRelayUrl` | '' | relay base URL, stored normalized by `sync.validateRelayUrl` (https only, http for localhost/127.0.0.1, no query/fragment/credentials, trailing slash stripped, ≤ 512 chars) or `''` when invalid; a change resets the push state and fills the new relay |

`saveSettings(patch)` merges, persists, applies side effects, and broadcasts `settings-updated` to the renderer.

## 6. Providers & credentials

### Claude via Claude Code credentials (`providers/claude.js`, default)
Rules from research-claude.md §1.3, §1.8, §1.9, §2.1–2.4, §8.5 (binding):
- Read `%USERPROFILE%/.claude/.credentials.json` (also honour `CLAUDE_CONFIG_DIR`), key `claudeAiOauth`, on EVERY poll
  (also `fs.stat` it — the mtime feeds the refresh guards below).
- **Headers** for every OAuth call: `Authorization: Bearer`, `anthropic-beta: oauth-2025-04-20`, `Accept: application/json`,
  `Content-Type: application/json`, `User-Agent: claude-cli/<version> (external, cli)` — `<version>` detected once per
  process by running `claude --version` (3 s timeout, first semver, cached; fallback `2.1.263`). A non-Claude UA lands the
  token in an aggressively rate-limited bucket (persistent 429s without Retry-After). Never send `x-api-key`.
- **Claude polling floor 60 s**: at most one real `GET /api/oauth/usage` per 60 s per process regardless of
  `settings.refreshInterval`; a poll (manual refresh included) inside the floor returns the previous snapshot unchanged
  (status `ok`, previous `updatedAt`). 429 → honour `Retry-After` if present, else back off 5 → 10 → 20 → 30 min (cap 30),
  never retry inside 60 s; keep last good data as `stale` with `error.code 'http_429'` and message
  `"Rate limited, retrying at hh:mm"`; also set the `skipNextCycle` scheduler hint on the 429 itself.
- **In-band error**: a 200 whose body has NONE of `five_hour, seven_day, seven_day_oauth_apps, seven_day_opus,
  seven_day_sonnet, cinder_cove, extra_usage, limits` is a failure (`parse`), last good kept.
- **Refresh — never proactively before expiry.** Claude Code refreshes 4 min ahead and refresh tokens are single-use, so a
  widget refreshing at `expiresAt − 2 min` would race it and burn the token. Trigger only when (a) `now ≥ expiresAt + 60 s`
  (token actually lapsed) OR the usage request returned 401; AND (b) a fresh re-read of the file still shows the
  `refreshToken` we loaded; AND (c) `refreshTokenExpiresAt` (if present) is in the future; AND (d) this process made no
  refresh attempt in the last 10 min; AND (e) the file's mtime is ≥ 30 s old and Claude Code's lock is free. A lapsed token
  with `tokenAutoRefresh` off → `auth_required` / `token_expired`. Inside the grace / close to expiry the token is used as-is.
- **Lock + write-back** (`tokens.refreshClaudeTokens`): acquire `<configDir>/.oauth_refresh.lock` with proper-lockfile
  semantics (exclusive `mkdir`, stale after 60 s by mtime → taken over, poll 1–2 s up to 7.5 s, give up this cycle when
  still held; mtime touched every 5 s while held; `rmdir` in `finally`). Under the lock re-read the file — if
  `accessToken`/`refreshToken` changed, use theirs and make no request. POST `https://platform.claude.com/v1/oauth/token`
  (fallback `console.anthropic.com` only on 404/405/5xx/network) with JSON `{ grant_type, refresh_token, client_id,
  scope: <stored scopes joined by spaces> }`, `Content-Type`/`Accept: application/json`, the same UA, NO `anthropic-beta`.
  Response `access_token`, `refresh_token?` (keep old), `expires_in`, `refresh_token_expires_in?` → `refreshTokenExpiresAt`,
  `scope?` → `scopes`, `account?`. Write back by spreading the freshly re-read `claudeAiOauth`, overriding only those fields
  and preserving every other key (`profile`, `clientId`, `tokenAccount`, top-level `mcpOAuth`…), compact `JSON.stringify`,
  via `<target>.tmp.<8hex>` (exclusive create, fsync) + rename; a failed staging write removes its temp file. If the rename
  is still refused after the retries for a sharing/permission reason (EPERM/EBUSY/EACCES, or an EEXIST staging collision)
  the target is rewritten in place instead (Claude Code has the same arm) — the rotated single-use refresh token must reach
  the disk or every Claude Code process is forced to `/login`; never in place on ENOSPC/EIO (would truncate the file).
  A token-endpoint response whose body cannot be read is transient and is NOT replayed on the alias host. Parse errors from
  the credentials file never quote file content. 400/401 `invalid_grant` → permanent: `auth_required` /
  `refresh_failed`, no further attempts for 24 h or until the credentials file changes (mtime / refresh token).
  Network/5xx → back-off 60 s then 30 min (in practice the 10-min attempt spacing dominates the first retry); reported as
  `stale` / `refresh_failed`. Lock held / file just written / spacing → `stale` / `token_expired` "waiting for Claude Code".
- **401** (may arrive BEFORE local `expiresAt`): re-read the file; token changed → retry once with the new token; else
  refresh per the rules above → retry once; else `auth_required` / `http_401`
  `"Claude Code sign-in expired - run claude to sign in again"`. **403** with a scope message → `auth_required` / `http_403`
  mentioning the `user:profile` scope; no retry until the credentials file changes.
- Also fetch `/api/oauth/profile` at most once per hour per token (`account`, plan fallback, `organization.uuid`), and
  `GET /api/oauth/organizations/<organization.uuid>/prepaid/credits` at most once per 5 min and only when
  `settings.expandedOpen.claude` is true OR (`settings.compactMode` && `settings.compactSpendOpen`, undefined → false) OR
  nothing has been fetched yet (first fill). Mapping per §3 `ExtraUsage`. Failures are non-fatal (debug log, previous
  values kept).
- Timeouts 15 s (AbortController; 30 s for the token call). Never log tokens.

### Claude via claude.ai web session (`providers/claude-web.js`, optional)
- Port of the original: login BrowserWindow (allowed domains list), capture `sessionKey` cookie, `safeStorage`
  encryption, org selection (`capabilities` includes 'chat', prefer team), hidden-window fetch of `/usage`,
  `/overage_spend_limit`, `/prepaid/credits` (extended endpoints only when the Claude expand panel is open or compact
  spend row open). Cloudflare block signatures → `auth_required`. Same normalize path → ProviderSnapshot with
  `extra.balanceMinor` etc.

### Codex (`providers/codex.js`)
- Read `%USERPROFILE%/.codex/auth.json` (honour `CODEX_HOME`). Require `tokens.access_token` and
  `tokens.account_id` (fallback: JWT claim `https://api.openai.com/auth`.`chatgpt_account_id`).
- Expiry: decode JWT `exp`. Refresh ONLY when `now >= exp + 60 s` (the token has actually lapsed) or after a real 401
  whose re-read shows the same token; never proactively before expiry (the Codex desktop app refreshes ≤5 min before
  `exp` and refresh tokens are single-use). Skip when auth.json mtime is younger than 30 s; at most one attempt per
  10 min; guarded reload + atomic write-back + permanent/transient classification; 30 s floor between real
  `wham/usage` requests; 429 → Retry-After (capped) or exponential park. When `tokenAutoRefresh` is off → `auth_required`.
- `GET https://chatgpt.com/backend-api/wham/usage` with `Authorization: Bearer`, `chatgpt-account-id`,
  `Accept: application/json`, `User-Agent` per research. 401 → refresh once → else `auth_required`.
- If `auth_mode === 'apikey'` or no ChatGPT tokens → status `auth_required`, code `no_credentials`,
  message "Sign in to Codex with ChatGPT to see usage".

### Scheduler (`scheduler.js`)
- One timer (interval from settings). Each tick: `Promise.allSettled` over enabled providers → build `Snapshot`
  (keeping last-good values for failed providers, marked `stale`) → `history.append(snapshot)` → `tray.update(snapshot)`
  → `alerts.evaluate(snapshot, settings)` → `mainWindow.webContents.send('usage-updated', snapshot)`.
- Manual refresh (`refresh-now`) runs a tick immediately and restarts the timer. Skip a tick while one is in flight.
  The Claude provider's 60 s polling floor (above) still applies — a manual refresh inside the floor re-emits the
  previous Claude snapshot instead of hitting the endpoint again.
- On resume from sleep (`powerMonitor 'resume'`) → immediate tick.

## 7. History (history.js)

Store key `usageHistory` → array of `{ t: msEpoch, v: { '<provider>.<windowKey>': percent, 'claude.extra': percent|undefined } }`.
Retention 8 days, cap 10 000 samples, prune on append and at startup. Skip append when a provider has no reset
timestamps (dead session heuristic from original) — only for that provider's keys. `getHistory(days=7)` returns the
sorted, trimmed array plus a `series` descriptor list `{ key, label, color }` built from the latest snapshot so the
chart knows names/colours.

## 8. IPC surface (preload → `window.api`)

```
invoke  get-settings                         → Settings
invoke  save-settings {patch}                → Settings
invoke  get-snapshot                         → Snapshot|null (last)
invoke  refresh-now                          → Snapshot
invoke  get-history {days}                   → { samples:[{t,v}], series:[{key,label,color}] }
invoke  get-app-info                         → { version, platform, acrylicSupported, isPortable,
                                                 background }   // backdrop the CURRENT window was created with:
                                                                // 'acrylic' | 'acrylic_clear' | 'mica' | 'solid' (renderer keys bg-* off this)
invoke  claude-web-login                     → { success, error? }          (claude_web source)
invoke  claude-web-logout                    → true
invoke  claude-web-orgs                      → [{id,name,isTeam}]
invoke  claude-web-select-org {id}           → true
invoke  phone-sync-status                    → { enabled, relayUrl, paired, keyPersisted, lastPushAt, lastError, nextRetryAt, slotId }
invoke  phone-sync-pairing                   → { pairString, qrDataUrl, slotId, error }   (creates K when absent; never rotates)
invoke  phone-sync-repair                    → same shape with a NEW K (old slot deleted best-effort)
invoke  phone-sync-unpair                    → true   (DELETE slot best-effort, forget K, phoneSyncEnabled → false)
invoke  phone-sync-test {relayUrl}           → { ok, status?, latencyMs?, error? }   (GET /v1/health on the given or saved URL)
invoke  phone-sync-push-now                  → { ok, error? }
send    minimize-window | close-window
send    resize-window {height}
send    set-compact-mode {compact}           (main resizes width/height; renderer then reports height)
send    open-external {url}                  allowlist: claude.ai, anthropic.com, chatgpt.com, openai.com, github.com
on      usage-updated (snapshot)
on      settings-updated (settings)
on      refresh-requested ()                 (tray menu → renderer shows spinner; main runs tick itself)
on      claude-web-session-expired ()
on      phone-sync-updated (status)          (same shape as phone-sync-status; after every push attempt / pairing change)
```

## 9. Renderer behaviour (parity list — details in spec-renderer.md)

- Title bar: app logo + "AI Usage" (Libre Baskerville), controls: settings ⚙, refresh ↻ (spins while a refresh is in
  flight), graph 📈 (active state highlighted), minimize −, close ×.
- Provider group = header row (provider mark, name, plan chip, status dot: green ok / amber stale / red auth or error,
  with tooltip message; "Sign in" affordance when auth_required) + column headers (USED · ELAPSED · RESETS IN · RESETS AT,
  shown once at the top of the panel) + one row per `UsageWindow`: label, gradient bar + percent, elapsed ring
  (SVG r=10, dasharray 63; ring thresholds: amber ≥75% elapsed, green ≥90%), resets-in text ("43m", "1d 8h", "Not started"
  when percent 0 and no resetsAt), resets-at text (12h/24h; weekly rows use the date format).
- Bar/percent colour: series colour < warn → amber ≥ warnThreshold → red ≥ dangerThreshold; `blocked` when ≥100.
- Expand chevron per provider → Claude: Extra Usage row (ON/OFF pill, monthly spend bar `$used / $cap`), Credits row
  (balance, promo/paid split, expiry chip) when known; Codex: Credits row, "Limit reached" badge, model availability.
- Graph section (Chart.js line chart, time x-axis over 7 days, one dataset per series with series colour, thin lines,
  no points, tooltips with time+value, y 0–100 with % ticks, legend toggles series). Persist `graphVisible`.
- Compact mode (290 px): thin bars "Claude 5h / Claude 7d / Fable 7d / Codex 7d…" with percent inside; chevron to return.
- Settings overlay (in-window, same style as original) with all keys in §5 plus provider toggles, Claude source
  selector (+ Log in / Log out for web), background selector (full-width row: Smoky Acrylic / Clear Acrylic / Mica / Solid;
  the three materials disabled with the "need Windows 11 (22H2+)" hint when unsupported; "Clear Acrylic uses dark text"
  hint while acrylic_clear is selected), tray stats selector, version label. Theme also has a full-width row.
- Loading/empty/error states per provider (never a blank panel; show the reason and a retry).
- Countdown texts tick locally every 30 s; new snapshots re-render immediately.
- Height: after every render, measure `#widgetContainer` scrollHeight → `api.resizeWindow(h)` (debounced 50 ms).

## 10. Tray (tray.js)

- Setting `trayStats`: for 'claude' → two badges (weekly blue left, session purple right); 'codex' → one badge per
  Codex window (weekly teal, 5h green); 'both' → Codex badges then Claude badges. 20×20 bitmap-font percentage badges
  (port from original, including the narrow 3-digit font), red ✕ at ≥99. Tooltip "Claude Weekly: 22%\nResets: Sep 7, 1:59 PM".
- Context menu: Show Widget, Refresh, separator, Exit. Left-click toggles show/hide (with off-screen recovery).

## 11. Alerts (alerts.js — pure state machine)

Per `provider.windowKey`: emit once per reset cycle (state keyed by `resetsAt`) for: warn (≥warnThreshold),
danger (≥dangerThreshold), blocked (≥100 or Codex `limit_reached`); emit "available again" once when a previously
blocked window drops below 100 AND no other window of that provider is blocked. Messages name the provider and window
("Claude · Weekly Limit at 91%"). Respect `usageAlerts`.

## 12. Verification checklist (for the integration/verify agents)

1. `npm test` passes. 2. `npm start` launches without console errors; both providers show real data on this machine.
3. Screenshot (harness or app) shows acrylic backdrop, exact 560 px width, rounded corners.
4. Toggle each setting live: theme, background (window recreate), compact, tray stats, thresholds, refresh interval.
5. Kill network → status stale with last-good values; restore → ok. 6. Expired-token path exercised with a unit test.
7. `npm run build:portable` produces `dist/AI-Usage-Widget-<ver>-win-portable.exe` that runs.

## 13. Module interfaces (parallel implementation contract)

All main-process modules are CommonJS. Pure modules take injected dependencies (`fetch`, `now`, paths) so tests can run
without Electron. Errors never escape provider `fetchSnapshot` — they become `status`/`error` on the snapshot.

```js
// src/main/store.js
module.exports = { store /* electron-store */, SETTINGS_DEFAULTS, getSettings(), saveSettings(patch) /* → merged settings */ };

// src/main/history.js  (pure logic + thin store adapter)
createHistory({ get: () => array, set: (array) => void, now: () => ms }) → {
  append(snapshot),               // pushes { t, v } built from snapshot.providers[*].windows (+ 'claude.extra'); prunes 8 d / 10 000
  get(days = 7, latestSnapshot) → { samples: [{ t, v }], series: [{ key, label, color }] },
  pruneAll()
}

// src/main/alerts.js (pure)
createAlertEngine({ notify: (title, body) => void, now }) → { evaluate(snapshot, settings), reset() }

// src/main/scheduler.js
createScheduler({ providers: [{ id, fetchSnapshot }], getSettings, onSnapshot, history, tray, alerts, log, now }) → {
  start(), stop(), refreshNow() → Promise<Snapshot>, getLastSnapshot(), applyInterval(seconds)
}

// src/main/tray.js
createTray({ onShow, onRefresh, onExit, getSettings }) → { update(snapshot), rebuild(), destroy(), hasIcon() }

// src/main/window.js
{ createMainWindow({ settings, savedPosition, onClose, onClosed, onMove, log, deps }) → BrowserWindow
      /* deps (tests): BrowserWindow, screen, nativeTheme, acrylicSupported (bool), crashReloadDelayMs.
         Sets deps.nativeTheme.themeSource = themeSourceFor(background) BEFORE `new BrowserWindow` */,
  applyContentSize(win, w, h), acrylicSupported(),
  BACKGROUNDS: ['acrylic', 'acrylic_clear', 'mica', 'solid'],
  resolveBackground(setting, supported = acrylicSupported()) → one of BACKGROUNDS ('solid' when unsupported, 'acrylic' for unknown),
  materialFor(background) → 'acrylic' | 'mica' | null, themeSourceFor(background) → 'dark' | 'light' | 'system',
  getAppliedBackground(win) → the resolved background the window was created with,
  WIDGET_WIDTH: 560, COMPACT_WIDTH: 290, isPositionOnScreen(x,y,w,h), getCenteredPosition(w,h) }

// src/main/providers/normalize.js (pure)
{ normalizeClaude({ usage, profile, credentials, web, prepaid }) → { windows, extra, plan, account },
  normalizeCodex({ usage }) → { windows, credits, plan, account },
  codexWindowLabel(limitWindowSeconds) → { label, kind, color, windowSeconds },
  claudePlanLabel(rateLimitTier, subscriptionType), codexPlanLabel(planType), slug(displayName), FABLE_NOTE }

// src/main/providers/tokens.js (pure-ish; fs + injected fetch)
{ decodeJwt(token) → claims|null, jwtExpiryMs(token) → ms|null,
  readJsonFile(path) → Promise<object|null>  /* retries once after 100 ms on parse error (writer may be mid-write) */,
  writeJsonAtomic(path, obj, { indent, tmpPath?, fsync?, fs?, sleep? }) → Promise<void>
      /* exclusive temp file in same dir + rename; retry EPERM/EBUSY/EACCES 6× (50 ms → 1 s); tmpPath: claudeTempPath = <target>.tmp.<8hex>;
         a failed staging write removes its own temp file (a foreign EEXIST staging file is left alone) */,
  sanitizeJsonError(message) → string  /* strips V8's quoted source window from JSON.parse messages; readJsonText uses it */,
  acquireLock(lockPath, { staleMs = 60 s, totalWaitMs = 7.5 s, updateMs = 5 s }) → Promise<{ ok, release()?, reason? }>
      /* proper-lockfile-compatible directory lock; never throws */,
  refreshCodexTokens({ fetch, authPath, now }) → Promise<{ ok, tokens?, permanent?, error? }>,
  refreshClaudeTokens({ fetch, credentialsPath, now, expectedRefreshToken, expectedAccessToken, lockPath?, lockOptions?, writeOptions? })
      → Promise<{ ok, oauth?, account?, rotatedByOther?, persisted?, inPlace?, permanent?, lockHeld?, error? }>
      /* persisted:false = both the atomic and the in-place write failed (tokens only in memory this cycle) */ }

// src/main/providers/codex.js, claude.js, claude-web.js
module.exports = { id, name, fetchSnapshot({ settings, fetch, now, log, lastGood }) → Promise<ProviderSnapshot> }
// claude.js additionally exports getUserAgent() → Promise<string>, setCliVersion(v), userAgentFor(v), creditsUrl(orgUuid),
// resetState() and its tunables (USAGE_FLOOR_MS, EXPIRY_GRACE_MS, REFRESH_SPACING_MS, FRESH_FILE_MS, RATE_LIMIT_STEPS_MS…).
```

### Token refresh rules (from research-codex.md; apply the same shape to Claude unless research-claude.md says otherwise)
- Codex: POST `https://auth.openai.com/oauth/token`, `Content-Type: application/json`, body
  `{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann","grant_type":"refresh_token","refresh_token":"<rt>"}` → `{ id_token?, access_token, refresh_token? }`.
  Refresh tokens ROTATE and are single-use. Only refresh when JWT `exp` + 60 s ≤ now (token lapsed) or on a 401, and ONLY after
  re-reading auth.json to confirm the token on disk is still the one we loaded (another process may have rotated it).
  Persist by re-reading the file, replacing `tokens.{id_token,access_token,refresh_token}` (keep old values for
  missing fields), setting `last_refresh` to RFC-3339 UTC now, and writing atomically. Permanent failures
  (400 `invalid_grant`, `refresh_token_expired|reused|invalidated`, 401) → stop retrying for 30 min and report
  `auth_required` with a message telling the user to sign in to Codex again. Transient (5xx/network) → back off 1→30 min.
- Claude (Claude Code credentials): token endpoint `https://platform.claude.com/v1/oauth/token` (what Claude Code 2.1.263
  uses; `https://console.anthropic.com/v1/oauth/token` only as a fallback on 404/405/5xx/network), JSON body
  `{ grant_type: 'refresh_token', refresh_token, client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', scope: <stored scopes
  joined by spaces> }` (no `anthropic-beta`) → `{ access_token, refresh_token?, expires_in, refresh_token_expires_in?, scope?,
  account? }`; write back `claudeAiOauth.{accessToken, refreshToken (old kept if absent), expiresAt = now + expires_in*1000,
  refreshTokenExpiresAt = now + refresh_token_expires_in*1000, scopes}` preserving all other keys, compact JSON, via
  `<target>.tmp.<8hex>` + rename, under `<configDir>/.oauth_refresh.lock`. Trigger/guard rules differ from Codex — see §6
  (no proactive refresh; only after `expiresAt + 60 s` or on 401; 10-min attempt spacing; invalid_grant parks 24 h).
- Both providers re-read their credential file on EVERY poll (the owning app may have rotated tokens) and never log tokens.
- Codex request headers: `Authorization: Bearer`, `ChatGPT-Account-Id`, `Accept: application/json`,
  `User-Agent: ai-usage-widget/<version> (Windows)` — truthful UA, do not impersonate `codex_cli_rs`.
  Codex 200 with `rate_limit.allowed === false` or `limit_reached === true` → mark all Codex windows `severity: 'blocked'`.
  Codex windows: classify by `limit_window_seconds` (±5 %): 18000 → "5-Hour Limit"; 86400 → "Daily Limit";
  604800 → "Weekly Limit"; 2592000 → "Monthly Limit"; else "<N>-Hour Limit". Never invent a missing window.
  Also surface `rate_limit_reset_credits.available_count` (>0) in `credits` as `resetCreditsAvailable`.

## 14. Phone sync (`src/main/sync.js`, `relay/`)

Protocol, wire formats and the desktop push policy are specified in **`docs/PHONE-SYNC.md`** (binding). Summary:
the desktop derives `slotId` / `writeToken` / `readToken` / `encKey` from a 32-byte pair key `K` (SHA-256 over
`label ‖ K`), encrypts a `PhonePayload` (the §3 Snapshot minus every `raw`, the three colour settings, and a
downsampled 7-day history) with AES-256-GCM (AAD = `slotId`) and PUTs the envelope to `<relay>/v1/slots/<slotId>`
at most every 60 s and normally every 5 min or on a change. `K` is persisted by main.js under the top-level store key
`phonePairKey` exactly like the claude.ai session (`safeStorage.encryptString(base64(K))` → base64); it never
reaches the renderer — the renderer only sees the `aiusage://pair?...` string and its QR data URL. The relay
(`relay/src/worker.js`, Cloudflare Worker + KV, zero dependencies) stores ciphertext plus token hashes only and is
driven directly by `tests/relay.test.js` under Node with an in-memory KV.

```js
// src/main/sync.js (pure-ish: no electron; fetch / clock / log / key persistence / QR renderer injected)
createPhoneSync({ getSettings, loadKey, saveKey, clearKey, fetch, now, log, appVersion, platform, hostname, qr, random, requestTimeoutMs }) → {
  load(),                                  // restore the persisted K (needs safeStorage → call after app ready); emits status
  onSnapshot(snapshot, history | () => history),   // scheduler hook; applies the push policy (history read lazily, only when pushing)
  settingsChanged(prev, next),             // phoneSyncEnabled / phoneRelayUrl side effects: generate K on enable, reset + refill on relay change
  getStatus() → { enabled, relayUrl, paired, keyPersisted, lastPushAt, lastError, nextRetryAt, slotId },
  getPairing() → Promise<{ pairString, qrDataUrl, slotId, error }>,   // creates K when absent, never rotates
  repair() → same shape with a NEW K (old slot DELETEd best-effort, first fill of the new slot),
  unpair() → Promise<true>,                // DELETE best-effort + forget K (main.js turns the setting off)
  test(relayUrl?) → Promise<{ ok, status?, latencyMs?, error? }>,     // GET /v1/health
  pushNow() → Promise<{ ok, error? }>,     // honours the 60 s floor
  onStatus(cb) → unsubscribe,              // main.js forwards to the `phone-sync-updated` broadcast
  pending() → Promise<void>                // resolves when the push in flight (if any) finished — tests
}
// pure helpers (all exported): deriveSlot(K) → { slotId, writeToken, readToken, encKey }, buildPairString(relayUrl, K),
// parsePairString(str) → { relayUrl, key } | null, encryptPayload(encKey, slotId, payload, { iv?, ts? }) → envelope,
// decryptEnvelope(encKey, slotId, envelope) → payload (Node reference of the phone's decrypt), isValidEnvelope(env),
// buildPhonePayload({ snapshot, history, settings, appVersion, platform, hostname, now }), downsampleHistory(samples),
// validateRelayUrl(str) → normalized | null (also used by store.js), shouldPush(prev, next, now, state) → false | reason,
// fingerprint(snapshot), plus the tunables PUSH_INTERVAL_MS, PUSH_FLOOR_MS, BACKOFF_MIN_MS, BACKOFF_MAX_MS, …

// relay/src/worker.js (ES module, Cloudflare Worker; KV binding SLOTS)
export default { fetch(request, env) }   // GET /v1/health · PUT/GET/DELETE /v1/slots/{slotId} per docs/PHONE-SYNC.md
```

Wiring in main.js: `phoneSync.load()` in `whenReady` (after `loadWebSession()`), `phoneSync.onSnapshot(snapshot,
() => history.get(7, snapshot))` from the scheduler's `onSnapshot`, `phoneSync.settingsChanged(prev, next)` in the
settings side-effects block, the six `phone-sync-*` invoke channels (§8) and `phone-sync-updated` via `onStatus`.
