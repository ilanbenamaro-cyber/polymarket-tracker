// scripts/send-emails.js — send digest (+ alert) emails to Gist subscribers.
//
// Why this exists: invoked by the update workflow on market-open and
// market-close ticks (after scripts/snapshot.js has published the canonical
// API). It reads its inputs from docs/api/v1 — latest.json (current record)
// and history-full.json (prior-day comparison) — the one source of truth;
// the old docs/data.json + update-data.js pair was deleted in ab361c8
// (audit P1-1: this script still read the deleted file).
//
// Usage: node scripts/send-emails.js <market-open|market-close> [api-dir]
//   api-dir defaults to docs/api/v1.

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sendEmail } from '../email.js';
import { buildDigestEmail, buildAlertEmail } from '../templates.js';

const SIGNIFICANT_DELTA = 0.05;
const DEFAULT_API_DIR = 'docs/api/v1';
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
export function detectSignificantMoves(current, prior) {
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

/**
 * Map the canonical API record + full history into digest inputs.
 * Pure (exported for tests).
 *
 * `prior` is the last history entry whose date is STRICTLY BEFORE the current
 * record's date: history-full is ASCENDING with same-day replace, so today's
 * own entry is the last element and must be skipped — a naive `history[1]`
 * port of the old descending data.json convention would compare today to
 * itself (audit P1-1).
 */
export function buildDigestInputs(latest, historyFull) {
  const d = latest?.snapshot?.derived;
  if (!d || !Array.isArray(d.markets)) {
    throw new Error('latest.json malformed: snapshot.derived.markets missing');
  }
  const date = latest.snapshot.fetched_at.slice(0, 10);
  const current = { date, markets: d.markets, implied_median: d.implied_median };

  let prior = null;
  if (Array.isArray(historyFull)) {
    for (let i = historyFull.length - 1; i >= 0; i--) {
      const e = historyFull[i];
      if (e && e.date < date) {
        prior = { date: e.date, markets: e.markets, implied_median: e.implied_median };
        break;
      }
    }
  }
  return { current, prior };
}

async function main() {
  if (!process.env.GRAPH_TENANT_ID) {
    console.log('Email credentials not configured — skipping email send');
    process.exit(0);
  }

  const mode = process.argv[2];
  const apiDir = process.argv[3] || DEFAULT_API_DIR;
  if (mode !== 'market-open' && mode !== 'market-close') {
    console.error(`Invalid mode "${mode}" (expected market-open|market-close)`);
    process.exit(1);
  }

  const latest = JSON.parse(readFileSync(join(apiDir, 'latest.json'), 'utf8'));
  const historyFull = JSON.parse(
    readFileSync(join(apiDir, 'history-full.json'), 'utf8')
  );
  const { current, prior } = buildDigestInputs(latest, historyFull);
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

// Only run when executed directly — the pure helpers above are imported by
// tests, and main()'s credentials guard calls process.exit.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
