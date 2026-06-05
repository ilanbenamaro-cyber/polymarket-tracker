// scripts/snapshot.js — main entry, run by the cron and by hand.
//
// Pipeline: fetch (with provenance) → build canonical record → validate (fail
// loudly) → render the JSON API (latest, methodology, archive) → append/replace
// today in history → bake the dashboard/note fallback. No metric is computed
// outside core/.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { fetchLiveSnapshot } from '../core/fetch.js';
import { buildSnapshotRecord, buildHistoryEntry } from '../core/snapshot.js';
import { validateRecord, validateHistoryEntry } from '../core/validate.js';
import {
  writeLatest,
  writeMethodology,
  archiveSnapshot,
  writeHistory,
  readHistoryFull,
} from '../renderers/api.js';
import { bakeFallback } from '../renderers/dashboard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const METHODOLOGY = JSON.parse(
  readFileSync(join(__dirname, '../core/methodology.json'), 'utf8')
);
const HISTORY_CAP = 730;

async function main() {
  // 1. Fetch with provenance.
  const live = await fetchLiveSnapshot();

  // 2. Build the canonical record and validate it (abort on any violation).
  const record = buildSnapshotRecord(live, METHODOLOGY.version);
  validateRecord(record);

  // 3. Render the JSON API surface.
  writeLatest(record);
  writeMethodology(METHODOLOGY);
  archiveSnapshot(record);

  // 4. Append/replace today in the full history (ascending by date), using the
  //    live raw_inputs so today's confidence reflects real order-book spread.
  const today = live.fetched_at.slice(0, 10);
  const entry = buildHistoryEntry(today, live.markets, live.raw_inputs);
  validateHistoryEntry(entry);

  const history = readHistoryFull();
  if (history.length > 0 && history[history.length - 1].date === today) {
    history[history.length - 1] = entry;
  } else {
    history.push(entry);
  }
  writeHistory(history.slice(-HISTORY_CAP));

  // 5. Bake the static fallback headline into the HTML.
  bakeFallback(record);

  const d = record.snapshot.derived;
  console.log(
    `✓ snapshot ${today}: median $${d.implied_median?.toFixed(2)}T, ` +
      `confidence ${d.confidence.tier} (${d.confidence.score}), ` +
      `${history.length} history days, sha ${record.snapshot.source.raw_sha256.slice(0, 12)}…`
  );
}

main().catch((err) => {
  console.error('snapshot failed:', err.message);
  process.exit(1);
});
