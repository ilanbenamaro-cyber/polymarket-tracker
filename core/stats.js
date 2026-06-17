// core/stats.js — arbitrage-consistency and uncertainty math.
//
// Why this exists: each "above $X" market is a SEPARATE order book, so raw
// midpoints are not arbitrage-consistent — P(>1.2T) can exceed P(>1.4T),
// producing NEGATIVE probability mass in a bucket. A quant spots that instantly.
// We enforce a monotone (non-increasing) CDF via volume-weighted isotonic
// regression (PAVA), keep BOTH raw and adjusted, and derive all metrics from the
// adjusted curve. We also quantify uncertainty (spread-implied median band) and
// fragility (mean tail-sensitivity grid). Formulas that already exist
// (quantileValuation, computeImpliedMean) are imported, never re-implemented.

import { quantileValuation, computeImpliedMean } from './metrics.js';

const FLOAT_EPS = 1e-9;
const LIQUIDITY_FLOOR = 50_000; // USD cumulative volume; below = "thin" book
const MEAN_GRID = {
  below: [0.1, 0.15, 0.2], // subtracted from the lowest threshold
  above: [0.3, 0.4, 0.6], //  added to the highest threshold
};

/** Volume → isotonic weight: trust liquid quotes more; null/0 falls back to 1. */
function weightOf(volume) {
  return volume != null && volume > 0 ? volume : 1;
}

/**
 * Pool Adjacent Violators — weighted L2 isotonic regression enforcing a
 * NON-INCREASING sequence. On a violation (an earlier value below a later one)
 * adjacent blocks merge to their volume-weighted mean, so the pooled price is
 * pulled toward the higher-volume (more trustworthy) quote. Returns the adjusted
 * values in input order. Pure; values expected in [0,1].
 */
export function pava(values, weights) {
  const blocks = []; // { sum: Σ w·y, w: Σ w, count }
  for (let i = 0; i < values.length; i++) {
    blocks.push({ sum: values[i] * weights[i], w: weights[i], count: 1 });
    // Merge while the previous block's mean is BELOW the last block's mean
    // (that is the non-increasing violation).
    while (blocks.length >= 2) {
      const last = blocks[blocks.length - 1];
      const prev = blocks[blocks.length - 2];
      if (prev.sum / prev.w < last.sum / last.w) {
        prev.sum += last.sum;
        prev.w += last.w;
        prev.count += last.count;
        blocks.pop();
      } else break;
    }
  }
  const out = [];
  for (const b of blocks) {
    const mean = b.sum / b.w;
    for (let k = 0; k < b.count; k++) out.push(mean);
  }
  return out;
}

/** Isotonic-adjust a markets array's prob field. Returns sorted markets + adjusted[]. */
function isotonicProbs(markets) {
  const sorted = [...markets].sort((a, b) => a.threshold - b.threshold);
  const adjusted = pava(
    sorted.map((m) => m.prob),
    sorted.map((m) => weightOf(m.volume))
  );
  return { sorted, adjusted };
}

/**
 * Resolve the thin-book volume floor. A pinned market supplies an absolute USD
 * floor (SpaceX: 50_000). A generic market (floor == null) scales it to its own
 * book — 10% of the median non-zero rung volume — so a small market is not judged
 * entirely "thin" against a large-market absolute. Falls back to the legacy floor
 * when there is no volume to scale against.
 */
function resolveFloor(markets, floor) {
  if (floor != null) return floor;
  const vols = markets.map((m) => m.volume ?? 0).filter((v) => v > 0).sort((a, b) => a - b);
  if (vols.length === 0) return LIQUIDITY_FLOOR;
  return 0.1 * vols[Math.floor(vols.length / 2)];
}

/**
 * Adjust a live/raw snapshot into an arbitrage-consistent one.
 *   input markets: [{ label, threshold, prob (raw midpoint), volume }]
 * Returns {
 *   markets: [{ label, threshold, raw_prob, adjusted_prob, prob (=adjusted),
 *               bucket_prob>=0, volume, volume_tier }],
 *   monotonicity_violations,  // counted on RAW
 *   max_adjustment            // max |raw - adjusted|
 * }
 */
export function adjustSnapshot(markets, { liquidityFloor = LIQUIDITY_FLOOR } = {}) {
  if (!markets || markets.length === 0) {
    return { markets: [], monotonicity_violations: 0, max_adjustment: 0 };
  }
  const { sorted, adjusted } = isotonicProbs(markets);
  const tiers = volumeTiers(sorted, liquidityFloor);
  // Price-only days have no volume → liquidity is UNKNOWN, never "thin".
  const liquidity = tiers.hasVolume
    ? { thinCount: tiers.thinCount, total: tiers.total, thinShare: tiers.thinShare }
    : null;

  let violations = 0;
  let maxAdj = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i < sorted.length - 1 && sorted[i + 1].prob > sorted[i].prob + FLOAT_EPS) {
      violations++;
    }
    maxAdj = Math.max(maxAdj, Math.abs(sorted[i].prob - adjusted[i]));
  }

  const out = sorted.map((m, i) => {
    const next = adjusted[i + 1];
    let bucket = next != null ? adjusted[i] - next : adjusted[i];
    if (bucket < 0 && bucket > -FLOAT_EPS) bucket = 0; // clamp float noise only
    return {
      label: m.label,
      threshold: m.threshold,
      raw_prob: m.prob,
      adjusted_prob: adjusted[i],
      prob: adjusted[i], // retained alias = adjusted (keeps the API additive)
      bucket_prob: bucket,
      volume: m.volume,
      volume_tier: tiers.byThreshold.get(m.threshold),
    };
  });

  return {
    markets: out,
    monotonicity_violations: violations,
    max_adjustment: maxAdj,
    liquidity,
  };
}

/**
 * Spread-implied median band (live only). Isotonic-adjust the best_bid curve and
 * the best_ask curve independently, take each one's 0.50 crossing, and bound the
 * central median by them. Returns { central, low, high } or null when there is no
 * usable two-sided book. Never synthesizes a missing quote.
 */
export function medianBand(rawInputs, centralMedian) {
  if (!rawInputs) return null;
  const side = (key) =>
    rawInputs
      .filter((r) => r[key] != null)
      .map((r) => ({ threshold: r.threshold, prob: Number(r[key]), volume: r.volume }));

  const bids = side('best_bid');
  const asks = side('best_ask');
  if (bids.length < 2 || asks.length < 2) return null;

  const bidAdj = isotonicProbs(bids);
  const askAdj = isotonicProbs(asks);
  const medBid = quantileValuation(
    bidAdj.sorted.map((m, i) => ({ threshold: m.threshold, prob: bidAdj.adjusted[i] })),
    0.5
  );
  const medAsk = quantileValuation(
    askAdj.sorted.map((m, i) => ({ threshold: m.threshold, prob: askAdj.adjusted[i] })),
    0.5
  );
  if (medBid == null || medAsk == null) return null;

  return {
    central: centralMedian,
    low: Math.min(medBid, medAsk),
    high: Math.max(medBid, medAsk),
  };
}

/**
 * Mean tail-sensitivity range. The implied mean depends on arbitrary tail
 * midpoints; we evaluate the base case plus a 3×3 grid and report the span.
 * Operates on the ADJUSTED markets. Returns { central, low, high }.
 */
export function meanSensitivity(
  adjustedMarkets,
  { below = 0.15, above = 0.4, gridBelow = MEAN_GRID.below, gridAbove = MEAN_GRID.above } = {}
) {
  const central = computeImpliedMean(adjustedMarkets, {
    belowOffset: below,
    aboveOffset: above,
  });
  if (central == null) return { central: null, low: null, high: null, width: null, tail_insensitive: null };
  const vals = [];
  for (const b of gridBelow) {
    for (const a of gridAbove) {
      vals.push(computeImpliedMean(adjustedMarkets, { belowOffset: b, aboveOffset: a }));
    }
  }
  const low = Math.min(...vals);
  const high = Math.max(...vals);
  const width = high - low;
  // D2: if the grid barely moves the mean (rounds to the same 2dp), say so
  // explicitly rather than rendering a false-precision "$x–$x" band.
  return { central, low, high, width, tail_insensitive: width < 0.01 };
}

/**
 * Per-market liquidity tier by volume tertile, plus a thin-book count against an
 * absolute floor. Returns { byThreshold: Map, thinCount, total, thinShare }.
 */
export function volumeTiers(markets, floor = LIQUIDITY_FLOOR) {
  const n = markets.length;
  const hasVolume = markets.some((m) => m.volume != null && m.volume > 0);
  const byThreshold = new Map();
  if (!hasVolume) {
    // Volume unknown (price-only) → tiers are null, liquidity is not assessed.
    for (const m of markets) byThreshold.set(m.threshold, null);
    return { byThreshold, thinCount: 0, total: n, thinShare: 0, hasVolume: false };
  }
  const thinFloor = resolveFloor(markets, floor);
  const sorted = markets.map((m) => m.volume ?? 0).sort((a, b) => a - b);
  const p33 = sorted[Math.floor(0.33 * (n - 1))];
  const p66 = sorted[Math.floor(0.66 * (n - 1))];
  let thinCount = 0;
  for (const m of markets) {
    const v = m.volume ?? 0;
    byThreshold.set(m.threshold, v >= p66 ? 'high' : v >= p33 ? 'med' : 'low');
    if (v < thinFloor) thinCount++;
  }
  return { byThreshold, thinCount, total: n, thinShare: n ? thinCount / n : 0, hasVolume: true };
}

export { LIQUIDITY_FLOOR };
