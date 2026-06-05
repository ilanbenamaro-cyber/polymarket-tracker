// scripts/snapshot.js — main entry, run by the cron and by hand.
//
// Pipeline: fetch (with provenance) → detect anomalies (stale / closed / liquidity
// drop) from prior state + history → build canonical record (isotonic-adjusted,
// band, sensitivity, confidence) → attach deterministic narrative → validate
// (schema + invariants, fail loudly) → render API → append today to history →
// bake fallback. No metric is computed outside core/.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { fetchLiveSnapshot, countClosed } from '../core/fetch.js';
import {
  buildSnapshotRecord, buildHistoryEntry,
  attachAnalytics, attachScenarios, attachNarrative,
} from '../core/snapshot.js';
import { validateRecord, validateHistoryEntry } from '../core/validate.js';
import {
  writeLatest, writeMethodology, archiveSnapshot, writeHistory, readHistoryFull,
} from '../renderers/api.js';
import { bakeFallback } from '../renderers/dashboard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_DIR = join(__dirname, '../docs/api/v1');
const METHODOLOGY = JSON.parse(readFileSync(join(__dirname, '../core/methodology.json'), 'utf8'));
const ASSUMPTIONS = JSON.parse(readFileSync(join(__dirname, '../core/assumptions.json'), 'utf8'));
const HISTORY_CAP = 730;
const LIQUIDITY_DROP_FRACTION = 0.4; // >40% below 7-day median total volume
const MIN_LIVE_DAYS_FOR_DROP = 3;

const dateMinus = (s, n) => {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const entryOnOrBefore = (h, target) => {
  let r = null;
  for (const e of h) { if (e.date <= target) r = e; else break; }
  return r;
};
const entryTotalVolume = (e) => e.markets.reduce((s, m) => s + (m.volume ?? 0), 0);

/** raw_sha256 of the previously published latest.json, or null. */
function priorHash() {
  const p = join(API_DIR, 'latest.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')).snapshot.source.raw_sha256; } catch { return null; }
}

/** liquidity_drop vs the trailing-7d median total volume (guarded until enough live days). */
function liquidityDrop(history, today, currentTotal) {
  const window = history
    .filter((e) => e.date < today && e.date >= dateMinus(today, 7))
    .map(entryTotalVolume)
    .filter((v) => v > 0);
  if (window.length < MIN_LIVE_DAYS_FOR_DROP) return null;
  const sorted = [...window].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median <= 0) return null;
  const pct = (median - currentTotal) / median; // positive = a drop
  return { triggered: pct > LIQUIDITY_DROP_FRACTION, pct: Math.max(0, pct) };
}

async function main() {
  const live = await fetchLiveSnapshot();
  const today = live.fetched_at.slice(0, 10);
  const history = readHistoryFull();

  // ── anomalies ──
  const prevHash = priorHash();
  const currentTotal = live.markets.reduce((s, m) => s + (m.volume ?? 0), 0);
  const anomalies = {
    stale: prevHash != null && prevHash === live.raw_sha256,
    closedCount: countClosed(live.status),
    liquidityDrop: liquidityDrop(history, today, currentTotal),
  };

  // ── canonical record ──
  const record = buildSnapshotRecord(live, METHODOLOGY.version, anomalies);

  // History priors for analytics (velocity + dispersion-over-time) and narrative.
  const p1d = entryOnOrBefore(history, dateMinus(today, 1));
  const p7d = entryOnOrBefore(history, dateMinus(today, 7));
  const p30d = entryOnOrBefore(history, dateMinus(today, 30));
  const widthOf = (e) => (e && e.iqr && e.iqr.p25 != null && e.iqr.p75 != null ? e.iqr.p75 - e.iqr.p25 : null);
  const priors = {
    median_1d: p1d ? p1d.implied_median : null,
    median_7d: p7d ? p7d.implied_median : null,
    median_30d: p30d ? p30d.implied_median : null,
    iqr_width_7d: widthOf(p7d),
    iqr_width_30d: widthOf(p30d),
  };

  // Order matters: analytics first (narrative reads stored velocity/shape).
  attachAnalytics(record, { priors });
  attachScenarios(record, ASSUMPTIONS);
  attachNarrative(record, {
    prior7d: priors.median_7d,
    prior30d: priors.median_30d,
  });

  validateRecord(record); // schema + invariants + firewall; throws on any violation

  // ── render API ──
  writeLatest(record);
  writeMethodology(METHODOLOGY);
  archiveSnapshot(record);

  // ── append today to history (live raw_inputs → real spread in confidence) ──
  const entry = buildHistoryEntry(today, live.markets, live.raw_inputs);
  validateHistoryEntry(entry);
  if (history.length > 0 && history[history.length - 1].date === today) {
    history[history.length - 1] = entry;
  } else {
    history.push(entry);
  }
  writeHistory(history.slice(-HISTORY_CAP));

  bakeFallback(record);

  const d = record.snapshot.derived;
  console.log(
    `✓ snapshot ${today}: median $${d.implied_median?.toFixed(2)}T ` +
      `[$${d.median?.low?.toFixed(2)}–$${d.median?.high?.toFixed(2)}T], ` +
      `conf ${d.confidence.tier} (${d.confidence.score}), ` +
      `adj ${d.adjustment.monotonicity_violations} (max ${(d.adjustment.max_adjustment * 100).toFixed(1)}%), ` +
      `${history.length} days`
  );
}

main().catch((err) => {
  console.error('snapshot failed:', err.message);
  process.exit(1);
});
