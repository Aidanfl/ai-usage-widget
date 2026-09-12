#!/usr/bin/env node
//
// Publishes a self-contained demo snapshot to a relay slot, so the iPhone app can be paired and
// fully exercised without a desktop pushing to it. Written for App Review: the reviewer pastes the
// pairing string this prints and gets a populated dashboard and working widgets.
//
// The data below is fabricated. Nothing here reads a real account.
//
// The pair key is NOT in this file and must never be committed - anyone holding it can also
// overwrite the slot. It is read from AIUSAGE_DEMO_KEY (base64url, 32 bytes) or from
// ~/.config/ai-usage-widget/demo-pair-key, and generated on first run if neither exists.
//
//   node scripts/publish-demo-slot.js https://your-relay.workers.dev
//
// Re-run to refresh: the relay expires a slot seven days after its last write, and the app grades
// freshness from generatedAt (green under 10 minutes), so a daily run keeps the demo looking live.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  deriveSlot, buildPairString, encryptPayload, buildPhonePayload, validateRelayUrl, base64url, fromBase64url,
} = require('../src/main/sync.js');

const KEY_PATH = path.join(os.homedir(), '.config', 'ai-usage-widget', 'demo-pair-key');

function loadOrCreateKey() {
  if (process.env.AIUSAGE_DEMO_KEY) return fromBase64url(process.env.AIUSAGE_DEMO_KEY.trim());
  if (fs.existsSync(KEY_PATH)) return fromBase64url(fs.readFileSync(KEY_PATH, 'utf8').trim());
  const k = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
  fs.writeFileSync(KEY_PATH, base64url(k), { mode: 0o600 });
  console.error(`Generated a new demo pair key at ${KEY_PATH} (mode 600). Keep it; it is what makes\n` +
                `the pairing string stable across refreshes.`);
  return k;
}

const now = Date.now();
const inHours = (h) => new Date(now + h * 3600e3).toISOString();
const win = (key, label, kind, percent, resetsAt, color, extra = {}) => ({
  key, label, kind, percent, resetsAt, windowSeconds: null,
  severity: null, isActive: null, color, scope: null, note: null, ...extra,
});

const snapshot = {
  fetchedAt: now,
  providers: {
    claude: {
      id: 'claude', name: 'Claude', status: 'ok', error: null, source: 'claude_code',
      plan: 'Max 20x', account: 'demo@example.com', updatedAt: now,
      windows: [
        win('session', 'Current Session', 'session', 34.2, inHours(2.4), 'purple'),
        win('weekly', 'Weekly Limit', 'weekly', 61.5, inHours(58), 'blue'),
        win('weekly_fable', 'Fable Weekly', 'weekly', 78.1, inHours(58), 'fuchsia'),
      ],
      extra: { enabled: true, label: 'Extra usage', percent: 12.0 },
      credits: { balance: 42.75, currency: 'USD' },
    },
    codex: {
      id: 'codex', name: 'Codex', status: 'ok', error: null, source: 'codex_auth_file',
      plan: 'Plus', account: 'demo@example.com', updatedAt: now,
      windows: [
        win('primary', '5-Hour Limit', 'session', 22.8, inHours(3.1), 'teal'),
        win('secondary', 'Weekly Limit', 'weekly', 47.3, inHours(94), 'green'),
      ],
      extra: null, credits: null,
    },
  },
};

// Seven days of plausible history: each series drifts upward and resets on its own cadence.
const series = [
  { key: 'claude.session', label: 'Claude · Current Session', color: 'purple' },
  { key: 'claude.weekly', label: 'Claude · Weekly Limit', color: 'blue' },
  { key: 'claude.weekly_fable', label: 'Claude · Fable Weekly', color: 'fuchsia' },
  { key: 'codex.primary', label: 'Codex · 5-Hour Limit', color: 'teal' },
  { key: 'codex.weekly', label: 'Codex · Weekly Limit', color: 'green' },
];
const samples = [];
for (let i = 7 * 24 * 2; i >= 0; i--) {            // every 30 min for 7 days
  const t = now - i * 30 * 60e3;
  const hoursAgo = i / 2;
  const saw = (periodH, peak, phase = 0) => {
    const p = ((hoursAgo + phase) % periodH) / periodH;
    return Math.round(peak * (1 - p) * (0.75 + 0.25 * Math.sin(hoursAgo)) * 10) / 10;
  };
  samples.push({
    t,
    v: {
      'claude.session': Math.max(0, saw(5, 66, 1)),
      'claude.weekly': Math.max(0, saw(168, 72)),
      'claude.weekly_fable': Math.max(0, saw(168, 88)),
      'codex.primary': Math.max(0, saw(5, 41, 3)),
      'codex.weekly': Math.max(0, saw(168, 55)),
    },
  });
}

async function main() {
  const relayArg = process.argv[2] || process.env.AIUSAGE_DEMO_RELAY;
  const relay = validateRelayUrl(relayArg || '');
  if (!relay) {
    console.error('Usage: node scripts/publish-demo-slot.js https://your-relay.workers.dev');
    process.exit(2);
  }
  const K = loadOrCreateKey();
  const { slotId, writeToken, readToken, encKey } = deriveSlot(K);

  const payload = buildPhonePayload({
    snapshot,
    history: { samples, series },
    settings: { warnThreshold: 75, dangerThreshold: 90, timeFormat: '12h', dateFormat: 'date' },
    appVersion: require('../package.json').version,
    platform: 'darwin',
    hostname: 'demo-desktop',
    now,
  });

  const envelope = encryptPayload(encKey, slotId, payload, { ts: now });

  // Round-trip locally before publishing: a payload the phone cannot decrypt or decode would look
  // to a reviewer exactly like a broken app.
  const { decryptEnvelope } = require('../src/main/sync.js');
  const back = decryptEnvelope(encKey, slotId, envelope);
  if (back.v !== 1 || !back.snapshot || !back.snapshot.providers.claude) {
    console.error('Round-trip check failed; refusing to publish.');
    process.exit(1);
  }
  const res = await fetch(`${relay}/v1/slots/${slotId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${writeToken}`,
      'X-Read-Token': readToken,
    },
    body: JSON.stringify(envelope),
  });
  if (res.status !== 204) {
    console.error(`Relay refused the write: HTTP ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log(`Published demo slot ${slotId} to ${relay}`);
  console.log(`Payload ${JSON.stringify(payload).length} bytes plaintext, ${samples.length} history samples.`);
  console.log('\nPairing string:\n');
  console.log(buildPairString(relay, K));
  console.log('\nExpires seven days after this write; re-run to refresh.');
}

main().catch((e) => { console.error(e); process.exit(1); });
