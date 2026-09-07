# Changelog

All notable changes to AI Usage Widget. Dates are ISO (YYYY-MM-DD).

## 0.2.1 - 2026-09-07

### Changed

- **Weekly rows now show the date AND the time they reset.** Claude's *Weekly Limit*, *Fable Weekly* and Codex's *Weekly Limit* used to say only `Sep 7` in the RESETS AT column, which never told you when in that day the week rolls over; they now say `Sep 7, 3:59 PM` (or `Sun Sep 7, 15:59` with the weekday option and 24-hour time). Session rows are unchanged - they reset within hours, so the time alone is unambiguous.
- **The panel is 60 px wider (560 -> 620)** so the longer text fits on one line; the RESETS AT column grew from 72 to 120 px and the bar column gained the remaining 12 px. Compact mode is unchanged at 290 px.
- **Date format setting** now only chooses whether the weekday is included (`Sep 7, 3:59 PM` / `Sun Sep 7, 3:59 PM`); the time is always shown, so the old third option (`Sun Sep 7 + time`, which rendered on two lines) is gone. Configs that still say `date-day-time` are migrated to `date-day` instead of being reset.
- The iPhone app and its widgets use the same wording, and the sync payload now carries `dateFormat` as well, so both screens read the same. (Phones running an older build simply keep the `Sep 7, 3:59 PM` form.)

## 0.2.0 - 2026-09-06

The "everywhere" release: macOS build, iPhone companion widget, public source on GitHub with CI-built installers.

### Added

- **macOS support.** The same widget runs on macOS 12+ (universal DMG for Apple Silicon and Intel). Smoky/Clear Acrylic map to NSVisualEffectView vibrancy (`under-window`, kept active while unfocused; Mica is Windows-only and shows as Smoky). Tray stats become a single **menu-bar item** with the percentages as text (`91% · 42%`, `✕` at 99%+). "Hide from taskbar" hides the Dock icon. Always-on-top windows are shown on every Space and above full-screen apps. Unsigned builds are ad-hoc signed by `build/after-pack.js` so they launch on Apple Silicon after the one-time Gatekeeper step (README → *Installing on macOS*).
- **Phone sync** (Settings → Phone): the desktop pushes an AES-256-GCM-encrypted copy of every snapshot (plus a downsampled 7-day history) to a relay you host; the key is derived from a pairing secret shown as a QR code and never leaves your devices. Pushes at most once a minute, otherwise every 5 minutes or when a percentage/reset changes; exponential back-off on failure; status line and Test / Show pairing code / Re-pair / Unpair controls. Protocol in `docs/PHONE-SYNC.md`; settings `phoneSyncEnabled`, `phoneRelayUrl`; the pairing key is stored `safeStorage`-encrypted as `phonePairKey`.
- **Relay** (`relay/`): a dependency-free Cloudflare Worker + KV implementation of the protocol (`PUT/GET/DELETE /v1/slots/{id}`, `GET /v1/health`), first-write-claims slots, constant-time token checks, 256 KB cap, 7-day TTL. Deploy with `wrangler deploy`; runs on the free tier for personal use.
- **iPhone companion app** (`ios/`, SwiftUI, iOS 17+): pairs by QR or pasted string, decrypts with CryptoKit, mirrors the desktop rows (plan chip, status, bars, resets, extra usage, credits, 7-day Swift Charts view), and ships **home-screen widgets** (small / medium / large) and **lock-screen widgets** (rectangular, inline, circular) that refresh on a 15-minute timeline with an offline cache. XcodeGen project; compiled for the Simulator on every CI run. Not on the App Store yet - build it with Xcode.
- **GitHub repository, CI and releases.** Source published at github.com/Aidanfl/ai-usage-widget under MIT with the original author's licence preserved (`LICENSE`, `LICENSE-claude-usage-widget`, README → Credits). `ci.yml` runs the unit tests on Windows/macOS/Linux and compiles the iOS app; `release.yml` builds the Windows installer + portable exe and the macOS DMG on a `v*` tag and publishes a GitHub Release with these notes.
- `npm run build:mac`; `homepage`/`repository` metadata; `.gitattributes` (LF everywhere).

### Changed

- `acrylicSupported()` is now platform-aware (Windows 11 22H2+ *or* macOS); `resolveBackground()` takes the platform and folds Mica into Smoky on macOS; `createTray()` takes a `platform` and `window.js` deps accept `platform` for tests.
- The renderer relabels the Background buttons on macOS (Smoky Glass / Clear Glass, Mica hidden) and the Windows-only hints stay on Windows.
- Unit tests pin `platform: 'win32'` where they assert Windows behaviour so the suite passes on macOS and Linux runners.

## 0.1.1 - 2026-09-06

### Changed

- **Acrylic is now "Smoky Acrylic" and a little more see-through.** The panel tint drops from `rgba(24,22,40,0.46)` to `rgba(24,22,40,0.30)` and the title band from `rgba(0,0,0,0.22)` to `rgba(0,0,0,0.14)`; cards, wells and text shadow are unchanged. The window is now created under the dark DWM theme, so the glass base stays dark grey even when Windows itself is in light mode (Windows fixes the blur strength - the base colour and our tint are the only knobs). The stored value stays `background: 'acrylic'`, so existing configs keep working. Mica keeps its previous tint.
- **Settings layout:** Theme and Background each have a full-width row (the four background buttons no longer fit a half column); Providers moved up next to Compact mode.

### Added

- **Clear Acrylic** background (`background: 'acrylic_clear'`): the same acrylic material created under the light DWM theme, which gives Windows' bright, milky, clearly see-through glass, with **no tint at all** (title band `rgba(255,255,255,0.10)`, cards `rgba(255,255,255,0.22)` with a `rgba(0,0,0,0.06)` border, wells `rgba(0,0,0,0.05)`). White text is unreadable on that base, so Clear Acrylic always uses the dark-text (light) palette whatever the Theme setting says; Settings shows "Clear Acrylic uses dark text" under the Background buttons. Bars and rings keep their series colours. Needs Windows 11 22H2+ like the other materials.
- Preview harness state `clear` (`preview.html#clear`) renders the Clear Acrylic tint; `get-app-info` now distinguishes `acrylic_clear` from `acrylic`.

## 0.1.0 - 2026-09-06

First release. A Windows-first successor to SlavomirDurej's `claude-usage-widget` 1.7.6 (MIT), rebuilt around two providers.

### Added

- **Codex provider** alongside Claude: reads `~/.codex/auth.json` (honours `CODEX_HOME`) and polls `chatgpt.com/backend-api/wham/usage`. Rows are labelled by window length (5-Hour, Daily, Weekly, Monthly, Annual, or "N-Hour"), never invented; Code Review and per-feature "additional" limits appear when reported. Credits, "limit reached" and per-model availability in the details panel.
- **Claude provider via Claude Code credentials** (`~/.claude/.credentials.json`, honours `CLAUDE_CONFIG_DIR`) hitting `api.anthropic.com/api/oauth/usage`, with `/profile` (hourly) and `/organizations/<org>/prepaid/credits` (every 5 min while the details panel is open). Claude Code's own user agent, detected from `claude --version`.
- **Fable Weekly bar** and any other model-scoped weekly limit from `limits[]`, with a tooltip explaining that Fable's percent is relative to its 50% share of the weekly pool; legacy Opus/Sonnet/Cowork/OAuth Apps/Design buckets only when non-null and not already covered.
- **Claude.ai browser login** kept as an optional Claude source: `sessionKey` captured from a restricted login window, stored encrypted with `safeStorage`, usage fetched through a hidden window; org picker for multi-org accounts.
- **Careful token auto-refresh** (on by default, switchable). Both providers refresh only after the token has actually lapsed by 60 s or on a 401 - never ahead of expiry, because Claude Code and the Codex CLI refresh early themselves and their refresh tokens are single-use. Shared guards: the file still holds the refresh token that was loaded, the file was not written in the last 30 s, and at most one attempt per 10 min per process. Claude additionally checks the refresh token's own expiry and takes Claude Code's `.oauth_refresh.lock`, then writes back compact JSON via `<file>.tmp.<8hex>` + rename with an in-place fallback on Windows sharing errors; `invalid_grant` parks it for 24 h or until the file changes. Codex writes `auth.json` back atomically keeping its indentation; permanent failures park it for 30 min or until the file changes.
- **Polling etiquette:** Claude usage is fetched at most once per 60 s and Codex at most once per 30 s regardless of the refresh interval; 429s honour `Retry-After` (Claude) or back off 5/10/20/30 min and skip the next automatic cycle; last-good values are shown as "stale" instead of blanking the card.
- **Windows 11 backdrops:** Acrylic (default), Mica, or Solid, with a size-compensation helper for Electron's frameless-material sizing quirk. Auto-falls back to Solid before build 22621.
- **7-day history graph** (Chart.js, stepped lines, dashed danger line, legend toggles) stored in a separate `usage-history.json` with 8-day / 10,000-sample retention. Stale and error cycles add no samples.
- **Compact mode** (290 px), dark / light / system themes, 12h/24h and three date formats, adjustable warn/danger thresholds.
- **Tray badges** (Claude, Codex, or both) with the original bitmap-font percentages, threshold recolouring and the red X at 99%+; tooltips with reset times; Show / Refresh / Exit menu.
- **Desktop notifications** for warn, danger, blocked and "available again", once per reset cycle, silent on the first check after launch.
- **Hardened renderer:** strict CSP, context isolation, sandbox, no `ipcRenderer` exposure, external links limited to claude.ai, anthropic.com, chatgpt.com, openai.com and github.com.
- **Unit tests** (`npm test`) for normalisation, token refresh and locking, alerts, history, formatting and the scheduler; pure modules only, no Electron needed.
- **Builds:** `npm run build:portable` -> `dist/AI-Usage-Widget-0.1.0-win-portable.exe`; `npm run build` -> NSIS installer plus the portable exe.

### Known limitations

- Windows only in practice; Acrylic/Mica need Windows 11 22H2+.
- "Launch at startup" is unavailable in the portable build (use `shell:startup`) and inert when running from source.
- `npm test` needs Node 21+ for its glob pattern; the app itself runs on Node 18+.
