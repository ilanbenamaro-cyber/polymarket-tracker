// scripts/send-emails.js — send digest (+ alert) emails to Gist subscribers.
//
// Why this exists: invoked by the update workflow on market-open and
// market-close ticks (after update-data.js has already written today's entry
// to docs/data.json). It reads the active subscriber list from a private Gist,
// sends every subscriber the daily digest, and — if any threshold moved ≥5%
// day-over-day — a separate movement alert.
//
// Usage: node scripts/send-emails.js <market-open|market-close> <data-json-path>

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { sendEmail } from '../email.js';
import { buildDigestEmail, buildAlertEmail } from '../templates.js';

const SIGNIFICANT_DELTA = 0.05;
const GIST_API = (id) => `https://api.github.com/gists/${id}`;

/**
 * Fetch active subscriber addresses from the Gist's subscribers.json.
 * Never throws — logs a warning and returns [] so a transient Gist/API error
 * does not crash the whole workflow run.
 */
async function getSubscribers() {
  try {
    const res = await fetch(GIST_API(process.env.GIST_ID), {
      headers: {
        Authorization: `Bearer ${process.env.GIST_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      throw new Error(`Gist GET ${res.status} ${res.statusText}`);
    }
    const gist = await res.json();
    const file = gist.files?.['subscribers.json'];
    if (!file) throw new Error('subscribers.json not found in Gist');

    const parsed = JSON.parse(file.content);
    const list = Array.isArray(parsed.subscribers) ? parsed.subscribers : [];
    return list.filter((s) => s.active === true).map((s) => s.email);
  } catch (err) {
    console.warn(`[send-emails] could not load subscribers: ${err.message}`);
    return [];
  }
}

/** Thresholds whose probability moved ≥5% absolute between prior and current. */
function detectSignificantMoves(current, prior) {
  if (!prior) return [];
  const priorMap = new Map(prior.markets.map((m) => [m.threshold, m.prob]));
  const moves = [];
  for (const m of current.markets) {
    if (!priorMap.has(m.threshold)) continue;
    const before = priorMap.get(m.threshold);
    const delta = m.prob - before;
    if (Math.abs(delta) >= SIGNIFICANT_DELTA) {
      moves.push({ label: m.label, before, after: m.prob, delta });
    }
  }
  return moves;
}

async function main() {
  const mode = process.argv[2];
  const dataPath = process.argv[3];
  if (mode !== 'market-open' && mode !== 'market-close') {
    console.error(`Invalid mode "${mode}" (expected market-open|market-close)`);
    process.exit(1);
  }
  if (!dataPath) {
    console.error('Missing data-json path argument');
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(dataPath, 'utf8'));
  const current = data.current;
  if (!current) {
    console.error('data.json has no current entry — run update-data.js first');
    process.exit(1);
  }

  // update-data.js has already placed today at history[0]; the prior trading
  // day is therefore history[1] for both modes (day-over-day comparison).
  const prior = data.history?.[1] ?? null;
  const moves = detectSignificantMoves(current, prior);

  const subscribers = await getSubscribers();
  if (subscribers.length === 0) {
    console.log('No active subscribers — skipping email');
    return;
  }

  const digest = buildDigestEmail({
    mode,
    date: current.date,
    markets: current.markets,
    prior: prior ? prior.markets : null,
    impliedMedian: current.implied_median,
    priorMedian: prior ? prior.implied_median : null,
  });
  await sendEmail({
    to: subscribers,
    subject: digest.subject,
    html: digest.html,
    text: digest.text,
  });
  console.log(`✓ Digest sent to ${subscribers.length} subscriber(s)`);

  if (moves.length > 0) {
    const alert = buildAlertEmail({ date: current.date, moves });
    await sendEmail({
      to: subscribers,
      subject: alert.subject,
      html: alert.html,
      text: alert.text,
    });
    console.log(
      `✓ Alert sent (${moves.length} significant move(s)) to ${subscribers.length} subscriber(s)`
    );
  } else {
    console.log('No significant moves — no alert email');
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
