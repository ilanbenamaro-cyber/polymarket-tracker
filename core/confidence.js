// core/confidence.js — score how trustworthy a single snapshot/day is.
//
// Why this exists: the product sells trust in the number, so every snapshot
// carries an explicit, explainable assessment instead of implying false
// precision. Confidence is the WORST of several signals (a single bad signal
// caps trust), each mapped to a human-readable reason the dashboard surfaces
// inline. Backfilled days have no order book → "price-only", capped at medium.

const MIN_THRESHOLDS_HIGH = 12;
const MIN_THRESHOLDS_MEDIUM = 8;
const SPREAD_HIGH = 0.04;
const SPREAD_MEDIUM = 0.08;
const THIN_SHARE_HIGH = 0.2; // < 20% thin books → fine
const THIN_SHARE_MEDIUM = 0.5; // 20–50% thin → medium
const MATERIAL_ADJUSTMENT = 0.005; // 0.5%: below this an isotonic tweak is immaterial
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
 * Score a snapshot. All inputs are facts already computed in core/ — confidence
 * never recomputes a metric, it only interprets:
 *   markets       : adjusted markets [{threshold,...}]
 *   rawInputs     : [{best_bid,best_ask,...}] | null (null => price-only)
 *   rawViolations : monotonicity violations on RAW (from stats.adjustSnapshot)
 *   maxAdjustment : largest |raw - adjusted| (fraction)
 *   liquidity     : { thinCount, total, thinShare } (from stats.volumeTiers)
 *   anomalies     : { stale, closedCount, liquidityDrop:{triggered,pct}|null }
 * Returns { tier, score(0..1), reasons[] }.
 */
export function scoreConfidence({
  markets,
  rawInputs = null,
  rawViolations = 0,
  maxAdjustment = 0,
  liquidity = null,
  anomalies = null,
  midpointFallback = null,
  countHigh = MIN_THRESHOLDS_HIGH,
  countMedium = MIN_THRESHOLDS_MEDIUM,
  ladderSize = 16,
  lifecycle = null,
}) {
  const reasons = [];
  const tiers = [];
  const count = markets.length;
  const spread = meanSpread(rawInputs);
  const priceOnly = spread == null;
  // A non-OPEN market's "closed" rungs are its expected terminal condition, not a
  // data-quality anomaly — don't let them drag the tier (SpaceX is OPEN → no effect).
  const settled = lifecycle != null && lifecycle.state != null && lifecycle.state !== 'OPEN';

  // 1) Threshold count — resolution of the CDF.
  if (count >= countHigh) tiers.push('high');
  else if (count >= countMedium) {
    tiers.push('medium');
    reasons.push(`${count} active thresholds (coarser CDF)`);
  } else {
    tiers.push('low');
    reasons.push(`only ${count} active thresholds (sparse CDF)`);
  }

  // 2) Monotonicity — penalize by the MAGNITUDE of the isotonic adjustment, not
  //    the raw count: a violation pooled to a sub-0.5% tweak is immaterial noise and
  //    must not drop the tier (a quant would rightly call that over-penalizing).
  const adjPct = maxAdjustment * 100;
  const adjStr = adjPct < 0.05 ? '<0.05%' : `${adjPct.toFixed(1)}%`;
  if (rawViolations === 0) {
    tiers.push('high');
  } else if (maxAdjustment < MATERIAL_ADJUSTMENT) {
    tiers.push('high');
    reasons.push(`${rawViolations} negligible monotonicity tweak(s) (max ${adjStr})`);
  } else if (rawViolations <= 2) {
    tiers.push('medium');
    reasons.push(`${rawViolations} monotonicity adjustment(s) today (max ${adjStr})`);
  } else {
    tiers.push('low');
    reasons.push(`${rawViolations} monotonicity adjustments (max ${adjStr}) — noisy quotes`);
  }

  // 3) Spread — liquidity at the touch (live only).
  if (priceOnly) {
    tiers.push('medium');
    reasons.push('price-only history (no bid/ask spread)');
  } else if (spread < SPREAD_HIGH) tiers.push('high');
  else if (spread <= SPREAD_MEDIUM) {
    tiers.push('medium');
    reasons.push(`mean spread ${(spread * 100).toFixed(1)}% (moderate liquidity)`);
  } else {
    tiers.push('low');
    reasons.push(`mean spread ${(spread * 100).toFixed(1)}% (illiquid)`);
  }

  // 4) Liquidity breadth — how many books are thin.
  if (liquidity && liquidity.total > 0) {
    if (liquidity.thinShare < THIN_SHARE_HIGH) tiers.push('high');
    else if (liquidity.thinShare <= THIN_SHARE_MEDIUM) {
      tiers.push('medium');
      reasons.push(`thin liquidity on ${liquidity.thinCount} of ${liquidity.total} markets`);
    } else {
      tiers.push('low');
      reasons.push(`thin liquidity on ${liquidity.thinCount} of ${liquidity.total} markets`);
    }
  }

  // 5) Anomalies — the feed is defensive about its own quality.
  if (anomalies) {
    if (anomalies.stale) {
      tiers.push('medium');
      reasons.push('inputs identical to prior snapshot (possible stale feed)');
    }
    if (anomalies.closedCount > 0 && !settled) {
      tiers.push(anomalies.closedCount > 2 ? 'low' : 'medium');
      reasons.push(`${anomalies.closedCount} market(s) closed / not accepting orders`);
    }
    if (anomalies.liquidityDrop && anomalies.liquidityDrop.triggered) {
      tiers.push('medium');
      reasons.push(
        `total volume ${(anomalies.liquidityDrop.pct * 100).toFixed(0)}% below 7-day median`
      );
    }
  }

  // 6) Midpoint fallback — rungs with no live midpoint priced from the last trade
  //    (no live book), or excluded for want of any price. A rung off the live book is
  //    less trustworthy, so it degrades the tier. Null/zero on the normal path → no
  //    effect (SpaceX has none → frozen confidence unchanged).
  if (midpointFallback) {
    if (midpointFallback.lastTradeCount > 0) {
      tiers.push('medium');
      reasons.push(`${midpointFallback.lastTradeCount} rung(s) priced from last trade (no live book)`);
    }
    if (midpointFallback.skippedCount > 0) {
      tiers.push('low');
      const ts = (midpointFallback.skippedThresholds ?? []).join(', ');
      reasons.push(`${midpointFallback.skippedCount} rung(s) excluded (no price)${ts ? `: ${ts}` : ''}`);
    }
  }

  const tier = tiers.reduce((a, b) => (TIER_RANK[b] < TIER_RANK[a] ? b : a), 'high');

  // Smooth 0..1 score for sorting / the badge.
  const countScore = Math.min(1, count / ladderSize);
  const monoScore = Math.max(0, 1 - rawViolations / 4) * Math.max(0, 1 - maxAdjustment / 0.1);
  const spreadScore = priceOnly ? 0.6 : Math.max(0, Math.min(1, 1 - spread / 0.1));
  const liqScore = liquidity ? Math.max(0, 1 - liquidity.thinShare) : 0.7;
  let score = (countScore + monoScore + spreadScore + liqScore) / 4;
  if (anomalies) {
    if (anomalies.stale) score -= 0.15;
    if (anomalies.closedCount > 0 && !settled) score -= 0.1 * Math.min(3, anomalies.closedCount);
    if (anomalies.liquidityDrop && anomalies.liquidityDrop.triggered) score -= 0.1;
  }
  if (midpointFallback) {
    score -= 0.05 * Math.min(4, midpointFallback.lastTradeCount ?? 0);
    score -= 0.1 * Math.min(4, midpointFallback.skippedCount ?? 0);
  }
  score = Number(Math.max(0, Math.min(1, score)).toFixed(3));

  if (reasons.length === 0) reasons.push('full threshold set, monotonic, tight spreads, deep books');

  return { tier, score, reasons };
}
