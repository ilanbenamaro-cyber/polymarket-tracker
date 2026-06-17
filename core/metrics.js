// core/metrics.js — THE canonical implementation of every derived metric.
//
// Why this exists: a data product must have one source of truth for its numbers.
// Every formula lives here exactly once; fetch/snapshot/backfill/renderers and the
// local CLI (digest.js) all import from here. There must be no second copy of any
// formula anywhere in the tree (see acceptance: grep proves a single definition).
//
// A "snapshot" is an array of { threshold, prob } where prob = P(market cap >
// threshold): a survival function that is non-increasing as the threshold rises.

// Tail midpoint assumptions for the expected-value estimate. These are the most
// assumption-sensitive part of the methodology and are documented as such.
const BELOW_TAIL_OFFSET = 0.15; // midpoint = lowest threshold - 0.15
const ABOVE_TAIL_OFFSET = 0.4; //  midpoint = highest threshold + 0.40
const MEDIAN_LEVEL = 0.5;

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
 * Returns null if S is never crossed. This is the one primitive behind the
 * median and the IQR band.
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

/** Implied median valuation: where the CDF crosses 0.50. */
export function computeImpliedMedian(snapshot) {
  return quantileValuation(snapshot, MEDIAN_LEVEL);
}

/** 50% confidence band: { p25, p75 } valuations (CDF at 0.75 / 0.25). */
export function computeIqr(snapshot) {
  return {
    p25: quantileValuation(snapshot, 0.75),
    p75: quantileValuation(snapshot, 0.25),
  };
}

/**
 * Per-bucket probability mass keyed by the bucket's lower threshold.
 * bucket(t_i) = P(>t_i) - P(>t_{i+1}); the top bucket = P(>t_max).
 * The "< lowest" bucket (1 - P(>t_min)) is added by computeDensity / consumers
 * so the full distribution sums to 1.
 */
export function computeBucketProbs(snapshot) {
  const s = normalize(snapshot);
  return s.map((m, i) => {
    const next = s[i + 1];
    const bucket = next ? m.prob - next.prob : m.prob;
    return { threshold: m.threshold, bucket_prob: bucket };
  });
}

/** Copy of a markets array with bucket_prob attached to each entry. */
export function withBucketProbs(markets) {
  const byThreshold = new Map(
    computeBucketProbs(markets).map((b) => [b.threshold, b.bucket_prob])
  );
  return markets.map((m) => ({
    ...m,
    bucket_prob: byThreshold.get(m.threshold) ?? null,
  }));
}

// Default bucket-label builders reproduce the historical "$…T" forms. A market
// config supplies its own builders (core/market-config.js) for other units; the
// defaults keep every existing caller (and SpaceX) byte-identical.
const DEFAULT_LABELS = {
  lt: (t) => `<$${t}T`,
  between: (a, b) => `$${a}–${b}T`,
  gt: (t) => `>$${t}T`,
};

/**
 * Full probability density including the "< lowest" bucket, as
 * Array<{ label, lo, hi, prob }>. Used for the density chart and for the
 * sum-to-1.0 validation. lo/hi are bucket bounds (hi = Infinity for top).
 * `labels` overrides the bucket-label unit (defaults to the legacy "$…T").
 */
export function computeDensity(snapshot, labels = DEFAULT_LABELS) {
  const s = normalize(snapshot);
  if (s.length === 0) return [];
  const out = [{ label: labels.lt(s[0].threshold), lo: 0, hi: s[0].threshold, prob: 1 - s[0].prob }];
  for (let i = 0; i < s.length; i++) {
    const next = s[i + 1];
    const prob = next ? s[i].prob - next.prob : s[i].prob;
    out.push({
      label: next ? labels.between(s[i].threshold, next.threshold) : labels.gt(s[i].threshold),
      lo: s[i].threshold,
      hi: next ? next.threshold : Infinity,
      prob,
    });
  }
  return out;
}

/**
 * Approximate expected valuation (mean) as a bucket-weighted sum of midpoints.
 * Middle buckets use the threshold midpoint; the two tails use offsets that
 * default to the documented base case but can be overridden for sensitivity
 * analysis (see core/stats.js meanSensitivity). Returns null for an empty
 * snapshot. Flagged assumption-sensitive (tails).
 */
export function computeImpliedMean(
  snapshot,
  { belowOffset = BELOW_TAIL_OFFSET, aboveOffset = ABOVE_TAIL_OFFSET } = {}
) {
  const s = normalize(snapshot);
  if (s.length === 0) return null;

  const lowest = s[0];
  const highest = s[s.length - 1];
  let mean = (lowest.threshold - belowOffset) * (1 - lowest.prob);

  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i];
    const b = s[i + 1];
    mean += ((a.threshold + b.threshold) / 2) * (a.prob - b.prob);
  }

  mean += (highest.threshold + aboveOffset) * highest.prob;
  return mean;
}

/** The documented base-case tail offsets (exposed for the sensitivity grid). */
export const MEAN_TAIL_OFFSETS = {
  below: BELOW_TAIL_OFFSET,
  above: ABOVE_TAIL_OFFSET,
};

/** Number of monotonicity violations: points where P(>X) rises as X rises. */
export function countMonotonicityViolations(snapshot) {
  const s = normalize(snapshot);
  let violations = 0;
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i + 1].prob > s[i].prob) violations++;
  }
  return violations;
}
