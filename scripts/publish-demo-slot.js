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

// Seven days of plausible history. Session windows saw-tooth on their own reset cadence; weekly
// windows climb steadily towards where the cards say they are now. Kept smooth on purpose - a noisy
// synthetic series reads as a rendering bug rather than as usage.
//
// The Fable weekly window is deliberately absent from the chart: the app derives its own legend label
// from the series key and has no name for that one, so it renders as "Claude 7d (claude.weekly_fable)".
// It still appears in the cards above the chart, where it is labelled properly.
const series = [
  { key: 'claude.session', label: 'Claude · Current Session', color: 'purple' },
  { key: 'claude.weekly', label: 'Claude · Weekly Limit', color: 'blue' },
  { key: 'codex.primary', label: 'Codex · 5-Hour Limit', color: 'teal' },
  { key: 'codex.secondary', label: 'Codex · Weekly Limit', color: 'green' },
];
const samples = [];
const TOTAL_H = 7 * 24;
// Deterministic per-day variation, so the chart is not identical every day but is stable between runs.
const dayFactor = (day) => 0.55 + 0.45 * Math.abs(Math.sin(day * 2.399963));
// Session windows: active during waking hours only, climbing through each ~5h window and dropping at
// its reset, idle overnight. A round-the-clock saw-tooth reads as a rendering artefact, not as usage.
const sessionAt = (hoursFromStart, peak, phase) => {
  const hourOfDay = (hoursFromStart + 8) % 24;                 // series starts at 08:00
  if (hourOfDay < 8.5 || hourOfDay > 23) return 0;
  const day = Math.floor(hoursFromStart / 24);
  const through = (((hoursFromStart + phase) % 5) / 5);
  return Math.round(peak * dayFactor(day + phase) * Math.pow(through, 0.8) * 10) / 10;
};
// Weekly windows: a steady climb to the figure the cards show now.
const weeklyAt = (hoursFromStart, nowPct) =>
  Math.round(nowPct * Math.pow(hoursFromStart / TOTAL_H, 1.15) * 10) / 10;

for (let i = TOTAL_H * 2; i >= 0; i--) {            // every 30 min for 7 days
  const hoursFromStart = TOTAL_H - i / 2;
  samples.push({
    t: now - i * 30 * 60e3,
    v: {
      'claude.session': sessionAt(hoursFromStart, 66, 0),
      'claude.weekly': weeklyAt(hoursFromStart, 61.5),
      'codex.primary': sessionAt(hoursFromStart, 41, 2.5),
      'codex.secondary': weeklyAt(hoursFromStart, 47.3),
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
