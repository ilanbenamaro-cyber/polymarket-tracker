// scripts/metrics.js — derived distribution metrics for the SpaceX-IPO market.
//
// Why this exists: both the one-time backfill and the daily cron need the same
// math (median, mean, IQR band, per-bucket probabilities) over a snapshot of
// thresholds. Keeping it in one module guarantees a single source of truth.
// The implied median itself lives in digest.js (which must not change); we
// import and re-export it so callers can `import { ... } from './metrics.js'`
// for everything.
//
// A "snapshot" here is an array of { threshold, prob } sorted ascending by
// threshold, where prob = P(market cap > threshold) — i.e. a survival function
// that decreases as the threshold rises.

import { computeImpliedMedian } from '../digest.js';

export { computeImpliedMedian };

// Tail midpoint assumptions for the expected-value (mean) estimate. Documented
// in the dashboard methodology section so the approximation is transparent.
const BELOW_TAIL_OFFSET = 0.15; // midpoint = lowest threshold - 0.15
const ABOVE_TAIL_OFFSET = 0.4; // midpoint = highest threshold + 0.40

/** Sort + sanitize a snapshot into ascending {threshold, prob} with numeric probs. */
function normalize(snapshot) {
  return snapshot
    .filter((m) => m.prob != null && Number.isFinite(m.prob))
    .map((m) => ({ threshold: m.threshold, prob: m.prob }))
    .sort((a, b) => a.threshold - b.threshold);
}

/**
 * Valuation where the survival curve P(>X) crosses level S, by linear
 * interpolation between the two consecutive thresholds that straddle S.
 * Returns null if S is never crossed (all probs above or all below S).
 *
 * median  = quantileValuation(s, 0.50)
 * p25 val = quantileValuation(s, 0.75)   (25% chance the cap is higher)
 * p75 val = quantileValuation(s, 0.25)
 */
export function quantileValuation(snapshot, S) {
  const s = normalize(snapshot);
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i];
    const b = s[i + 1];
    if (a.prob >= S && b.prob < S) {
      return (
        a.threshold +
        ((b.threshold - a.threshold) * (a.prob - S)) / (a.prob - b.prob)
      );
    }
  }
  return null;
}

/** 50% confidence band: { p25, p75 } valuations (either may be null). */
export function computeIqr(snapshot) {
  return {
    p25: quantileValuation(snapshot, 0.75),
    p75: quantileValuation(snapshot, 0.25),
  };
}

/**
 * Per-bucket probability mass keyed by the bucket's lower threshold.
 * bucket(t_i) = P(>t_i) - P(>t_{i+1}); the top bucket = P(>t_max).
 * Returns Array<{ threshold, label, bucket_prob }> aligned to the snapshot.
 * (The "< lowest" bucket = 1 - P(>t_min) is added by the dashboard so the
 * density chart sums to ~1; it is not attached to any threshold here.)
 */
export function computeBucketProbs(snapshot) {
  const s = normalize(snapshot);
  return s.map((m, i) => {
    const next = s[i + 1];
    const bucket = next ? m.prob - next.prob : m.prob;
    return { threshold: m.threshold, bucket_prob: bucket };
  });
}

/**
 * Approximate expected valuation (mean) as a bucket-weighted sum of midpoints.
 * Middle buckets use the threshold midpoint; the two tails use fixed offsets
 * (BELOW/ABOVE_TAIL_OFFSET). Returns null for an empty snapshot.
 */
export function computeImpliedMean(snapshot) {
  const s = normalize(snapshot);
  if (s.length === 0) return null;

  const lowest = s[0];
  const highest = s[s.length - 1];
  let mean = 0;

  // Tail below the lowest threshold.
  mean += (lowest.threshold - BELOW_TAIL_OFFSET) * (1 - lowest.prob);

  // Middle buckets between consecutive thresholds.
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i];
    const b = s[i + 1];
    const pBucket = a.prob - b.prob;
    const midpoint = (a.threshold + b.threshold) / 2;
    mean += midpoint * pBucket;
  }

  // Tail above the highest threshold.
  mean += (highest.threshold + ABOVE_TAIL_OFFSET) * highest.prob;

  return mean;
}
