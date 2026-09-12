# Phone sync protocol (v1)

How the desktop widget gets its numbers onto a phone (the iOS app + home-screen widget in `ios/`).

## Why a relay, not a standalone phone app

The desktop widget reads the OAuth tokens that Claude Code and the Codex CLI already keep on disk and
polls two undocumented usage endpoints with them. A phone has neither file. Re-implementing the login
flows on the phone would mean shipping an App Store app that signs in to Anthropic/OpenAI with another
product's OAuth client — against both providers' terms, a known reason for account enforcement, and a
guideline 5.2.2 rejection risk at Apple review. So the phone never holds any provider credential:

```
 desktop widget ──(encrypted snapshot, every few minutes)──▶  relay (Cloudflare Worker + KV)
                                                                     │
 iPhone app / widget ◀──(fetch + decrypt, on its refresh schedule)───┘
```

The relay only ever stores ciphertext. The key never leaves the two devices (it travels in the pairing
QR code). Anyone can host a relay — the reference implementation is `relay/` (one `wrangler deploy`).

## Pairing secret and derived values

The desktop generates `K` = 32 random bytes once ("pair key"). Everything else is derived from it with
SHA-256 over `ASCII(label) || K`:

| value | derivation | use |
|---|---|---|
| `slotId` | `hex(SHA256("aiusage-slot" ‖ K))[0:32]` | URL path segment (32 hex chars) |
| `writeToken` | `hex(SHA256("aiusage-write" ‖ K))` | `Authorization: Bearer` on PUT/DELETE (64 hex) |
| `readToken` | `hex(SHA256("aiusage-read" ‖ K))` | `Authorization: Bearer` on GET (64 hex) |
| `encKey` | `SHA256("aiusage-enc" ‖ K)` (32 raw bytes) | AES-256-GCM key |

The relay learns `slotId`, `writeToken`, `readToken` and ciphertext — never `K` or `encKey`.

### Pairing string / QR payload

```
aiusage://pair?v=1&r=<percent-encoded relay base URL>&k=<base64url(K), no padding>
```

Example: `aiusage://pair?v=1&r=https%3A%2F%2Faiusage-relay.example.workers.dev&k=Qm9...` (43 chars of key).
Rules: `v` must be `1`; `r` must be an `https:` URL (plain `http://` is allowed only for `localhost` /
`127.0.0.1`), trailing slash stripped; `k` must decode to exactly 32 bytes. Reject anything else.
The iOS app registers the `aiusage` URL scheme, so the same string works as a tappable link.

## Encryption

Plaintext = UTF-8 JSON of a `PhonePayload` (below). AES-256-GCM with `encKey`, a fresh random 12-byte
IV per message, 16-byte tag, and **AAD = ASCII bytes of `slotId`** (binds a blob to its slot).

Wire envelope (what is stored on and served by the relay):

```json
{ "v": 1, "iv": "<base64 std, 12 bytes>", "ct": "<base64 std, ciphertext || 16-byte tag>", "ts": 1788700000000 }
```

`ts` is the desktop's ms-epoch push time (plaintext; lets the phone show "updated 3 min ago" without
decrypting, and lets the relay reject garbage). Node: `crypto.subtle.encrypt({ name: 'AES-GCM', iv,
additionalData }, key, plaintext)` returns exactly `ciphertext || tag`. Swift/CryptoKit:
`AES.GCM.SealedBox(nonce: try AES.GCM.Nonce(data: iv), ciphertext: ct.dropLast(16), tag: ct.suffix(16))`
then `AES.GCM.open(box, using: SymmetricKey(data: encKey), authenticating: Data(slotId.utf8))`.

## Relay HTTP API

Base URL `R` (e.g. `https://aiusage-relay.<account>.workers.dev`). All responses carry `Cache-Control: no-store`.

| method | path | auth | body | responses |
|---|---|---|---|---|
| `GET` | `R/v1/health` | none | — | `200 {"ok":true,"v":1}` |
| `PUT` | `R/v1/slots/{slotId}` | `Authorization: Bearer <writeToken>`, plus `X-Read-Token: <readToken>` | envelope JSON, ≤ 256 KB | `204` stored · `400` bad id/body · `401` write token does not match the slot's owner · `413` too large |
| `GET` | `R/v1/slots/{slotId}` | `Authorization: Bearer <readToken>` | — | `200` envelope JSON · `401` bad token · `404` no slot (never pushed / expired) |
| `DELETE` | `R/v1/slots/{slotId}` | `Authorization: Bearer <writeToken>` | — | `204` (also when absent) · `401` |

Semantics:
- `slotId` must match `^[0-9a-f]{32}$`; tokens `^[0-9a-f]{64}$`. Anything else → `400`/`401`.
- **First write claims the slot.** The relay stores `wh = hex(SHA256(writeToken))` and `rh = hex(SHA256(readToken))`
  with the envelope. Later PUTs must present a writeToken hashing to `wh`; a matching PUT also updates `rh` from
  `X-Read-Token` (so both tokens always come from the current key). GETs must present a readToken hashing to `rh`.
  Token comparison is constant-time.
- Storage record (KV key = slotId): `{ "wh": "...", "rh": "...", "env": <envelope>, "updatedAt": ms }` with
  `expirationTtl` 7 days, refreshed on every write. An expired slot can be claimed again (re-pairing makes a new K anyway).
- Envelope validation on PUT: JSON object with `v === 1`, `iv`/`ct` base64 strings (iv decodes to 12 bytes, ct ≥ 16 bytes),
  `ts` finite number. The relay never tries to decrypt.
- No CORS headers (native clients only). Method not allowed → `405`. Unknown path → `404`.

## PhonePayload (plaintext)

```js
PhonePayload = {
  v: 1,
  generatedAt: 1788700000000,           // ms epoch when the desktop built this payload
  source: { app: 'ai-usage-widget', version: '1.0.1', platform: 'win32' | 'darwin' | 'linux', host: 'AIDAN-PC' },
  snapshot: Snapshot,                   // ARCHITECTURE.md §3, with every ProviderSnapshot.raw REMOVED (debug-only, may
                                        // carry identifiers). All other fields as-is (status, error, plan, account, windows,
                                        // extra, credits, updatedAt).
  settings: { warnThreshold: 75, dangerThreshold: 90, timeFormat: '12h' | '24h',     // so the phone colours bars
              dateFormat: 'date' | 'date-day' },                                      // and words "resets at" the same way
  history: {                            // downsampled 7-day history for the chart; may be { days: 7, samples: [], series: [] }
    days: 7,
    samples: [ { t: 1788600000000, v: { 'claude.session': 42, 'claude.weekly': 12, 'codex.primary': 3 } } ],
    series:  [ { key: 'claude.session', label: 'Claude · Current Session', color: 'purple' } ],
  },
}
```

History downsampling (desktop side): bucket samples into 30-minute buckets, keep the **last** sample of each
bucket, cap at 400 samples (oldest dropped). Typical payload ≈ 25–35 KB before encryption.

## Desktop behaviour (`src/main/sync.js`)

Settings (store.js): `phoneSyncEnabled` (bool, default `false`), `phoneRelayUrl` (string, default `''`,
validated like `r` above). The pair key is NOT a setting: it lives in electron-store under the top-level key
`phonePairKey` as base64 of `safeStorage.encryptString(base64(K))` (same pattern as the claude.ai session);
without safeStorage it stays in memory for the run and the UI says so.

Push policy, evaluated after every scheduler snapshot (`onSnapshot`) when enabled, relay set and key present:
- push when ≥ 5 min since the last successful push, **or** when any provider's `status`, any window's `percent`
  or `extra.percent` (both rounded to integers) or any window's `resetsAt` changed since the last push — but never
  within 60 s of the previous attempt (floor);
- push immediately after pairing/re-pairing (first fill), after a relay URL change, and on "Push now" — all
  subject to the 60 s floor. These forced pushes ignore a running backoff (they are the user's explicit retry);
  a failed forced push falls back to the normal path below;
- on failure log once and back off 1 → 2 → 4 → … → 30 min (exponential, capped); success resets the backoff;
  a retry happens on the first scheduler snapshot after the backoff elapsed;
- 15 s timeout per request; never log the key, tokens, or payload.

IPC additions (`window.api`, ARCHITECTURE.md §8):

```
invoke  phone-sync-status   → { enabled, relayUrl, paired, keyPersisted, lastPushAt, lastError, nextRetryAt, slotId }
invoke  phone-sync-pairing  → { pairString, qrDataUrl, slotId, error }   // creates K when absent (never rotates an existing one);
                                                                         // error is null on success; without a relay URL
                                                                         // pairString/qrDataUrl are null and error says so
invoke  phone-sync-repair   → same shape, with a NEW K (old slot deleted best-effort)
invoke  phone-sync-unpair   → true                                    // DELETE slot best-effort, forget K, disable
invoke  phone-sync-test     → { ok, status?, latencyMs?, error? }     // GET /v1/health on the (given or saved) relay URL
invoke  phone-sync-push-now → { ok, error? }
on      phone-sync-updated (status)                                   // same shape as phone-sync-status
```

Settings UI: a **Phone** section (toggle "Sync to phone" with the status line next to it — "Not paired" /
"Waiting for first push" / "Last pushed 2m ago" / "Failed: <reason>, retrying at hh:mm", plus "key kept for this
session only" when safeStorage is unavailable; relay URL field + "Test" with an inline result; "Show pairing code"
→ QR + the pairing string in a readonly field + Copy; "Re-pair"; "Unpair" with an inline confirmation (no modal);
"Push now"). The QR is rendered in the main process with the `qrcode` package (`toDataURL`, margin 1, 220 px) and
shown as a data URL (the renderer CSP already allows `img-src data:`). The pairing panel is hidden again whenever
the settings view closes (the code carries the key).

## iOS app behaviour (`ios/`)

- Pair by scanning the QR or pasting the string (also via the `aiusage://pair` URL scheme). Store relay URL and `K`
  in the Keychain (access group = the App Group id so the widget extension can read them); cache the last
  decrypted payload as JSON in the App Group container so the widget has something to draw when offline.
- Fetch: `GET R/v1/slots/{slotId}` → decrypt → decode `PhonePayload`. Show `generatedAt` age as freshness
  (green < 10 min, amber < 60 min, red otherwise, matching the desktop's dots). 404 → "Desktop hasn't pushed yet".
- Widget timeline: fetch with a 10 s timeout (fall back to cache), one entry, `.after(now + 15 min)`.
- Colours: percent ≥ `settings.dangerThreshold` → red, ≥ `warnThreshold` → amber, else the row's series colour token
  (purple/blue/fuchsia/green/teal/amber/rose/slate → the same hues as `src/renderer/styles.css`).
