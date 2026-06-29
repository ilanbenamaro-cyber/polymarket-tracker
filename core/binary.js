// core/binary.js — build the canonical record for a BINARY (single Yes/No) market.
//
// Peer to snapshot.js's ladder builder, sharing nothing of the ladder math (no CDF,
// no isotonic, no median/IQR). A binary market has ONE number — the YES probability —
// so the derived block is `{ kind:'binary', probability, confidence, total_volume,
// narrative, freshness }`, discriminated by `kind` against the ladder shape (the
// schema's if/then keys off it). Provenance is the SAME hash recipe as the ladder
// (canonicalizeRawInputs over raw_inputs); only the content differs (YES/NO sides).

import { buildFreshness } from './freshness.js';
import { SCHEMA_VERSION } from './snapshot.js';
import { windowedVolumeSignal } from './confidence.js';

const TIER_RANK = { low: 0, medium: 1, high: 2 };
const SPREAD_HIGH = 0.04; // mirror the ladder's spread thresholds (4pp / 8pp)
const SPREAD_MEDIUM = 0.08;
const VOL_HIGH = 100_000;
const VOL_MEDIUM = 10_000;

/**
 * Score a binary snapshot — the worst of spread, volume, midpoint-fallback, and
 * lifecycle signals, each surfaced as a reason. No ladder concepts (threshold count,
 * monotonicity) apply. Returns { tier, score(0..1), reasons[] }.
 */
export function scoreBinaryConfidence({ probability, bestBid, bestAsk, totalVolume, midpointFallback = null, lifecycle = null, windowedVolume = null }) {
  const reasons = [];
  const tiers = [];
  const settled = lifecycle != null && lifecycle.state != null && lifecycle.state !== 'OPEN';

  // 1) Spread at the touch (live only).
  const spread = bestBid != null && bestAsk != null ? Number(bestAsk) - Number(bestBid) : null;
  if (spread == null) {
    if (!settled) { tiers.push('medium'); reasons.push('no live book (price-only)'); }
  } else if (spread < SPREAD_HIGH) {
    tiers.push('high');
  } else if (spread <= SPREAD_MEDIUM) {
    tiers.push('medium');
    reasons.push(`spread ${(spread * 100).toFixed(1)}pp (moderate liquidity)`);
  } else {
    tiers.push('low');
    reasons.push(`spread ${(spread * 100).toFixed(1)}pp (illiquid)`);
  }
  // Spread relative to the implied probability — a 5pp spread means much more on a 10%
  // line than a 50% one. Flag (descriptive) when it dominates the smaller tail.
  if (spread != null && probability != null && probability > 0 && probability < 1) {
    const rel = spread / Math.min(probability, 1 - probability);
    if (rel > 0.5) reasons.push(`spread is ${Math.round(rel * 100)}% of the implied probability`);
  }

  // 2) Volume — a thin binary is easy to push around. Prefer WINDOWED (recent) volume when present
  //    (Increment 1); the all-time tier is the fallback when windowed data is unavailable.
  const winVol = windowedVolumeSignal(windowedVolume);
  if (winVol) {
    tiers.push(winVol.tier);
    if (winVol.reason) reasons.push(winVol.reason);
  } else if (totalVolume != null) {
    const v = `$${Math.round(totalVolume).toLocaleString('en-US')}`;
    if (totalVolume >= VOL_HIGH) tiers.push('high');
    else if (totalVolume >= VOL_MEDIUM) { tiers.push('medium'); reasons.push(`moderate volume (${v})`); }
    else { tiers.push('low'); reasons.push(`thin volume (${v})`); }
  }

  // 3) Midpoint fallback (Phase 1) — a side priced off the last trade, or with no price.
  if (midpointFallback) {
    if (midpointFallback.lastTradeCount > 0) {
      tiers.push('medium');
      reasons.push(`${midpointFallback.lastTradeCount} side(s) priced from last trade (no live book)`);
    }
    if (midpointFallback.skippedCount > 0) {
      tiers.push('low');
      reasons.push(`${midpointFallback.skippedCount} side(s) had no price`);
    }
  }

  const tier = tiers.reduce((a, b) => (TIER_RANK[b] < TIER_RANK[a] ? b : a), 'high');

  let score = spread != null ? Math.max(0, Math.min(1, 1 - spread / 0.1)) : 0.6;
  if (winVol) score = (score + (winVol.tier === 'high' ? 1 : winVol.tier === 'medium' ? 0.5 : 0.15)) / 2;
  else if (totalVolume != null) score = (score + Math.min(1, totalVolume / VOL_HIGH)) / 2;
  if (midpointFallback) {
    score -= 0.05 * Math.min(2, midpointFallback.lastTradeCount ?? 0);
    score -= 0.1 * Math.min(2, midpointFallback.skippedCount ?? 0);
  }
  score = Number(Math.max(0, Math.min(1, score)).toFixed(3));

  if (reasons.length === 0) reasons.push('tight spread, deep book');
  return { tier, score, reasons };
}

/** Deterministic one-liner — only claims backed by the computed numbers. */
function buildBinaryNarrative(name, probability, confidence) {
  const pct = probability != null ? `${Math.round(probability * 100)}%` : 'an unknown';
  return `The market implies a ${pct} chance that "${name}" resolves YES. Confidence is ${confidence.tier}.`;
}

/**
 * Build the full canonical binary record from a fetchBinarySnapshot result.
 *   live: { fetched_at, endpoints, raw_inputs, raw_sha256, probability, probability_no,
 *           total_volume, yes_best_bid, yes_best_ask, midpoint_fallback }
 */
export function buildBinaryRecord(live, methodologyVersion, config, lifecycle = null, freshnessThresholdHours = undefined) {
  if (!config) throw new Error('buildBinaryRecord: a MarketConfig is required');

  const confidence = scoreBinaryConfidence({
    probability: live.probability,
    bestBid: live.yes_best_bid,
    bestAsk: live.yes_best_ask,
    totalVolume: live.total_volume,
    midpointFallback: live.midpoint_fallback ?? null,
    lifecycle,
    windowedVolume: live.liquidity ?? null, // Increment 1
  });

  const derived = {
    kind: 'binary',
    probability: live.probability,
    probability_no: live.probability_no ?? null,
    total_volume: live.total_volume ?? 0,
    confidence,
    narrative: buildBinaryNarrative(config.name, live.probability, confidence),
    freshness: buildFreshness(live.fetched_at, null, freshnessThresholdHours, lifecycle),
  };
  if (live.liquidity) derived.liquidity = live.liquidity; // Increment 1: windowed volume, omit-when-absent

  const snapshot = {
    snapshot_id: live.fetched_at,
    fetched_at: live.fetched_at,
    source: { provider: 'Polymarket', endpoints: live.endpoints, raw_sha256: live.raw_sha256 },
    raw_inputs: live.raw_inputs,
    derived,
  };
  if (lifecycle) snapshot.lifecycle = lifecycle;

  return {
    schema_version: SCHEMA_VERSION,
    methodology_version: methodologyVersion,
    assumptions_version: null, // binary carries no Tier-2 scenarios
    asset: { id: config.id, name: config.name, platform: config.platform, market_url: config.market_url, resolves: config.resolves },
    snapshot,
  };
}
