// scripts/update-data.js — refresh docs/data.json from live Polymarket data.
//
// Why this exists: this is the per-cron-tick job in GitHub Actions. It fetches
// the live snapshot, derives the distribution metrics (median/mean/IQR via the
// shared metrics module, which reuses digest.js for the median), and upserts the
// public docs/data.json that the dashboard reads.
//
// History is one entry per UTC day, kept ASCENDING (oldest first) to match the
// backfill output. The workflow runs multiple times per weekday (snapshot /
// open / close), so we dedup by date — replace today's entry in place rather
// than appending duplicates.

import { fetchSnapshot } from '../api.js';
import {
  computeImpliedMedian,
  computeImpliedMean,
  computeIqr,
  withBucketProbs,
} from './metrics.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '../docs/data.json');

const HISTORY_CAP = 730; // ~2 years of daily entries
const MARKET_URL =
  'https://polymarket.com/event/spacex-ipo-closing-market-cap-above';
const RESOLVES = '2027-12-31';

/** Probability at an exact threshold, or null if absent. */
function probAt(markets, threshold) {
  const row = markets.find((m) => m.threshold === threshold);
  return row ? row.prob : null;
}

/** Read existing data.json, or return a fresh skeleton if missing/invalid. */
function readData() {
  try {
    return JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  } catch {
    return {
      meta: { updated_at: null, market_url: MARKET_URL, resolves: RESOLVES },
      current: null,
      history: [],
    };
  }
}

async function main() {
  const markets = await fetchSnapshot();
  if (!markets) {
    console.error('fetchSnapshot returned null — aborting');
    process.exit(1);
  }

  const today = new Date().toISOString().split('T')[0];
  const impliedMedian = computeImpliedMedian(markets);
  const impliedMean = computeImpliedMean(markets);
  const enrichedMarkets = withBucketProbs(markets); // attach bucket_prob once

  // Per-day history record (used for trend lines and Δ columns). Carries
  // bucket_prob so history matches the same schema as current.
  const historyEntry = {
    date: today,
    implied_median: impliedMedian,
    implied_mean: impliedMean,
    prob_1_8t: probAt(markets, 1.8),
    prob_2_0t: probAt(markets, 2.0),
    prob_2_4t: probAt(markets, 2.4),
    markets: enrichedMarkets,
  };

  // Enriched snapshot for the cards / distribution view.
  const totalVolume = markets.reduce((sum, m) => sum + (m.volume ?? 0), 0);
  const current = {
    date: today,
    implied_median: impliedMedian,
    implied_mean: impliedMean,
    iqr: computeIqr(markets),
    total_volume: totalVolume,
    markets: enrichedMarkets,
  };

  const data = readData();
  data.meta = {
    ...data.meta, // preserve backfilled_at / history_start
    updated_at: new Date().toISOString(),
    market_url: MARKET_URL,
    resolves: RESOLVES,
  };
  data.current = current;

  // Dedup by date in an ascending array: replace today's entry, else append.
  const history = Array.isArray(data.history) ? data.history : [];
  if (history.length > 0 && history[history.length - 1].date === today) {
    history[history.length - 1] = historyEntry;
  } else {
    history.push(historyEntry);
  }
  data.history = history.slice(-HISTORY_CAP);

  // docs/ should already exist, but be defensive for a fresh checkout.
  mkdirSync(dirname(DATA_PATH), { recursive: true });
  writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));

  const medianLabel =
    impliedMedian == null ? 'n/a' : `$${impliedMedian.toFixed(2)}T`;
  console.log(
    `✓ data.json updated: ${markets.length} thresholds, median ${medianLabel}, ${data.history.length} history days`
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
