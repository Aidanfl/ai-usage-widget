# AI Usage — iOS companion app + widget

A native iPhone app and home-/lock-screen widget that mirror the desktop **AI Usage** widget: Claude and Codex
usage limits (per-window bars with the same colours, thresholds and "resets in / resets at" wording), the
Extra Usage / Credits details and the 7-day history chart.

The phone **never holds a provider credential**. The desktop widget already reads the Claude Code and Codex
CLI tokens from disk; it encrypts a small snapshot and pushes it to a relay you host, and this app downloads
and decrypts it. Re-implementing the provider logins on a phone would breach both providers' terms and is
a guideline 5.2.2 rejection risk at App Review. Protocol, key derivation, envelope format and relay API:
[`docs/PHONE-SYNC.md`](../docs/PHONE-SYNC.md) (binding).

```
desktop widget ──(AES-256-GCM snapshot, every few minutes)──▶ relay (Cloudflare Worker + KV; ciphertext only)
                                                                    │
iPhone app / widget ◀───────(GET + decrypt, on its own schedule)────┘
```

## What's in here

```
ios/
  project.yml                 XcodeGen spec (the .xcodeproj is generated, never committed)
  Shared/                     compiled into BOTH targets
    Models.swift              PhonePayload / Snapshot / ProviderSnapshot / UsageWindow / ExtraUsage / CodexCredits / History
    Pairing.swift             aiusage://pair parsing + SHA-256 derivations + Keychain (shared access group)
    Crypto.swift              envelope → AES-GCM open (AAD = slotId)
    RelayClient.swift         GET /v1/slots/{slotId} (Bearer readToken, 10 s timeout, typed errors)
    Cache.swift               App Group container  Library/Caches/last-payload.json
    UsageStore.swift          @MainActor ObservableObject used by the app
    Formatting.swift          Swift port of src/renderer/format.js ("43m", "1d 8h", "Not started", 12h/24h…)
    Theme.swift               colour tokens from src/renderer/styles.css (purple/blue/fuchsia/green/teal/amber/rose/slate)
    Components.swift          GradientBar, StatusDot, Chip, ProviderMark, ElapsedRing
  AIUsage/                    the app (SwiftUI lifecycle)
    AIUsageApp.swift          @main, .onOpenURL → pair
    DashboardView.swift       provider cards, rows, expand well, footer, pull-to-refresh
    HistoryChartView.swift    Swift Charts, one line per series, dashed danger rule
    PairView.swift            AVFoundation QR scanner + paste field
    SettingsView.swift        relay/slot, Refresh now, Unpair, About/attribution
    Assets.xcassets           AppIcon (single 1024×1024), AccentColor
    AIUsage.entitlements      App Group  group.com.aidanfl.aiusage
  AIUsageWidget/              WidgetKit extension
    AIUsageWidgetBundle.swift
    UsageWidget.swift         TimelineProvider: relay (10 s) → cache → placeholder; entries every 15 min
    WidgetViews.swift         systemSmall / systemMedium / systemLarge / accessoryRectangular / accessoryInline / accessoryCircular
    SampleData.swift          gallery placeholder payload
    AIUsageWidget.entitlements  same App Group
```

Bundle ids: app `com.aidanfl.aiusage`, widget `com.aidanfl.aiusage.widget`, App Group `group.com.aidanfl.aiusage`.
**If you are not the original author you must change all three** (project.yml, both `.entitlements`,
`PairingStore.accessGroup` in `Shared/Pairing.swift`, `PayloadCache.appGroup` in `Shared/Cache.swift`) — bundle
ids and App Group ids are unique per Apple developer account.

## Requirements

- To **compile-check only**: nothing local — GitHub Actions on a `macos-latest` runner does it (see CI below).
- To **run on a phone**: a Mac with Xcode 16+, [XcodeGen](https://github.com/yonaskolb/XcodeGen)
  (`brew install xcodegen`), an iPhone on **iOS 17.0 or later**, and an Apple ID.
- The desktop widget (this repo) with **Sync to phone** enabled and a relay deployed (`relay/`, one `wrangler deploy`).

## Build

```bash
cd ios
xcodegen generate            # writes AIUsage.xcodeproj from project.yml
open AIUsage.xcodeproj
```

In Xcode:

1. Select the **AIUsage** target ▸ *Signing & Capabilities* ▸ pick your **Team**. Repeat for **AIUsageWidget**
   (or set `DEVELOPMENT_TEAM` once in `project.yml` and regenerate).
2. If Xcode complains the bundle id is taken, change the ids as described above.
3. Pick your iPhone as the run destination and press Run. The widget is embedded automatically.

CI does exactly this (no signing, simulator SDK):

```bash
cd ios && xcodegen generate && xcodebuild -project AIUsage.xcodeproj -scheme AIUsage -configuration Debug \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

Scheme name: **`AIUsage`** (shared, builds both targets). Project: **`AIUsage.xcodeproj`**.

## Capabilities checklist

Both targets need, on the Apple developer portal / in the provisioning profile:

| capability | why | where it is declared |
|---|---|---|
| **App Groups** — `group.com.aidanfl.aiusage` | shared cache file for the widget; on iOS the App Group id is also the **keychain access group** used for the pairing secret (no `$(AppIdentifierPrefix)`) | `AIUsage/AIUsage.entitlements`, `AIUsageWidget/AIUsageWidget.entitlements` |
| Keychain Sharing | *not* required as a separate capability — the App Group already acts as the access group | `kSecAttrAccessGroup = "group.com.aidanfl.aiusage"` in `Shared/Pairing.swift` |
| Camera | QR scan (`NSCameraUsageDescription` is set in `project.yml`) | app only |

With **Automatic** signing Xcode registers the App Group for you the first time you build to a device, but the
Team must be set. Notes on account types:

- A free **Personal Team** can install on your own iPhone; the build expires after **7 days** and must be
  re-run from Xcode. App Groups *are* available to personal teams.
- **TestFlight / App Store** distribution needs the paid Apple Developer Program (US$99/year).

## Pairing flow

1. Desktop widget ▸ Settings ▸ **Phone** ▸ turn on *Sync to phone*, enter your relay URL (`https://…workers.dev`),
   *Test*, then **Show pairing code**.
2. iPhone ▸ AI Usage ▸ scan the QR (or paste the `aiusage://pair?v=1&r=…&k=…` string; tapping the string as a
   link also works because the app registers the `aiusage` URL scheme).
3. The app derives `slotId` / `readToken` / `encKey` from the 32-byte key, stores relay URL + key in the Keychain
   (shared with the widget), fetches `GET R/v1/slots/{slotId}`, decrypts and shows the dashboard.
4. Add the widget: long-press the home screen ▸ **+** ▸ *AI Usage*. It refreshes every ~15 min (WidgetKit
   decides the exact cadence) and shows the cached snapshot when offline. Lock-screen families are included.

`404` from the relay means the desktop has not pushed yet (or the slot expired after 7 days without a push) —
use **Push now** on the desktop. `401` means the key changed (re-pair on the desktop → re-scan).

## App Review notes (if you ship it)

- **Companion app**: the app is useless without the desktop widget. In *App Review Information* give the
  reviewer a **demo relay URL and a pairing string** (create a throw-away pairing on a desktop that keeps
  pushing during review) and explain that the data is the reviewer's own usage snapshot pushed by that desktop.
- **Privacy nutrition label**: *Data Not Collected*. The app talks only to the relay URL the user pairs with; no
  analytics, no accounts, no identifiers leave the device.
- **Encryption export compliance**: `ITSAppUsesNonExemptEncryption = false` is set in `project.yml`. AES-GCM is
  used solely to protect the app's own data in transit/storage, which is exempt under the App Store's encryption
  export rules (category 5 part 2 exemption for data protection); no additional documentation is required.
- **Guideline 5.2.2 / third-party services**: the app does not sign in to Anthropic or OpenAI and does not
  call their APIs; say so in the notes. The desktop side reads local CLI credentials on the user's own machine.
- Not affiliated with Anthropic or OpenAI; the About screen says so, and credits the MIT-licensed
  [claude-usage-widget](https://github.com/SlavomirDurej/claude-usage-widget) by Slavomir Durej.

## Troubleshooting

| symptom | cause / fix |
|---|---|
| Pairing fails with **Keychain error -34018** (`errSecMissingEntitlement`) | The keychain access group `group.com.aidanfl.aiusage` is not in the provisioning profile: enable **App Groups** with that id on **both** targets, make sure both entitlements files list it, clean build, reinstall. In the Simulator the app falls back to the private keychain so you can still test the app (the widget then shows "Pair in the app"). |
| Widget says **Pair in the app** although the app is paired | The widget cannot read the shared keychain item — same App Group problem as above, or the widget target has a different `DEVELOPMENT_TEAM`. Settings ▸ Status shows whether the shared container is available. |
| **Desktop hasn't pushed yet** | Relay has no slot for this key: desktop ▸ Phone ▸ *Push now*; check the relay URL is the same on both sides; slots expire after 7 days without a push. |
| **Relay rejected this phone's read token** (401) | The desktop re-paired with a new key. Scan the new code. |
| **Decryption failed** | Same as 401 but the slot was claimed by another key, or the relay URL points to a different deployment. Re-pair. |
| Camera view is black in the Simulator | Expected — no camera. Use the paste field. |
| `xcodebuild` fails with *No profiles for 'com.aidanfl.aiusage'* | You are building for a device with signing on: set your Team, or change the bundle ids. CI uses `CODE_SIGNING_ALLOWED=NO` for the simulator. |
| Widget shows stale numbers | WidgetKit throttles refreshes (budget ~40–70/day). Opening the app triggers `reloadAllTimelines()` after each successful fetch; the freshness dot tells you how old the payload is (green < 10 min, amber < 60 min, red older). |

## Design notes

- Swift 5 language mode (`SWIFT_VERSION 5.0`, `SWIFT_STRICT_CONCURRENCY minimal`) on purpose — no strict
  concurrency diagnostics.
- No third-party packages. Frameworks: SwiftUI, WidgetKit, Charts, CryptoKit, Security, AVFoundation.
- All JSON decoding is lenient (optionals + `decodeIfPresent`, lossy arrays); a malformed field never brings
  down the whole payload.
- `resetsAt` is parsed with `ISO8601DateFormatter` (with and without fractional seconds); ms-epoch numbers are
  decoded as `Double`, so no global `JSONDecoder.dateDecodingStrategy` is used.
