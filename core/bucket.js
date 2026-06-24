// core/bucket.js — bucket-PMF market core (Bitcoin "between $X and $Y", Anthropic IPO).
//
// A bucket market is a set of DISJOINT price/value intervals whose YES prices form a PMF
// (probability mass function) — NOT a survival ladder. Modeling it as P(>X) (the old
// 'ladder' misclassification) collapsed comma/bracket numbers to duplicate thresholds
// (Bug 4) and produced nonsense means (Bug 2). Here we parse each leg to an interval,
// then DERIVE the survival curve P(>boundary) from the PMF (so core/metrics median/IQR/
// density still apply) and compute the mean DIRECTLY from the PMF (bounded, no outlier
// blowup). Pure; values are absolute dollars (core/money.parseMoney). See MARKET-TYPES-PLAN.md.

import { parseMoney } from './money.js';

const BETWEEN_RE = /between\s+(\$[\d.,]+[KMBT]?)\s+and\s+(\$[\d.,]+[KMBT]?)/i;
const LESS_RE = /less than|below|under|or less|or lower|or fewer/i;
const GREATER_RE = /greater|above|or more|or greater|at least|higher/i;

/** A bucket leg's question → { lo, hi } interval in absolute dollars, or null when the
 *  leg carries no $ amount (a categorical leg such as "Will X not IPO …" — excluded). */
export function parseBucketLeg(question) {
  if (question == null) return null;
  const s = String(question);
  const between = s.match(BETWEEN_RE);
  if (between) {
    const a = parseMoney(between[1])?.value;
    const b = parseMoney(between[2])?.value;
    if (a == null || b == null) return null;
    return { lo: Math.min(a, b), hi: Math.max(a, b) };
  }
  const money = parseMoney(s);
  if (!money) return null; // categorical leg — no $ amount
  if (LESS_RE.test(s)) return { lo: 0, hi: money.value };
  if (GREATER_RE.test(s)) return { lo: money.value, hi: Infinity };
  return { lo: money.value, hi: Infinity }; // single-bound fallback → treat as ">= value"
}

function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Build the derived survival ladder + PMF mean from parsed bucket legs.
 *   legs: [{ lo, hi, prob }]  (prob = observed YES price = P(value ∈ bucket))
 * Returns { markets: [{threshold, prob:P(>threshold)}], mean, offset } where the markets
 * array plugs straight into computeImpliedMedian/computeIqr/computeDensity. The mean is the
 * PMF expectation Σ midpoint·prob; open tails use a half-width offset (same idea as the
 * survival mean's tail offsets), so a tiny-mass far bucket can't dominate.
 */
export function buildPmfLadder(legs) {
  const valid = (legs || []).filter((l) => l && Number.isFinite(l.prob));
  // Interior boundaries: every finite edge > 0 (the bottom bucket's lo=0 is not a rung).
  const edges = new Set();
  for (const l of valid) {
    if (Number.isFinite(l.lo) && l.lo > 0) edges.add(l.lo);
    if (Number.isFinite(l.hi) && l.hi > 0) edges.add(l.hi);
  }
  const boundaries = [...edges].sort((a, b) => a - b);
  const markets = boundaries.map((b) => ({
    threshold: b,
    prob: valid.filter((l) => l.lo >= b).reduce((sum, l) => sum + l.prob, 0),
  }));

  // Tail offset = half the median MIDDLE-bucket width (fallback: half the boundary span).
  // Only buckets with a finite positive lower bound are "middle" buckets — the open bottom
  // bucket [0, hi) has an artificially huge width that would skew the median.
  const widths = valid.filter((l) => Number.isFinite(l.lo) && l.lo > 0 && Number.isFinite(l.hi)).map((l) => l.hi - l.lo);
  const span = boundaries.length >= 2 ? boundaries[boundaries.length - 1] - boundaries[0] : (boundaries[0] ?? 0);
  const offset = (widths.length ? median(widths) : span) / 2;

  let mean = 0;
  for (const l of valid) {
    let mid;
    if (l.lo <= 0 && Number.isFinite(l.hi)) mid = l.hi - offset; // bottom bucket [0, hi)
    else if (!Number.isFinite(l.hi)) mid = l.lo + offset; // top bucket [lo, ∞)
    else mid = (l.lo + l.hi) / 2; // middle bucket
    mean += mid * l.prob;
  }

  return { markets, mean, offset };
}
