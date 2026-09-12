# Privacy Policy — AI Usage Mirror (iPhone) and AI Usage Widget (desktop)

Last updated: 2026-09-12

**Short version: the app collects nothing about you, sends nothing to us, and there is no "us" to
send it to.** There are no accounts, no analytics, no advertising, no third-party SDKs and no
tracking of any kind. Nobody but you can read your usage figures.

## What the app handles

The iPhone app shows how much of your Claude and Codex usage allowance is left. It does not talk to
Anthropic or OpenAI itself and it never sees your credentials for either service. Everything it
displays is a copy of what the desktop widget already computed on your own computer:

- **Usage figures** — percentages, reset times, plan name, credit balance and a seven-day history of
  the same numbers.
- **A pairing key** — a random secret created when you pair a phone to a desktop.
- **Camera frames**, only while the QR scanner is open, and only to read the pairing code. Frames are
  processed in memory, never written to disk and never transmitted.

The app requests no contacts, location, photos, health, microphone or advertising identifiers, and it
has no ability to read any other app's data.

## Where it goes

The desktop widget encrypts each snapshot with AES-256-GCM using a key derived from the pairing
secret, then stores the ciphertext in a numbered slot on a relay server. The phone fetches that slot
and decrypts it locally.

**The key never leaves your two paired devices.** It is not in the payload, it is not sent to the
relay, and it is not recoverable from anything the relay holds. The relay therefore only ever holds
an opaque blob: it cannot read your usage figures, and neither can anyone who obtains its contents.

On the phone, the pairing key is kept in the iOS Keychain. The last decrypted snapshot is cached in
the app's own container so the widget can still draw something when the network is unavailable.
Deleting the app removes both.

## The relay

The relay is a small open-source Cloudflare Worker (`relay/` in the source repository). It stores one
encrypted record per paired phone, keyed by a random slot id, and deletes each record automatically
seven days after its last write. It logs no IP addresses, sets no cookies and keeps no history.

**You can host your own.** The relay URL is a setting in the desktop widget; point it at your own
deployment and no third party is involved at all. The default deployment is operated by the developer
purely as a convenience and holds nothing readable.

## Unpairing and deletion

Choosing **Unpair** on either device deletes the slot from the relay and discards the key. Deleting
the iPhone app removes the key and the cached snapshot from your phone. Because no account exists and
nothing is associated with your identity, there is nothing further to request deletion of.

## Children

The app is not directed at children and collects no personal information from anyone.

## Changes

Any change to this policy will be committed to the public source repository, so the full history of
what it has ever said is visible at
<https://github.com/Aidanfl/ai-usage-widget/commits/main/docs/PRIVACY.md>.

## Contact

Open an issue at <https://github.com/Aidanfl/ai-usage-widget/issues>.
