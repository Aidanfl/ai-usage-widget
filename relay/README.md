# aiusage-relay

A tiny Cloudflare Worker that ferries the AI Usage widget's numbers from your desktop to your phone.
The desktop encrypts a snapshot and `PUT`s it here; the iPhone app `GET`s it and decrypts it. The relay
stores **ciphertext only** — it never sees your Anthropic/OpenAI tokens, the pairing key, or the numbers.

Protocol details: [`../docs/PHONE-SYNC.md`](../docs/PHONE-SYNC.md). The worker has no dependencies
(`src/worker.js` only uses `Request`/`Response`/`URL`/`crypto.subtle`), which is also why the desktop
repo's `npm test` can run it under plain Node.

## Deploy (Cloudflare free account, ~3 minutes)

There is no "Deploy to Cloudflare" button for this repo — it is four manual commands. You need Node 18+
(the widget's dev machine has Node 24) and a free Cloudflare account. `wrangler` is used through `npx`,
so nothing is installed globally.

```powershell
cd relay
npx wrangler login                        # 1. opens the browser, authorises wrangler for your account
npx wrangler kv namespace create SLOTS    # 2. creates the KV namespace; prints  id = "…"
#    3. paste that id into wrangler.toml → [[kv_namespaces]] id = "…"   (replace the placeholder)
npx wrangler deploy                       # 4. builds nothing, uploads src/worker.js, prints the URL
```

Step 4 prints something like `https://aiusage-relay.<your-subdomain>.workers.dev`. That is your relay URL.

Check it: `curl https://aiusage-relay.<your-subdomain>.workers.dev/v1/health` → `{"ok":true,"v":1}`.

## Point the desktop at it

1. Open the widget → ⚙ Settings → **Phone**.
2. Paste the relay URL into **Relay URL** and press **Test** (should say `OK · <n> ms`).
3. Turn on **Sync to phone**, then **Show pairing code** and scan the QR (or copy the `aiusage://pair?…`
   string) with the iPhone app. The status line changes to "Last pushed just now" after the first push.

**Re-pair** generates a new key (and a new slot; the old one is deleted). **Unpair** deletes the slot,
forgets the key and turns sync off.

## Why the desktop pushes so rarely

The Workers **free tier allows 1 000 KV writes per day** (reads are 100 000/day). One write is one push,
so the desktop pushes at most once every 60 seconds and normally only every 5 minutes, or sooner when a
number actually changes (a status flip, a percent moving by a whole point, or a reset time). That is
~300 writes per day worst case, and typically well under 100. Reads are the phone's business: the widget
extension refreshes every 15 minutes, the app on open — nowhere near the read cap.

Each slot record expires 7 days after its last write, so an abandoned pairing cleans itself up.

## Privacy

- The relay stores, per slot: the SHA-256 **hashes** of the write and read tokens, the AES-GCM
  **ciphertext** envelope, and a timestamp. Nothing else.
- The pairing key `K` travels only inside the QR code / pairing string, from your desktop to your phone.
  The relay URL path (`slotId`) and the two tokens are derived from `K` by hashing, so a relay operator
  cannot recover `K`, the encryption key, or the payload.
- There are no CORS headers (native clients only), every response is `Cache-Control: no-store`, and
  requests over 256 KB are rejected.

## Local development

```powershell
npx wrangler dev          # serves http://localhost:8787 with a local KV emulation
```

The widget accepts `http://localhost:8787` (plain `http://` is allowed for localhost / 127.0.0.1 only).

## API summary

| method | path | auth | result |
|---|---|---|---|
| `GET` | `/v1/health` | — | `200 {"ok":true,"v":1}` |
| `PUT` | `/v1/slots/{slotId}` | `Authorization: Bearer <writeToken>` + `X-Read-Token: <readToken>` | `204` · `400` · `401` · `413` |
| `GET` | `/v1/slots/{slotId}` | `Authorization: Bearer <readToken>` | `200 envelope` · `401` · `404` |
| `DELETE` | `/v1/slots/{slotId}` | `Authorization: Bearer <writeToken>` | `204` · `401` |

The first `PUT` claims a slot; later writes must present the same write token. Anything else: `405` for a
wrong method, `404` for an unknown path.
