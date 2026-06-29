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

const NEAR_SETTLEMENT_DAYS = 7;
const EXTREME_LOW = 0.01;
const EXTREME_HIGH = 0.99;

// Increment 1 — windowed-volume liquidity tiers (operator-calibrated against live markets).
// Recent activity is a far better liquidity proxy than all-time cumulative (a dormant market shows
// a huge all-time total but ~0 recent volume). HIGH demands genuine recent flow; LOW catches the
// dormant-but-historically-traded case (US recession: $478/24h, $16K/7d behind a $1.6M all-time).
const VOL24_HIGH = 50_000;
const VOL1WK_HIGH = 200_000;
const VOL24_MEDIUM = 5_000;
const VOL1WK_MEDIUM = 25_000;
// F1 (red-team fix): the 7d-only HIGH path requires a minimum recent (24h) floor so a STALE 7d spike
// on a now-dormant market (24h ≈ dead) can't read HIGH on week-old activity. Absent v24 counts as 0.
const VOL24_HIGH_FLOOR = 2_000;

/**
 * Windowed-volume liquidity signal from a derived.liquidity object {volume_24hr, volume_1wk}.
 *   HIGH   : 24h ≥ $50K  OR  (7d ≥ $200K AND 24h ≥ $2K)   ← the $2K floor blocks a stale 7d spike
 *   MEDIUM : 24h ≥ $5K   OR  7d ≥ $25K
 *   LOW    : below both
 * Returns { tier, reason } (reason null for HIGH — no caveat) or NULL when no windowed data is
 * present, so callers fall back to the all-time tier and leave the score/tier UNCHANGED. The null
 * path is what keeps SpaceX's frozen confidence byte-identical (its replay carries no windowed volume).
 */
export function windowedVolumeSignal(liquidity) {
  if (!liquidity) return null;
  const v24 = liquidity.volume_24hr, v7 = liquidity.volume_1wk;
  if (v24 == null && v7 == null) return null;
  const v24n = v24 ?? 0, v7n = v7 ?? 0;
  const usd = `$${Math.round(v24 ?? v7 ?? 0).toLocaleString('en-US')}`;
  const window = v24 != null ? '24h' : '7d';
  if (v24n >= VOL24_HIGH || (v7n >= VOL1WK_HIGH && v24n >= VOL24_HIGH_FLOOR)) return { tier: 'high', reason: null };
  if (v24n >= VOL24_MEDIUM || v7n >= VOL1WK_MEDIUM) return { tier: 'medium', reason: `moderate ${window} volume (${usd})` };
  return { tier: 'low', reason: `thin ${window} volume (${usd})` };
}

/**
 * Increment 3 — time-to-expiry normalized spread tolerance. A wide bid/ask spread near expiry is
 * market-makers exiting (expected), not genuine illiquidity; the same spread 6 months out is real
 * illiquidity. So we WIDEN the spread thresholds as expiry approaches:
 *   > 90d (or unknown) → ×1.0 (standard) · 30–90d → ×1.5 · 7–30d → ×2.5 · < 7d → ×2.5
 * (< 7d's pinned-rung case is additionally handled by the near-settlement carve-out.) The multiplier
 * NEVER tightens, so a far-dated market (SpaceX, ~550d → ×1.0) is byte-identical.
 */
export function spreadToleranceMultiplier(daysToExpiry) {
  if (daysToExpiry == null || daysToExpiry > 90) return 1.0;
  if (daysToExpiry > 30) return 1.5;
  return 2.5;
}

/** " — 12d remaining" / "" — the time-to-expiry context appended to a spread reason. */
export function expiryNote(daysToExpiry) {
  return daysToExpiry == null ? '' : ` — ${Math.round(daysToExpiry)}d remaining`;
}

/** Fractional days from `fromIso` to a 'YYYY-MM-DD' resolution date, or null if unknown.
 *  (Mirrors the local copies in snapshot.js/touch-record.js; exported here for binary/categorical.) */
export function daysUntil(resolves, fromIso) {
  if (!resolves) return null;
  const end = Date.parse(resolves), from = Date.parse(fromIso);
  if (!Number.isFinite(end) || !Number.isFinite(from)) return null;
  return (end - from) / 86_400_000;
}

/**
 * "Near settlement" market state: expiring within 7 days AND a MAJORITY of rungs pinned to
 * ~0/~1 (adjusted_prob ≤0.01 or ≥0.99) — the outcome is essentially decided. Such a market's
 * large monotonicity adjustments and many closed/last-trade rungs are EXPECTED (the book is
 * winding down), not data-quality noise, so confidence must not penalize them as if the
 * market were a live, contested ladder, and the UI shows an amber NEAR SETTLEMENT badge
 * rather than OPEN. Pure; daysToExpiry null/unknown ⇒ false (never a false badge).
 */
export function nearSettlement(markets, daysToExpiry) {
  if (daysToExpiry == null || daysToExpiry > NEAR_SETTLEMENT_DAYS) return false;
  if (!Array.isArray(markets) || markets.length === 0) return false;
  const extreme = markets.filter((m) => {
    const p = m.adjusted_prob ?? m.prob;
    return p != null && (p <= EXTREME_LOW || p >= EXTREME_HIGH);
  }).length;
  return extreme / markets.length > 0.5;
}

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
  nearSettled = false,
  windowedVolume = null,
  daysToExpiry = null,
}) {
  const reasons = [];
  const tiers = [];
  const count = markets.length;
  const spread = meanSpread(rawInputs);
  const priceOnly = spread == null;
  // A non-OPEN market's "closed" rungs are its expected terminal condition, not a
  // data-quality anomaly — don't let them drag the tier (SpaceX is OPEN → no effect).
  const settled = lifecycle != null && lifecycle.state != null && lifecycle.state !== 'OPEN';
  // Bug 3 recalibration (CONFINED to the near-settlement path): once the outcome is decided
  // (expiring ≤7d, rungs pinned to ~0/~1), the large monotonicity adjustments, closed rungs,
  // and last-trade-priced legs are the EXPECTED signature of a winding-down book, not
  // data-quality red flags — so they must not drag a liquid market to LOW. `expected` gates
  // every carve-out; a normal market (incl. frozen SpaceX, ~18mo out → nearSettled false) is
  // byte-identical. A genuinely missing price (skippedCount) is still a real CDF hole and
  // still penalizes, even near settlement.
  const expected = settled || nearSettled;

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
  } else if (nearSettled) {
    // Near settlement, rungs pinning to 0/1 manufacture large apparent violations — structural,
    // not noisy quotes. Don't penalize (let an otherwise-clean converged ladder reach HIGH).
    tiers.push('high');
    reasons.push(`${rawViolations} monotonicity adjustment(s) (max ${adjStr}) — expected near settlement`);
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

  // 3) Spread — liquidity at the touch (live only). Tolerance WIDENS near expiry (Increment 3): a
  //    wide spread on a market expiring soon is MMs exiting, not illiquidity. SpaceX (~550d → ×1.0,
  //    tight spread → HIGH, no reason) is byte-identical.
  const spreadMult = spreadToleranceMultiplier(daysToExpiry);
  const sHigh = SPREAD_HIGH * spreadMult;
  const sMedium = SPREAD_MEDIUM * spreadMult;
  const note = expiryNote(daysToExpiry);
  if (priceOnly) {
    tiers.push('medium');
    reasons.push('price-only history (no bid/ask spread)');
  } else if (spread < sHigh) tiers.push('high');
  else if (spread <= sMedium) {
    tiers.push('medium');
    reasons.push(`mean spread ${(spread * 100).toFixed(1)}% (${spreadMult > 1 ? `expected near expiry${note}` : 'moderate liquidity'})`);
  } else {
    tiers.push('low');
    reasons.push(`mean spread ${(spread * 100).toFixed(1)}% (illiquid${note})`);
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
    if (anomalies.closedCount > 0 && !expected) {
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
      // A leg off the live book is EXPECTED for a settled/near-settled market (winding down),
      // so it's not a trust detractor there — say "settled", don't read as illiquid.
      tiers.push(expected ? 'high' : 'medium');
      reasons.push(expected
        ? `${midpointFallback.lastTradeCount} settled rung(s) (priced from last trade)`
        : `${midpointFallback.lastTradeCount} rung(s) priced from last trade (no live book)`);
    }
    if (midpointFallback.skippedCount > 0) {
      // A genuinely missing price punches a hole in the CDF — a real defect even near settlement.
      tiers.push('low');
      const ts = (midpointFallback.skippedThresholds ?? []).join(', ');
      reasons.push(`${midpointFallback.skippedCount} rung(s) excluded (no price)${ts ? `: ${ts}` : ''}`);
    }
  }

  // 7) Windowed volume (Increment 1) — recent liquidity. When present it caps/raises the tier like
  //    any other signal; absent (frozen replay) it's a no-op → SpaceX byte-identical. The all-time
  //    volume tier in the binary/touch/categorical scorers remains the FALLBACK when this is absent.
  const winVol = windowedVolumeSignal(windowedVolume);
  if (winVol) {
    tiers.push(winVol.tier);
    if (winVol.reason) reasons.push(winVol.reason);
  }

  const tier = tiers.reduce((a, b) => (TIER_RANK[b] < TIER_RANK[a] ? b : a), 'high');

  // Smooth 0..1 score for sorting / the badge.
  const countScore = Math.min(1, count / ladderSize);
  // Near settlement, the isotonic adjustment is structural (rungs pinning to 0/1), not noise.
  const monoScore = nearSettled ? 1 : Math.max(0, 1 - rawViolations / 4) * Math.max(0, 1 - maxAdjustment / 0.1);
  const spreadScore = priceOnly ? 0.6 : Math.max(0, Math.min(1, 1 - spread / 0.1));
  const liqScore = liquidity ? Math.max(0, 1 - liquidity.thinShare) : 0.7;
  // Windowed volume joins as a 5th averaged term ONLY when present, so a market without it (frozen
  // SpaceX replay) keeps the exact 4-term average → byte-identical score.
  const baseTerms = [countScore, monoScore, spreadScore, liqScore];
  if (winVol) baseTerms.push(winVol.tier === 'high' ? 1 : winVol.tier === 'medium' ? 0.5 : 0.15);
  let score = baseTerms.reduce((a, b) => a + b, 0) / baseTerms.length;
  if (anomalies) {
    if (anomalies.stale) score -= 0.15;
    if (anomalies.closedCount > 0 && !expected) score -= 0.1 * Math.min(3, anomalies.closedCount);
    if (anomalies.liquidityDrop && anomalies.liquidityDrop.triggered) score -= 0.1;
  }
  if (midpointFallback) {
    // Expected last-trade legs near settlement aren't a score detractor; a skipped rung still is.
    if (!expected) score -= 0.05 * Math.min(4, midpointFallback.lastTradeCount ?? 0);
    score -= 0.1 * Math.min(4, midpointFallback.skippedCount ?? 0);
  }
  score = Number(Math.max(0, Math.min(1, score)).toFixed(3));

  if (reasons.length === 0) reasons.push('full threshold set, monotonic, tight spreads, deep books');

  return { tier, score, reasons };
}
