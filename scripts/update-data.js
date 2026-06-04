// scripts/update-data.js — refresh docs/data.json from live Polymarket data.
//
// Why this exists: this is the per-cron-tick job in GitHub Actions. It fetches
// the live snapshot, derives the implied median (reusing the verified function
// from digest.js so there is a single source of truth), and upserts the public
// docs/data.json that the dashboard reads and the email job consumes.
//
// History is one entry per UTC day: the update workflow runs multiple times per
// weekday (snapshot / open / close), so we dedup by date — replace today's
// entry in place rather than appending duplicates — which is what the
// downstream "yesterday = history[1]" comparison relies on.

import { fetchSnapshot } from '../api.js';
import { computeImpliedMedian } from '../digest.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, '../docs/data.json');

const HISTORY_CAP = 90;
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

  const entry = {
    date: today,
    implied_median: impliedMedian,
    prob_1_8t: probAt(markets, 1.8),
    prob_2_0t: probAt(markets, 2.0),
    prob_2_4t: probAt(markets, 2.4),
    markets,
  };

  const data = readData();
  data.meta = {
    updated_at: new Date().toISOString(),
    market_url: MARKET_URL,
    resolves: RESOLVES,
  };
  data.current = entry;

  // Dedup by date: replace today's entry in place, else prepend (newest first).
  const history = Array.isArray(data.history) ? data.history : [];
  if (history.length > 0 && history[0].date === today) {
    history[0] = entry;
  } else {
    history.unshift(entry);
  }
  data.history = history.slice(0, HISTORY_CAP);

  // docs/ should already exist, but be defensive for a fresh checkout.
  mkdirSync(dirname(DATA_PATH), { recursive: true });
  writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));

  const medianLabel =
    impliedMedian == null ? 'n/a' : `$${impliedMedian.toFixed(2)}T`;
  console.log(
    `✓ data.json updated: ${markets.length} thresholds, median ${medianLabel}`
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
