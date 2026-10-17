# Brief for the Mac's Claude session: four Claude accounts on the Mac, the widget and the phone

Written 2026-10-17 19:40 by the Claude Code session on the owner's Windows PC, at his request, for the
Claude Code session on his Mac mini. He chose that the Mac's session does this work, on the Mac account's
own allowance, and that this brief reaches you through this repo. Read it all before changing anything.

## What he asked (his words, verbatim)

> I want to be able to open all 3 of my claude accounts in the terminal of my mac mini as well and have the
> same desktop shortcuts and everything. I have another session of claude code open on the mac mini using a
> different account, how can i do this? I want to redo my AI usage widget so I can see all 4 of my accounts
> usages at the same time on there and on the mac be able to have it monitor all of them and send them to my
> app the way it sends the current information to it

His choices the same evening: **one Claude window per account** on the Mac (his PC's LOUDMOUTH "lanes" stay
on the PC: they need the Unity editor and its files); **the Mac's Claude builds it**; **this brief via
GitHub**. So there are four accounts: the three he runs on the PC, plus the one your session is signed in to.

## Ground rules

- He is a game director, not a tools person. Do the work yourself; stop only for what a human must do (the
  sign-ins below, `sudo`, App Store Connect). Batch those asks into one list.
- Never print, log or commit a token, a cookie or an email address. Keychain: list item NAMES only
  (`security dump-keychain | grep -i "claude code"`); never `security find-generic-password -w` in a
  terminal you show him. This repo is PUBLIC: no account details in commits or docs.
- Commit locally as you go. Push and any App Store submission only when he says so.

## Part A: one Terminal shortcut per account (small; do it first)

On the PC each account lives in its own Claude Code config folder, chosen with `CLAUDE_CONFIG_DIR`:
`~/.claude` (his "Claude 1"), `~/.claude-blender` ("Claude 2"), `~/.claude-checker` ("Claude 3"); a desktop
`.cmd` file opens each. The PC's are tied to his game project; the Mac's should open plain Claude Code.

1. Keep your own default `~/.claude` as it is (it is the fourth account). Create three folders, e.g.
   `~/.claude-1`, `~/.claude-2`, `~/.claude-3`. If he wants the same settings everywhere, copy the default
   folder's `settings.json` into each (never `.credentials.json`, `.claude.json` or `projects/`).
2. On the Desktop make `Claude 1.command`, `Claude 2.command`, `Claude 3.command` (and `Claude 4.command`
   for the default folder, so all four match), `chmod +x` each. Each sets the window title
   (`printf '\033]0;Claude 1\007'`), `cd`s to his home (or a folder he names), and runs
   `CLAUDE_CONFIG_DIR="$HOME/.claude-1" exec claude`. Give them distinct icons if it is cheap.
3. **His part:** double-click each new shortcut once and run `/login`, signing in to the account he wants
   behind that number. Tell him first: the browser must be signed in to claude.ai as THAT account (use a
   private window, or sign out between), or every folder ends up on the same account.
4. Check: `security dump-keychain | grep -i "claude code"` should show one credentials item per folder
   (Claude Code on macOS keeps each folder's login in the login keychain, the default folder under
   `Claude Code-credentials`, other folders under a suffixed name; confirm the naming yourself and write it
   down in README.md for Part B). Two windows in the SAME folder share one login: a `/login` in one moves
   both. Tell him that in one line.

## Part B: the widget shows all four accounts, and the Mac sends all four to the phone

### What the code does today (checked at 2346c5a)

- The Claude card has ONE source, the `claudeSource` setting: `claude_code` reads
  `<CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json` (src/main/providers/claude.js), or `claude_web`, a
  claude.ai sign-in inside the widget (claude-web.js). Codex is a second card.
- **On macOS `claude_code` cannot work:** Claude Code keeps its tokens in the Keychain there, not in
  `.credentials.json`, and the widget has no Keychain reader (grep finds none). Check what his Mac widget
  uses now; it is probably `claude_web`.
- The phone: the app's dashboard draws every provider in the payload (`DashboardView.swift`, `ForEach(providers)`),
  ordered `claude`, `codex`, then other ids sorted (`Models.swift`, `providerOrder`). So extra Claude entries
  under new ids appear in the app's dashboard WITHOUT an App Store update. The home-screen widgets do not:
  they special-case `claude`/`codex` (`WidgetViews.swift`, the `claude`/`codex` getters) and draw at most 3
  providers. Showing four accounts there needs an app update through App Review.

### What to build

1. **Accounts, not one source.** A list of Claude accounts in settings (at least 4; a label such as
   "Claude 1" each), each with its own source: a Claude Code config folder, or its own claude.ai sign-in
   (its own Electron session partition, so four sign-ins never share a cookie). Keep the existing single
   setting working as account 1 (migrate it). Codex is unchanged.
2. **All at once on screen:** one card (or a compact row group) per account with its session and weekly bars
   and reset times, the account's name from `/profile` as a subtitle. Two sources that turn out to be the
   same account (same account id from `/profile`) show once.
3. **Per-account etiquette:** the 60 s floor between real `/usage` calls, the 429 back-off, the refresh
   spacing and the profile cache are module-level state today; make each per account.
4. **Token safety (binding).** Claude Code's refresh tokens are single use: if the widget refreshes a token
   that a Claude Code window also uses, one of the two is signed out. The `claude_code` provider's rules
   (refresh only after expiry + 60 s, under Claude Code's lock, re-read first) exist for this. A Keychain
   source on the Mac would have to write a refreshed token back exactly as Claude Code does, or it signs that
   folder out at the next refresh. **Recommended on the Mac: a claude.ai sign-in per account** (it never
   touches Claude Code's tokens, and keeps working when a folder sits unused for days). A read-only Keychain
   source that never refreshes is acceptable only as a secondary option and must say "waiting for Claude Code
   to refresh" when the token has expired. On the PC the folder source stays, with its existing rules.
5. **The phone payload, backwards-compatible.** Keep `providers.claude` = account 1, so the shipped app keeps
   working; add the others under new ids (e.g. `claude-2`, `claude-3`, `claude-4`) with a `name` that carries
   the label, and per-account history series (`claude-2.session`, ...). Update docs/PHONE-SYNC.md. The Mac
   widget is the one that pushes (Settings, phone sync, as today).
6. **The iPhone app (second, his word before submitting):** order `claude-*` ids with Claude's mark before
   Codex, and let the home-screen widgets show four accounts (e.g. weekly bars only in the small family).
   Build and test it; submit to App Review only when he says.
7. **Tests:** extend `tests/` (per-account providers, dedupe, per-account floors, the payload, the settings
   migration); `npm test` green. Build the Mac app (`npm run build:mac`), run it, and leave it running with
   all four accounts showing and phone sync on. Do not build the Windows copy; the PC session does that.
8. **Docs:** README.md (setting up several accounts on each OS, the Keychain naming you found), CHANGELOG.md
   (a new version, e.g. 1.1.0), ARCHITECTURE.md where the provider state changed.

## When you finish

Put one short section at the top of CHANGELOG.md's new version headed "For the PC" saying what the Windows
side needs (the settings to fill in for the folders `~/.claude`, `~/.claude-blender`, `~/.claude-checker`,
and which accounts need a claude.ai sign-in there because no PC folder holds them). Tell him in plain words
what changed, what was tested, what he must still tap or sign in to, and ask him whether to push. The PC
session pulls, builds the Windows copy and sets up the PC's accounts after he says it is pushed.
