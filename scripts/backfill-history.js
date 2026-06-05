// scripts/backfill-history.js — reconstruct the full daily history array.
//
// Why this exists: the daily cron only knows "today", so docs/data.json starts
// with an empty history. This one-time (idempotent) seed rebuilds the entire
// history from Polymarket's own CLOB price-history API, giving the dashboard
// real trend/Δ data immediately. Re-running fully rebuilds from source.
//
// Confirmed price-history shape (live probe, fidelity=1440 = one point/day):
//   GET https://clob.polymarket.com/prices-history?market=<YES_TOKEN>&interval=max&fidelity=1440
//   → { "history": [ { "t": <unix_seconds>, "p": <price 0..1> }, ... ] }
// Thresholds have very different start dates (e.g. >$1T from 2025-12-12, >$4T
// from 2026-05-21) and occasional duplicate/missing days — handled below.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  computeImpliedMedian,
  computeImpliedMean,
  withBucketProbs,
} from './metrics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '../docs/data.json');

const EVENT_SLUG = 'spacex-ipo-closing-market-cap-above';
const GAMMA_URL = `https://gamma-api.polymarket.com/events?slug=${EVENT_SLUG}`;
const HISTORY_URL = (token) =>
  `https://clob.polymarket.com/prices-history?market=${token}&interval=max&fidelity=1440`;
const THRESHOLD_RE = /\$(\d+\.?\d*)/;

const REQUEST_DELAY_MS = 250; // be polite to the CLOB API between token calls

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** UTC YYYY-MM-DD for a unix-seconds timestamp. */
function toDate(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** Probability at an exact threshold within a markets array, or null. */
function probAt(markets, threshold) {
  const row = markets.find((m) => m.threshold === threshold);
  return row ? row.prob : null;
}

/** Fetch event metadata: [{ threshold, label, yesToken }] sorted ascending. */
async function fetchMarketMeta() {
  const res = await fetch(GAMMA_URL);
  if (!res.ok) throw new Error(`Gamma API ${res.status} ${res.statusText}`);
  const events = await res.json();
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('Gamma API returned no events');
  }
  return events[0].markets
    .map((m) => {
      const threshold = parseFloat(m.question.match(THRESHOLD_RE)[1]);
      const ids =
        typeof m.clobTokenIds === 'string'
          ? JSON.parse(m.clobTokenIds)
          : m.clobTokenIds;
      return { threshold, label: `>$${threshold}T`, yesToken: ids[0] };
    })
    .sort((a, b) => a.threshold - b.threshold);
}

/**
 * Per token, fetch price history and fold into a date→prob map. Duplicate
 * same-date points keep the last (close). Returns { firstDate, lastDate, byDate }.
 */
async function fetchTokenHistory(token) {
  const res = await fetch(HISTORY_URL(token));
  if (!res.ok) throw new Error(`price-history ${res.status} for ${token}`);
  const json = await res.json();
  const points = Array.isArray(json.history) ? json.history : [];

  const byDate = new Map();
  for (const pt of points) {
    byDate.set(toDate(pt.t), pt.p); // later points overwrite → last wins
  }
  const dates = [...byDate.keys()].sort();
  return {
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    byDate,
  };
}

/** All dates from firstDate..lastDate inclusive, as YYYY-MM-DD. */
function dateRange(firstDate, lastDate) {
  const out = [];
  const d = new Date(firstDate + 'T00:00:00Z');
  const end = new Date(lastDate + 'T00:00:00Z');
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function main() {
  const meta = await fetchMarketMeta();
  console.log(`Fetching price history for ${meta.length} thresholds…`);

  // threshold → { label, byDate forward-filled across its own active range }
  const tokens = [];
  let globalFirst = null;
  let globalLast = null;

  for (const m of meta) {
    const { firstDate, lastDate, byDate } = await fetchTokenHistory(m.yesToken);
    if (firstDate) {
      // Forward-fill over non-trading gaps within this token's active range.
      const filled = new Map();
      let last = null;
      for (const date of dateRange(firstDate, lastDate)) {
        if (byDate.has(date)) last = byDate.get(date);
        if (last != null) filled.set(date, last);
      }
      tokens.push({ threshold: m.threshold, label: m.label, byDate: filled });
      if (!globalFirst || firstDate < globalFirst) globalFirst = firstDate;
      if (!globalLast || lastDate > globalLast) globalLast = lastDate;
    }
    process.stdout.write(`  ${m.label}: ${byDate.size} pts\n`);
    await sleep(REQUEST_DELAY_MS);
  }

  if (!globalFirst) throw new Error('No price history found for any threshold');

  // Assemble one entry per date over the global range. A token absent before
  // its own first point is simply omitted that day (metrics use what exists).
  const history = [];
  for (const date of dateRange(globalFirst, globalLast)) {
    const base = tokens
      .filter((t) => t.byDate.has(date))
      .map((t) => ({
        label: t.label,
        threshold: t.threshold,
        prob: t.byDate.get(date),
        volume: null, // CLOB price-history is price-only
      }))
      .sort((a, b) => a.threshold - b.threshold);

    if (base.length === 0) continue;

    const markets = withBucketProbs(base);
    history.push({
      date,
      implied_median: computeImpliedMedian(markets),
      implied_mean: computeImpliedMean(markets),
      prob_1_8t: probAt(markets, 1.8),
      prob_2_0t: probAt(markets, 2.0),
      prob_2_4t: probAt(markets, 2.4),
      markets,
    });
  }

  // Preserve current + live meta; replace history wholesale.
  const data = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  data.history = history; // ascending (oldest first)
  data.meta = {
    ...data.meta,
    backfilled_at: new Date().toISOString(),
    history_start: history[0].date,
  };
  writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));

  console.log(
    `✓ Backfilled ${history.length} days, ${history[0].date} → ${
      history[history.length - 1].date
    }`
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
