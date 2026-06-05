// core/snapshot.js — assemble the one canonical snapshot record.
//
// Why this exists: this is the single point where raw inputs become derived
// numbers. The API serves this record raw, the dashboard renders it, the note
// narrates it — none of them recompute anything. Pure (no I/O): callers pass in
// the fetch result and the methodology version.

import {
  computeImpliedMedian,
  computeImpliedMean,
  computeIqr,
  withBucketProbs,
} from './metrics.js';
import { scoreConfidence } from './confidence.js';
import { ASSET } from './fetch.js';

const SCHEMA_VERSION = '1.0.0';

/** Sum of volume across markets (null volumes ignored). */
function totalVolume(markets) {
  return markets.reduce((sum, m) => sum + (m.volume ?? 0), 0);
}

/** Build the derived block shared by latest and (slimmed) history entries. */
export function buildDerived({ markets, rawInputs = null }) {
  return {
    implied_median: computeImpliedMedian(markets),
    implied_mean: computeImpliedMean(markets),
    iqr: computeIqr(markets),
    total_volume: totalVolume(markets),
    confidence: scoreConfidence({ markets, rawInputs }),
    markets: withBucketProbs(markets),
  };
}

/**
 * Build the full canonical record from a core/fetch.js live result.
 *   live: { fetched_at, endpoints, raw_inputs, raw_sha256, markets }
 *   methodologyVersion: string from core/methodology.json
 */
export function buildSnapshotRecord(live, methodologyVersion) {
  return {
    schema_version: SCHEMA_VERSION,
    methodology_version: methodologyVersion,
    asset: { ...ASSET },
    snapshot: {
      snapshot_id: live.fetched_at,
      fetched_at: live.fetched_at,
      source: {
        provider: 'Polymarket',
        endpoints: live.endpoints,
        raw_sha256: live.raw_sha256,
      },
      raw_inputs: live.raw_inputs,
      derived: buildDerived({ markets: live.markets, rawInputs: live.raw_inputs }),
    },
  };
}

/**
 * Build a single history-day entry (used by backfill and by the daily append).
 * Price-only by default (rawInputs null) → confidence reflects no book data.
 * Returns the "full" entry (with markets); the lean projection is derived by
 * the API renderer.
 */
export function buildHistoryEntry(date, markets, rawInputs = null) {
  const derived = buildDerived({ markets, rawInputs });
  return {
    date,
    implied_median: derived.implied_median,
    implied_mean: derived.implied_mean,
    iqr: derived.iqr,
    prob_1_8t: probAt(derived.markets, 1.8),
    prob_2_0t: probAt(derived.markets, 2.0),
    prob_2_4t: probAt(derived.markets, 2.4),
    confidence: derived.confidence,
    markets: derived.markets,
  };
}

function probAt(markets, threshold) {
  const row = markets.find((m) => m.threshold === threshold);
  return row ? row.prob : null;
}
