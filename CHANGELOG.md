# Changelog

All notable changes to AI Usage Widget. Dates are ISO (YYYY-MM-DD).

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
