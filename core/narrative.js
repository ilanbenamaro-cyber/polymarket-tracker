// core/narrative.js — deterministic plain-English signal reading.
//
// Why this exists: compose a reproducible narrative from stored fields ONLY — no
// LLM, never asserting anything absent from narrative_components. It now reads the
// already-computed analytics (velocity deltas, shape, dispersion) so the median
// moves it states are the SAME stored numbers the cards show (fixes defect D1),
// and it softens trend claims on low-confidence days.

/** Word form of a stored velocity change object {abs, dir}: "up $0.05T" / "down $0.20T" / "flat". */
function changeWords(c, fmtV) {
  if (!c || c.abs == null) return null;
  if (c.dir === 'up') return `up ${fmtV(Math.abs(c.abs))}`;
  if (c.dir === 'down') return `down ${fmtV(Math.abs(c.abs))}`;
  return 'flat';
}

export function buildNarrative({ derived, analytics = null, prior7d = null, prior30d = null, density = [], config = null }) {
  // Subject + unit from the market config (defaults reproduce the legacy SpaceX
  // wording exactly, keeping existing records byte-identical).
  const subject = config?.narrative?.subject ?? "SpaceX's IPO-closing cap";
  const up = config?.narrative?.unit_prefix ?? '$';
  const us = config?.narrative?.unit_suffix ?? 'T';
  const fmtV = (x) => `${up}${x.toFixed(2)}${us}`;
  const median = derived.implied_median;
  // The narrative softens TREND claims on a low-trust day — that is about whether the NUMBER is
  // trustworthy, so it keys off RELIABILITY (not liquidity). For SpaceX reliability.tier === the
  // frozen single tier ('high') → byte-identical narrative.
  const tier = derived.confidence.reliability.tier;
  const velocity = analytics?.velocity ?? null;
  const shape = analytics?.shape ?? null;
  const dispersion = analytics?.dispersion ?? null;

  // Deltas come from stored velocity (single source) — falls back to priors only
  // if analytics is absent (e.g. a price-only history entry).
  const change7d = velocity?.change_7d ?? (prior7d != null && median != null ? { abs: median - prior7d, dir: median - prior7d > 0.02 ? 'up' : median - prior7d < -0.02 ? 'down' : 'flat' } : null);
  const change30d = velocity?.change_30d ?? (prior30d != null && median != null ? { abs: median - prior30d, dir: median - prior30d > 0.02 ? 'up' : median - prior30d < -0.02 ? 'down' : 'flat' } : null);

  const dominant = density.length ? density.reduce((a, b) => (b.prob > a.prob ? b : a)) : null;
  const divergence =
    change7d && change30d && change7d.dir !== 'flat' && change30d.dir !== 'flat' && change7d.dir !== change30d.dir
      ? change30d.dir === 'up' ? 'monthly climb now cooling' : 'monthly decline now rebounding'
      : null;

  // Shape / dispersion claims are gated: never tout a trend on a low-confidence day.
  const trendClaim = tier !== 'low' && dispersion?.trend && dispersion.trend !== 'stable' ? dispersion.trend : null;
  const skewClaim =
    shape?.skew_bowley == null ? null
      : shape.skew_bowley > 0.1 ? 'a longer upside tail'
      : shape.skew_bowley < -0.1 ? 'a longer downside tail'
      : null;
  const caveat = tier !== 'high' ? derived.confidence.reliability.reasons[0] : null;

  const components = {
    median_now: median,
    change_7d: change7d ? { abs: change7d.abs, dir: change7d.dir } : null,
    change_30d: change30d ? { abs: change30d.abs, dir: change30d.dir } : null,
    divergence,
    dominant_bucket: dominant ? { label: dominant.label, prob: dominant.prob } : null,
    dispersion_trend: trendClaim,
    skew: skewClaim,
    confidence_tier: tier,
    confidence_caveat: caveat,
  };

  const parts = [];
  if (median == null) {
    parts.push('The market does not cross a 50% threshold within the quoted range, so no implied median is available.');
  } else {
    let lead = `The market values ${subject} at a median ${fmtV(median)}`;
    const tail = [];
    if (change30d) tail.push(change30d.dir === 'flat' ? 'broadly flat over the past month' : `${changeWords(change30d, fmtV)} over the past month`);
    if (change7d) tail.push(change7d.dir === 'flat' ? 'flat this week' : `${changeWords(change7d, fmtV)} this week`);
    if (tail.length) lead += ', ' + tail.join(' and ');
    lead += '.';
    if (divergence) lead += ` A ${divergence}.`;
    parts.push(lead);
  }

  if (dominant) {
    parts.push(`The largest single concentration of probability (${Math.round(dominant.prob * 100)}%) sits in the ${dominant.label} range${skewClaim ? `, with ${skewClaim}` : ''}.`);
  }

  if (trendClaim) {
    parts.push(trendClaim === 'converging'
      ? 'The 25–75% band is narrowing — the market is converging on a view.'
      : 'The 25–75% band is widening — the market is growing less certain.');
  }

  parts.push(caveat ? `Confidence is ${tier}: ${caveat}.` : `Confidence is ${tier}.`);

  return { narrative: parts.join(' '), narrative_components: components };
}
