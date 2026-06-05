// core/confidence.js — score how trustworthy a single snapshot/day is.
//
// Why this exists: the product sells trust in the number, so every snapshot
// carries an explicit, explainable confidence assessment rather than implying
// false precision. Three signals, each mapped to a human-readable reason:
//   - threshold count : more active markets = a finer, better-resolved CDF
//   - monotonicity    : P(>X) must be non-increasing; violations = stale/illiquid quotes
//   - mean spread     : mean(best_ask - best_bid); wide = illiquid (live only)
// Backfilled days have no order book, so spread is unknown — those are flagged
// "price-only" and capped at "medium" (we can't vouch for liquidity we never saw).

import { countMonotonicityViolations } from './metrics.js';

// Thresholds for the signal bands (documented in methodology.json).
const MIN_THRESHOLDS_HIGH = 12;
const MIN_THRESHOLDS_MEDIUM = 8;
const SPREAD_HIGH = 0.04; // mean spread strictly below → eligible for high
const SPREAD_MEDIUM = 0.08; // mean spread at/below → eligible for medium
const TIER_RANK = { low: 0, medium: 1, high: 2 };

/** Mean bid/ask spread across raw_inputs, or null if no book data present. */
function meanSpread(rawInputs) {
  if (!rawInputs) return null;
  const spreads = rawInputs
    .filter((r) => r.best_bid != null && r.best_ask != null)
    .map((r) => Number(r.best_ask) - Number(r.best_bid));
  if (spreads.length === 0) return null;
  return spreads.reduce((a, b) => a + b, 0) / spreads.length;
}

/**
 * Score a snapshot. Inputs:
 *   markets    : Array<{threshold, prob}> (the derived markets)
 *   rawInputs  : Array<{best_bid,best_ask,...}> | null  (null => backfill/price-only)
 * Returns { tier:'high'|'medium'|'low', score:0..1, reasons:string[] }.
 *
 * Tier is the WORST band any signal lands in (a single bad signal caps trust).
 * score is a smooth 0..1 blend of the three signals for sorting/at-a-glance use.
 */
export function scoreConfidence({ markets, rawInputs = null }) {
  const reasons = [];
  const count = markets.length;
  const violations = countMonotonicityViolations(markets);
  const spread = meanSpread(rawInputs);
  const priceOnly = spread == null;

  // ── per-signal tier ──
  const tiers = [];

  if (count >= MIN_THRESHOLDS_HIGH) {
    tiers.push('high');
  } else if (count >= MIN_THRESHOLDS_MEDIUM) {
    tiers.push('medium');
    reasons.push(`${count} active thresholds (coarser CDF)`);
  } else {
    tiers.push('low');
    reasons.push(`only ${count} active thresholds (sparse CDF)`);
  }

  if (violations === 0) {
    tiers.push('high');
  } else if (violations <= 2) {
    tiers.push('medium');
    reasons.push(`${violations} monotonicity violation(s)`);
  } else {
    tiers.push('low');
    reasons.push(`${violations} monotonicity violations (noisy quotes)`);
  }

  if (priceOnly) {
    // No book → cannot assess liquidity. Cap at medium, never high.
    tiers.push('medium');
    reasons.push('price-only (no spread data)');
  } else if (spread < SPREAD_HIGH) {
    tiers.push('high');
  } else if (spread <= SPREAD_MEDIUM) {
    tiers.push('medium');
    reasons.push(`mean spread ${(spread * 100).toFixed(1)}% (moderate liquidity)`);
  } else {
    tiers.push('low');
    reasons.push(`mean spread ${(spread * 100).toFixed(1)}% (illiquid)`);
  }

  // Tier = worst (lowest-rank) signal.
  const tier = tiers.reduce((a, b) => (TIER_RANK[b] < TIER_RANK[a] ? b : a), 'high');

  // ── smooth score (0..1) for sorting and the badge ──
  const countScore = Math.min(1, count / 16);
  const monoScore = Math.max(0, 1 - violations / 4);
  const spreadScore = priceOnly
    ? 0.6 // unknown liquidity → middling
    : Math.max(0, Math.min(1, 1 - spread / 0.1));
  const score = Number(
    ((countScore + monoScore + spreadScore) / 3).toFixed(3)
  );

  if (reasons.length === 0) reasons.push('full threshold set, monotonic, tight spreads');

  return { tier, score, reasons };
}
