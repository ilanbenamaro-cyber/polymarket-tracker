// scripts/backfill.js — rebuild the full history from Polymarket price-history.
//
// Why this exists: seeds docs/api/v1/history*.json with the market's entire
// daily record in the new (confidence-bearing) schema. Price-history has no
// order book, so every backfilled day is "price-only" and capped at medium
// confidence (early sparse days fall to low). Idempotent: re-running rebuilds
// from source. Does NOT touch latest.json (that's snapshot.js's job).
//
// Confirmed price-history shape: { history:[{t:<unix_s>, p:<0..1>}] }, fidelity
// 1440 = one point/day. Thresholds start on different dates and have gaps; we
// forward-fill within each token's active range and omit a token before its
// first point.

import { buildHistoryEntry } from '../core/snapshot.js';
import { validateHistoryEntry } from '../core/validate.js';
import { loadMarketConfig, parseThreshold, labelGt } from '../core/market-config.js';
import { writeHistory } from '../renderers/api.js';

const CONFIG = loadMarketConfig('spacex'); // the market this entrypoint backfills
const GAMMA_URL = `https://gamma-api.polymarket.com/events?slug=${CONFIG.event_slug}`;
const HISTORY_URL = (token) =>
  `https://clob.polymarket.com/prices-history?market=${token}&interval=max&fidelity=1440`;
const REQUEST_DELAY_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toDate = (unixSeconds) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

async function fetchMarketMeta() {
  const res = await fetch(GAMMA_URL);
  if (!res.ok) throw new Error(`Gamma API ${res.status}`);
  const events = await res.json();
  return events[0].markets
    .map((m) => {
      const threshold = parseThreshold(CONFIG, m.question);
      const ids =
        typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
      return { threshold, label: labelGt(CONFIG, threshold), token_id: ids[0] };
    })
    .sort((a, b) => a.threshold - b.threshold);
}

async function fetchTokenHistory(token) {
  const res = await fetch(HISTORY_URL(token));
  if (!res.ok) throw new Error(`price-history ${res.status} for ${token}`);
  const json = await res.json();
  const byDate = new Map();
  for (const pt of json.history || []) byDate.set(toDate(pt.t), pt.p); // last wins
  const dates = [...byDate.keys()].sort();
  return { firstDate: dates[0] ?? null, lastDate: dates[dates.length - 1] ?? null, byDate };
}

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

  const tokens = [];
  let globalFirst = null;
  let globalLast = null;

  for (const m of meta) {
    const { firstDate, lastDate, byDate } = await fetchTokenHistory(m.token_id);
    if (firstDate) {
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
  if (!globalFirst) throw new Error('No price history found');

  const history = [];
  for (const date of dateRange(globalFirst, globalLast)) {
    const markets = tokens
      .filter((t) => t.byDate.has(date))
      .map((t) => ({
        label: t.label,
        threshold: t.threshold,
        prob: t.byDate.get(date),
        volume: null, // price-history is price-only
      }))
      .sort((a, b) => a.threshold - b.threshold);
    if (markets.length === 0) continue;

    // rawInputs = null → confidence flagged price-only and capped at medium.
    const entry = buildHistoryEntry(date, markets, null, CONFIG);
    validateHistoryEntry(entry);
    history.push(entry);
  }

  writeHistory(history);
  console.log(
    `✓ Backfilled ${history.length} days, ${history[0].date} → ${history[history.length - 1].date}`
  );
}

main().catch((err) => {
  console.error('backfill failed:', err.message);
  process.exit(1);
});
