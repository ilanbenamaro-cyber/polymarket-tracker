// core/analytics.js — Tier-1 market-derived analytics (ZERO new assumptions).
//
// Why this exists: deepen the read using only transforms of observed Polymarket
// prices — distribution shape, dispersion-over-time, velocity, and a calibration
// scaffold. Every figure is quantile/probability based (no tail midpoint guesses),
// computed exactly once here, stored in derived.market.analytics, and consumed by
// the narrative + renderers (which never recompute). Reuses metrics.js primitives.

import { quantileValuation, computeDensity } from './metrics.js';
import { roundT, fmtSignedDeltaT, deltaDir } from './format.js';

const NORMAL_TAIL_RATIO = 1.9; // (P90-P10)/(P75-P25) for a normal distribution
const DISPERSION_EPS = 0.03; // $T change in IQR width that counts as a real move
const ACCEL_EPS = 0.002; // $T/day difference that counts as accel/decel

// ── shape ────────────────────────────────────────────────────────────────────
function computeShape(markets, iqr, median) {
  const width = iqr.p25 != null && iqr.p75 != null ? iqr.p75 - iqr.p25 : null;
  const skew_bowley =
    median != null && width && width > 1e-9
      ? roundT3(((iqr.p75 - median) - (median - iqr.p25)) / width)
      : null;

  // Robust kurtosis proxy via the 10th/90th-percentile valuations (zero assumptions).
  const q10val = quantileValuation(markets, 0.9); // valuation at the 10th percentile
  const q90val = quantileValuation(markets, 0.1); // valuation at the 90th percentile
  const tail_ratio =
    q10val != null && q90val != null && width && width > 1e-9
      ? roundT3((q90val - q10val) / width)
      : null;
  const fat_tail = tail_ratio != null ? roundT3(tail_ratio / NORMAL_TAIL_RATIO) : null;

  // Normalized Shannon entropy + Gini over the density buckets (consensus vs spread).
  const dens = computeDensity(markets).map((b) => b.prob);
  const n = dens.length;
  let entropy = null;
  if (n > 1) {
    const H = -dens.filter((p) => p > 1e-12).reduce((s, p) => s + p * Math.log(p), 0);
    entropy = roundT3(H / Math.log(n));
  }
  const sorted = [...dens].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  let gini = null;
  if (sum > 0) {
    let g = 0;
    for (let i = 0; i < n; i++) g += (2 * (i + 1) - n - 1) * sorted[i];
    gini = roundT3(g / (n * sum));
  }
  const buckets = computeDensity(markets);
  const dominant = buckets.length
    ? buckets.reduce((a, b) => (b.prob > a.prob ? b : a))
    : null;

  return {
    skew_bowley,
    tail_ratio,
    fat_tail,
    entropy,
    gini,
    dominant_bucket: dominant ? { label: dominant.label, prob: roundT3(dominant.prob) } : null,
  };
}

// ── dispersion over time ──────────────────────────────────────────────────────
function computeDispersion(iqr, priors) {
  const width = iqr.p25 != null && iqr.p75 != null ? iqr.p75 - iqr.p25 : null;
  const w7 = priors.iqr_width_7d ?? null;
  const w30 = priors.iqr_width_30d ?? null;
  const change_7d = width != null && w7 != null ? roundT3(width - w7) : null;
  const change_30d = width != null && w30 != null ? roundT3(width - w30) : null;
  // Trend keyed on the 30d change (falls back to 7d) of the 25-75 band width.
  let trend = null;
  const ref = change_30d ?? change_7d;
  if (ref != null) trend = ref < -DISPERSION_EPS ? 'converging' : ref > DISPERSION_EPS ? 'diverging' : 'stable';
  return { iqr_width: roundT3(width), width_7d: roundT3(w7), width_30d: roundT3(w30), change_7d, change_30d, trend };
}

// ── velocity (and the canonical median deltas — single source for D1) ─────────
function changeObj(now, then) {
  if (now == null || then == null) return null;
  const abs = now - then;
  return { abs: roundT(abs), dir: deltaDir(abs), display: fmtSignedDeltaT(abs) };
}
function computeVelocity(median, priors) {
  const change_24h = changeObj(median, priors.median_1d);
  const change_7d = changeObj(median, priors.median_7d);
  const change_30d = changeObj(median, priors.median_30d);
  const drift_7d_annualized = change_7d ? roundT3((change_7d.abs / 7) * 365) : null;
  const drift_30d_annualized = change_30d ? roundT3((change_30d.abs / 30) * 365) : null;
  let acceleration = null;
  if (change_7d && change_30d) {
    const rate7 = change_7d.abs / 7;
    const rate30 = change_30d.abs / 30;
    acceleration =
      Math.abs(rate7) > Math.abs(rate30) + ACCEL_EPS
        ? 'accelerating'
        : Math.abs(rate7) < Math.abs(rate30) - ACCEL_EPS
          ? 'decelerating'
          : 'steady';
  }
  return { change_24h, change_7d, change_30d, drift_7d_annualized, drift_30d_annualized, acceleration };
}

// ── calibration scaffold (HONEST: pending resolution, never a faked score) ────
function computeCalibration(markets, median, asOf) {
  const probAt = (t) => { const r = markets.find((m) => m.threshold === t); return r ? r.prob : null; };
  return {
    status: 'pending_resolution',
    resolves: '2027-12-31',
    note: 'The market resolves once, at IPO close. A true calibration / Brier score is impossible before resolution; this records the standing forecast so it can be scored when the outcome is known. No score is computed now.',
    standing_forecast: { as_of: asOf, median: roundT(median), prob_1_8t: probAt(1.8), prob_2_0t: probAt(2.0), prob_2_4t: probAt(2.4) },
  };
}

/** Deterministic one-line descriptor from the shape + dispersion facts. */
function buildDescriptor(shape, dispersion) {
  const spread = shape.entropy == null ? 'unknown spread'
    : shape.entropy < 0.5 ? 'tight consensus' : shape.entropy < 0.78 ? 'moderate dispersion' : 'wide dispersion';
  const skew = shape.skew_bowley == null ? null
    : shape.skew_bowley > 0.1 ? 'right-skewed (upside tail)' : shape.skew_bowley < -0.1 ? 'left-skewed (downside tail)' : 'roughly symmetric';
  const fat = shape.fat_tail != null && shape.fat_tail > 1.1 ? 'fat-tailed' : null;
  const dom = shape.dominant_bucket ? `mass centred on ${shape.dominant_bucket.label}` : null;
  const trend = dispersion.trend ? `band ${dispersion.trend}` : null;
  return [spread, skew, fat, dom, trend].filter(Boolean).join('; ') + '.';
}

/**
 * Build derived.market.analytics. Pure.
 *   markets : adjusted markets, iqr/median : current scalars
 *   priors  : { median_1d, median_7d, median_30d, iqr_width_7d, iqr_width_30d }
 *   asOf    : snapshot date (for the standing forecast)
 */
export function buildAnalytics({ markets, iqr, median, priors = {}, asOf = null }) {
  const shape = computeShape(markets, iqr, median);
  const dispersion = computeDispersion(iqr, priors);
  const velocity = computeVelocity(median, priors);
  const calibration = computeCalibration(markets, median, asOf);
  const descriptor = buildDescriptor(shape, dispersion);
  return { shape, dispersion, velocity, calibration, descriptor };
}

/** 3-dp round for unitless analytics scalars (skew, entropy, ratios). */
function roundT3(x) {
  if (x == null || !Number.isFinite(x)) return null;
  return Math.round(x * 1000) / 1000;
}
