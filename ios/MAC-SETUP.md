# Getting the iPhone app onto a phone, from a Mac

This file is written to be handed to an agent (Claude Code) running on the Mac, with the owner of the Mac
sitting nearby for the handful of steps only a human can do. Follow it in order. `ios/README.md` describes
what the app *is*; this describes how to get it running on a real phone.

**Three machines are involved.** The **desktop widget** (Windows or macOS) reads the Claude Code / Codex CLI
tokens and pushes an encrypted snapshot to a **relay** you host; the **iPhone** pulls and decrypts it. The
phone shows nothing until the relay exists and the desktop has pushed at least once, so the app can be built
and installed before any of that is ready — it will just sit on its pairing screen.

## Ground rules for the agent

- Work autonomously. Install what is missing, generate what is generated, build, install.
- Stop and ask the human only for: the Apple ID password / 2FA, anything needing `sudo`, plugging in and
  unlocking the phone, and the on-phone taps listed below. Batch those asks — don't interrupt once per step.
- **Never** run `git commit`/`push` here unless asked. `xcodegen` writes generated files; leave them uncommitted.
- Do not change the bundle identifiers. They are already in this account's namespace
  (`com.aidanfl.aiusage`), and churning IDs burns the free tier's 10-App-IDs-per-7-days quota.
- Report at the end: Xcode version, Team ID used, whether the App Group registered, the app's install status,
  and the exact list of things the human still has to tap.

## Step 0 — preflight, report before changing anything

```sh
sw_vers                                  # macOS version
xcodebuild -version 2>&1 | head -2       # Xcode version, or an error if none/CLT-only
xcode-select -p                          # should point inside Xcode.app, not CommandLineTools
which git xcodegen brew node             # what is already installed
```

**Version rule that decides everything:** the Xcode must support the iOS version *installed on the phone*
(Apple's "Device Support" column), not just this project's iOS 17 deployment target. Xcode 26.x covers iOS 15
and up; Xcode 27 covers iOS 17 and up. And the Xcode version dictates the macOS floor — roughly macOS Sequoia
15.6 for Xcode 26.0–26.3, macOS Tahoe 26.2+ for Xcode 26.4+ and 27. Check
<https://developer.apple.com/xcode/system-requirements/> against what `sw_vers` printed and what the phone
runs (Settings ▸ General ▸ About ▸ Software Version). If the Mac's macOS is too old for an Xcode that supports
the phone, say so and stop — that is a macOS upgrade decision for the human, not something to work around.

## Step 1 — toolchain

Xcode itself installs from the Mac App Store (a GUI step; `mas install 497799835` works if `mas` is set up).
Then, these need `sudo` — ask the human:

```sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
sudo xcodebuild -runFirstLaunch
```

Homebrew and XcodeGen (the `.xcodeproj` is **not** in git — it is generated from `ios/project.yml`):

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"   # if missing
eval "$(/opt/homebrew/bin/brew shellenv)"     # Apple Silicon; /usr/local/bin/brew on Intel
brew install xcodegen && xcodegen --version
```

## Step 2 — source

```sh
mkdir -p ~/src && cd ~/src
git clone https://github.com/Aidanfl/ai-usage-widget.git
cd ai-usage-widget && git checkout main && git pull
```

## Step 3 — compile-check before touching signing

This is exactly what CI runs, and it proves the toolchain independently of any Apple account:

```sh
cd ~/src/ai-usage-widget/ios
xcodegen generate
set -o pipefail
xcodebuild -project AIUsage.xcodeproj -scheme AIUsage -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build | tee /tmp/aiusage-build.log \
  | grep -E "error:|BUILD" || true
grep -q "BUILD SUCCEEDED" /tmp/aiusage-build.log && echo OK
```

If this fails, it is a code or toolchain problem — fix it here, before signing enters the picture.

## Step 4 — Apple ID and Team ID

**Human step, unavoidable:** Xcode ▸ Settings ▸ Accounts ▸ **+** ▸ Apple ID, sign in. A free account appears as
`<name> (Personal Team)`. `xcodebuild -allowProvisioningUpdates` can create profiles but cannot add an account,
and a headless Mac mini therefore needs one Screen Sharing session here.

Then bake the Team ID into `ios/project.yml` line 27 (`DEVELOPMENT_TEAM: ""`). Do it **there**, not in Xcode's
UI: `xcodegen generate` rewrites `AIUsage.xcodeproj` from scratch and discards anything set through the UI.
It sits in `settings.base`, so one edit covers both targets — which is required, since a widget signed by a
different team cannot join the app's keychain access group.

Getting the ID: it is shown in Xcode's Accounts pane next to the team. If a device build has already run, it
can also be read from a generated profile:

```sh
security cms -D -i "$(ls -t ~/Library/Developer/Xcode/UserData/Provisioning\ Profiles/*.mobileprovision | head -1)" \
  | plutil -extract TeamIdentifier.0 raw -
```

Regenerate after editing: `cd ~/src/ai-usage-widget/ios && xcodegen generate`.

## Step 5 — the phone, in this exact order

Ordering matters: **Developer Mode does not appear in iOS Settings until pairing has been started from the
Mac.** People lose a lot of time hunting for a switch that isn't there yet.

1. Connect the iPhone **by cable** and unlock it. Wireless pairing only works on iOS 27 or later; below that
   the first pairing needs the cable, no exceptions. Tap **Trust This Computer** on the phone.
2. Xcode ▸ Window ▸ Devices and Simulators (or Open Developer Tool ▸ Device Hub) ▸ select the phone ▸ **Pair**
   if the button is offered. `xcrun devicectl list devices` should now show it; note the identifier (UDID).
3. On the phone: Settings ▸ Privacy & Security ▸ **Developer Mode** ▸ on ▸ Restart. After the restart, swipe up
   and tap **Enable**, then enter the passcode.
4. If Xcode offers a **Get** button for the phone's iOS platform support, let it download.

## Step 6 — first device build (this is where App Groups is proved)

The app stores its pairing key in the Keychain under the access group `group.com.aidanfl.aiusage`, and shares a
cache file through the same App Group container. **If the App Group does not provision, the app cannot pair at
all on a real device** (the Simulator-only fallback in `Shared/Pairing.swift` is compiled out on hardware), and
the widget stays on "Pair in the app". So prove it first, before anything else is set up.

Apple's own capability table lists **App Groups as available to free accounts** (it is checked in the
no-cost "Apple Developer" column, alongside Keychain Sharing) — see
<https://developer.apple.com/help/account/reference/supported-capabilities-ios/>. Widely repeated advice says
otherwise, so treat the first build as the test. Free accounts cannot open Certificates, Identifiers &
Profiles at all, so the group can only be registered by Xcode's automatic signing.

GUI path, recommended for the first one:

```sh
open ~/src/ai-usage-widget/ios/AIUsage.xcodeproj
```

In Xcode, check both targets (**AIUsage** and **AIUsageWidget**) under Signing & Capabilities: the team is set,
"Automatically manage signing" is on, and **App Groups** shows `group.com.aidanfl.aiusage` ticked on *both*.
Select the iPhone as the run destination and press Run.

Headless / CLI path, once the account exists in Xcode:

```sh
cd ~/src/ai-usage-widget/ios
xcrun devicectl list devices
xcodebuild -project AIUsage.xcodeproj -scheme AIUsage -configuration Debug \
  -destination 'id=<IPHONE-UDID>' -derivedDataPath ./DerivedData -allowProvisioningUpdates build
xcrun devicectl device install app --device <IPHONE-UDID> \
  ./DerivedData/Build/Products/Debug-iphoneos/AIUsage.app
```

**If signing fails on the App Group** ("provisioning profile doesn't include the
com.apple.security.application-groups entitlement"): toggle the App Groups capability off and back on for both
targets to force profile regeneration, clean, rebuild. If it still refuses on a free account, report that
plainly — the options are then the paid program ($99/year) or dropping the widget and running app-only
(see *Fallbacks* below). Do not silently strip the entitlement.

## Step 7 — the human's taps, after the install

1. On the phone: Settings ▸ General ▸ **VPN & Device Management** ▸ under *Developer App* tap the
   `Apple Development: <apple id>` entry ▸ **Trust**. The app will not launch before this, and the entry only
   exists once the app is installed.
2. **Open the app once.** A widget never appears in the widget gallery until its containing app has been
   launched after install.
3. Settings screen inside the app ▸ *Shared container* should read **available**. (That reports the app's view
   only; the real widget test is adding the widget and seeing numbers.)

## Step 8 — relay and pairing

The relay can be deployed from the Mac or from the Windows desktop — whichever, it is deployed once and both
sides point at the same URL. `ios/README.md` calls it "one `wrangler deploy`"; it is actually four steps:

```sh
cd ~/src/ai-usage-widget/relay
npx wrangler login                        # opens a browser — human step
npx wrangler kv namespace create SLOTS    # prints an id
# paste that id over REPLACE_WITH_THE_ID_FROM_wrangler_kv_namespace_create in relay/wrangler.toml
npx wrangler deploy
curl https://aiusage-relay.<subdomain>.workers.dev/v1/health    # expect {"ok":true,"v":1}
```

Then, on the **desktop widget** (the Electron app, wherever it runs): Settings ▸ Phone ▸ paste the relay URL ▸
**Test** ▸ turn on **Sync to phone** ▸ **Show pairing code**. On the phone: open AI Usage, scan the QR (or
paste the `aiusage://pair?...` string). The app derives its slot and keys, fetches, decrypts, and shows the
dashboard. If it says *"Desktop hasn't pushed yet"* (a 404), press **Push now** on the desktop.

Finally: long-press the home screen ▸ **+** ▸ *AI Usage* ▸ add the size you want. Lock-screen families are
included too. WidgetKit decides the refresh cadence (roughly every 15 minutes, budget permitting).

## The 7-day cliff (read this before promising anything)

On a **free** Apple account the provisioning profile expires **7 days** from issuance. On day 8 the app stops
launching *and the home-screen widget goes dead* — there is no background renewal; the fix is to plug in, open
Xcode and rebuild, every week, forever. Free accounts also allow only 3 devices and about 10 App IDs per 7
days, and this project consumes two of them (app + widget extension).

For a widget whose entire purpose is passive glanceability, that weekly treadmill is the real cost, and it is
what the **$99/year Apple Developer Program** buys here — not the App Group, which is free-tier. Enrolment is
usually confirmed within 24 hours for an individual. Note that moving from a Personal Team to a paid team
changes the team prefix, so the stored pairing key and cache are orphaned: re-pair after switching.

## Fallbacks, if the App Group genuinely cannot be registered

- **App-only (no widget):** delete the three `#if targetEnvironment(simulator)` / `#endif` guard pairs in
  `ios/Shared/Pairing.swift` (around lines 206, 228, 264) so the private-keychain retry applies on device as
  well. The app then pairs, fetches, decrypts and renders normally; the widget stays on "Pair in the app"
  permanently, so remove it from the home screen.
- **Keychain Sharing instead of App Groups:** also a free-tier capability, and any explicit App ID already
  allowlists `$(AppIdentifierPrefix)`-prefixed groups. Switching `PairingStore.accessGroup` to such a group
  would restore app↔widget key sharing; the cache file would have to come from the relay each time instead of
  the shared container. This is a real change, not a config tweak — only do it if asked.

## Known trip-wires

| symptom | cause / fix |
|---|---|
| `xcodebuild` fails on the licence | `sudo xcodebuild -license accept`, then `sudo xcodebuild -runFirstLaunch`. |
| Team setting keeps reverting | It was set in Xcode's UI and `xcodegen generate` overwrote the project. Set `DEVELOPMENT_TEAM` in `ios/project.yml` instead. |
| Developer Mode missing from Settings | Pairing has not been started from the Mac yet. Do Step 5.2 first. |
| Keychain error **-34018** on pairing | App Group not in the profile. Both targets, same group, same team; toggle the capability and rebuild. |
| Widget says "Pair in the app" while the app is paired | The widget target cannot read the shared keychain: different team, or the group is missing from *its* profile. |
| App won't launch, no error | The developer certificate has not been trusted on the phone (Step 7.1), or the 7-day profile expired. |
| Widget vanished after a reinstall | Open the app once; widgets only re-register after a launch. |
| Phone un-paired itself | Every iOS upgrade un-pairs the device. Re-pair (cable, unless iOS 27+). |
| `git status` dirty right after building | `xcodegen` generates `AIUsage.xcodeproj` and both `Info.plist` files. Leave them uncommitted. |
| Install rejected, "doesn't include the application-groups entitlement" | Profile predates the capability. Clean build folder (⇧⌘K), delete the app from the phone, rebuild. |

## Do not

- Ship this to the App Store without reading the *App Review notes* in `ios/README.md` (companion-app rules,
  the demo relay a reviewer needs, guideline 5.2.2).
- Change the `aiusage` URL scheme — the desktop emits `aiusage://pair?…` and the widget deep-links to it.
- Point the phone at a relay the desktop is not pushing to; the error will look like a pairing failure.
