// core/snapshot.js — assemble the one canonical snapshot record.
//
// Why this exists: this is the single point where raw inputs become derived
// numbers. Every metric is computed from the arbitrage-consistent (isotonic-
// adjusted) curve; raw is preserved alongside. The API serves this record, the
// dashboard renders it, the note narrates it — none recompute. Pure (no I/O).

import {
  computeImpliedMedian,
  computeIqr,
  computeImpliedMean,
  computeDensity,
} from './metrics.js';
import { adjustSnapshot, medianBand, meanSensitivity } from './stats.js';
import { scoreConfidence } from './confidence.js';
import { buildNarrative } from './narrative.js';
import { ASSET } from './fetch.js';

const SCHEMA_VERSION = '1.1.0';

function totalVolume(markets) {
  return markets.reduce((sum, m) => sum + (m.volume ?? 0), 0);
}
function probAt(markets, threshold) {
  const row = markets.find((m) => m.threshold === threshold);
  return row ? row.prob : null;
}

/**
 * Core derived block shared by latest and history entries: isotonic adjustment +
 * all metrics from the adjusted curve + confidence. `context` carries optional
 * anomaly inputs for confidence.
 */
function buildDerivedCore({ markets, rawInputs = null, anomalies = null }) {
  const adj = adjustSnapshot(markets); // markets carry raw_prob + adjusted_prob + bucket_prob>=0
  const adjusted = adj.markets;
  const impliedMedian = computeImpliedMedian(adjusted);
  const impliedMean = computeImpliedMean(adjusted); // central / base case
  const confidence = scoreConfidence({
    markets: adjusted,
    rawInputs,
    rawViolations: adj.monotonicity_violations,
    maxAdjustment: adj.max_adjustment,
    liquidity: adj.liquidity,
    anomalies,
  });
  return {
    implied_median: impliedMedian,
    implied_mean: impliedMean,
    iqr: computeIqr(adjusted),
    total_volume: totalVolume(adjusted),
    adjustment: {
      monotonicity_violations: adj.monotonicity_violations,
      max_adjustment: adj.max_adjustment,
    },
    confidence,
    markets: adjusted,
    _adj: adj, // internal: not serialized at call sites that omit it
  };
}

/** Full "current" derived block: core + spread-implied median band + mean sensitivity. */
export function buildDerived({ markets, rawInputs = null, anomalies = null }) {
  const core = buildDerivedCore({ markets, rawInputs, anomalies });
  const median = medianBand(rawInputs, core.implied_median);
  const mean = meanSensitivity(core.markets);
  const { _adj, ...clean } = core;
  return { ...clean, median, mean };
}

/**
 * Build the full canonical record from a core/fetch.js live result.
 *   live: { fetched_at, endpoints, raw_inputs, raw_sha256, markets }
 *   anomalies: { stale, closedCount, liquidityDrop } (from orchestration)
 */
export function buildSnapshotRecord(live, methodologyVersion, anomalies = null) {
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
      derived: buildDerived({ markets: live.markets, rawInputs: live.raw_inputs, anomalies }),
    },
  };
}

/**
 * Attach the deterministic narrative to a built record, using history priors.
 * Done as a separate step because the narrative needs day-over-day context that
 * the pure record builder does not have. Mutates and returns the record.
 */
export function attachNarrative(record, { prior7d = null, prior30d = null } = {}) {
  const d = record.snapshot.derived;
  const density = computeDensity(d.markets).map((b) => ({ label: b.label, prob: b.prob }));
  const { narrative, narrative_components } = buildNarrative({
    derived: d,
    prior7d,
    prior30d,
    density,
  });
  d.narrative = narrative;
  d.narrative_components = narrative_components;
  return record;
}

/**
 * Build a single history-day entry (backfill + daily append). Leaner than the
 * current record: scalars + adjusted markets + adjustment + confidence, no band /
 * sensitivity / narrative (those are "current" features).
 */
export function buildHistoryEntry(date, markets, rawInputs = null) {
  const core = buildDerivedCore({ markets, rawInputs });
  return {
    date,
    implied_median: core.implied_median,
    implied_mean: core.implied_mean,
    iqr: core.iqr,
    prob_1_8t: probAt(core.markets, 1.8),
    prob_2_0t: probAt(core.markets, 2.0),
    prob_2_4t: probAt(core.markets, 2.4),
    adjustment: core.adjustment,
    confidence: core.confidence,
    markets: core.markets,
  };
}
