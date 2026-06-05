// core/narrative.js — deterministic plain-English signal reading.
//
// Why this exists: the page is titled "signal" but makes the generalist assemble
// the story themselves. This composes a reproducible narrative from stored fields
// ONLY — no LLM in the data path, and it never asserts anything that is not in
// narrative_components. Same inputs → same sentence, every time.

const FLAT_EPS = 0.02; // |Δ median| below $0.02T reads as "broadly flat"

function signedT(d) {
  const a = Math.abs(d).toFixed(2);
  return d > 0 ? `up $${a}T` : d < 0 ? `down $${a}T` : `flat`;
}
function dir(d) {
  if (d == null) return null;
  if (d > FLAT_EPS) return 'up';
  if (d < -FLAT_EPS) return 'down';
  return 'flat';
}

/**
 * Build the narrative + its structured components.
 *   derived   : the snapshot's derived block (implied_median, confidence, ...)
 *   prior7d   : implied_median 7 days ago (or null)
 *   prior30d  : implied_median 30 days ago (or null)
 *   density   : Array<{label, prob}> incl. the "<lowest" bucket (max => dominant)
 * Returns { narrative, narrative_components }.
 */
export function buildNarrative({ derived, prior7d = null, prior30d = null, density = [] }) {
  const median = derived.implied_median;
  const change7d = prior7d != null && median != null ? median - prior7d : null;
  const change30d = prior30d != null && median != null ? median - prior30d : null;

  const dominant =
    density.length > 0
      ? density.reduce((a, b) => (b.prob > a.prob ? b : a))
      : null;

  const dir7 = dir(change7d);
  const dir30 = dir(change30d);
  const divergence =
    dir7 && dir30 && dir7 !== 'flat' && dir30 !== 'flat' && dir7 !== dir30
      ? dir30 === 'up'
        ? 'monthly climb now cooling'
        : 'monthly decline now rebounding'
      : null;

  const tier = derived.confidence.tier;
  const caveat = tier !== 'high' ? derived.confidence.reasons[0] : null;

  const components = {
    median_now: median,
    change_7d: change7d == null ? null : { abs: change7d, dir: dir7 },
    change_30d: change30d == null ? null : { abs: change30d, dir: dir30 },
    divergence,
    dominant_bucket: dominant ? { label: dominant.label, prob: dominant.prob } : null,
    confidence_tier: tier,
    confidence_caveat: caveat,
  };

  // ── assemble the sentence; every clause maps to a component above ──
  const parts = [];
  if (median == null) {
    parts.push(
      `The market does not cross a 50% threshold within the quoted range, so no implied median is available.`
    );
  } else {
    let lead = `The market values SpaceX's IPO-closing cap at a median $${median.toFixed(2)}T`;
    const tail = [];
    if (change30d != null)
      tail.push(dir30 === 'flat' ? 'broadly flat over the past month' : `${signedT(change30d)} over the past month`);
    if (change7d != null)
      tail.push(dir7 === 'flat' ? 'flat this week' : `${signedT(change7d)} this week`);
    if (tail.length) lead += ', ' + tail.join(' and ');
    lead += '.';
    if (divergence) lead += ` A ${divergence}.`;
    parts.push(lead);
  }

  if (dominant) {
    parts.push(
      `The largest single concentration of probability (${Math.round(dominant.prob * 100)}%) sits in the ${dominant.label} range.`
    );
  }

  parts.push(
    caveat
      ? `Confidence is ${tier}: ${caveat}.`
      : `Confidence is ${tier}.`
  );

  return { narrative: parts.join(' '), narrative_components: components };
}
