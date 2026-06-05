// renderers/api.js — project the canonical core onto the public JSON API.
//
// Why this exists: the files under docs/api/v1/ ARE the product's API (served
// by GitHub Pages with permissive CORS). This renderer is the only writer of
// those files; it never computes metrics — it only reshapes the canonical
// record + history that core/ produced.

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_DIR = join(__dirname, '../docs/api/v1');
const SNAP_DIR = join(API_DIR, 'snapshots');

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

function ensureDirs() {
  mkdirSync(SNAP_DIR, { recursive: true });
}

/** Lean per-day projection used by the dashboard charts. */
function leanEntry(e) {
  return {
    date: e.date,
    implied_median: e.implied_median,
    implied_mean: e.implied_mean,
    iqr: e.iqr,
    prob_1_8t: e.prob_1_8t,
    prob_2_0t: e.prob_2_0t,
    prob_2_4t: e.prob_2_4t,
    confidence: { tier: e.confidence.tier },
  };
}

/** Flat CSV: date + scalar metrics + each threshold probability. */
function toCsv(historyFull) {
  // Column thresholds from the most recent (richest) day.
  const last = historyFull[historyFull.length - 1];
  const thresholds = last.markets.map((m) => m.threshold);
  const header = [
    'date', 'implied_median', 'implied_mean', 'iqr_p25', 'iqr_p75', 'confidence_tier',
    ...thresholds.map((t) => `>$${t}T`),
  ];
  const rows = [header.join(',')];
  for (const e of historyFull) {
    const byThreshold = new Map(e.markets.map((m) => [m.threshold, m.prob]));
    const cells = [
      e.date,
      e.implied_median ?? '',
      e.implied_mean ?? '',
      e.iqr?.p25 ?? '',
      e.iqr?.p75 ?? '',
      e.confidence.tier,
      ...thresholds.map((t) => (byThreshold.has(t) ? byThreshold.get(t) : '')),
    ];
    rows.push(cells.join(','));
  }
  return rows.join('\n') + '\n';
}

/** Write latest.json (the full canonical record). */
export function writeLatest(record) {
  ensureDirs();
  writeJson(join(API_DIR, 'latest.json'), record);
}

/** Copy the canonical methodology spec into the API surface. */
export function writeMethodology(methodology) {
  ensureDirs();
  writeJson(join(API_DIR, 'methodology.json'), methodology);
}

/** Archive the full canonical record under snapshots/YYYY-MM-DD.json. */
export function archiveSnapshot(record) {
  ensureDirs();
  const date = record.snapshot.snapshot_id.slice(0, 10);
  writeJson(join(SNAP_DIR, `${date}.json`), record);
}

/** Write history-full.json, lean history.json, and history.csv. */
export function writeHistory(historyFull) {
  ensureDirs();
  writeJson(join(API_DIR, 'history-full.json'), historyFull);
  writeJson(join(API_DIR, 'history.json'), historyFull.map(leanEntry));
  writeFileSync(join(API_DIR, 'history.csv'), toCsv(historyFull));
}

/** Read the existing full history (ascending), or [] if none yet. */
export function readHistoryFull() {
  const path = join(API_DIR, 'history-full.json');
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}
