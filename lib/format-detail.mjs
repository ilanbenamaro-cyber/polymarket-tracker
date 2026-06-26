// lib/format-detail.mjs — unit-aware money formatting for the 2c.3 detail view.
//
// Why: core/format.fmtT hardcodes "$X.XXT", which is correct for SpaceX (a cap-in-
// trillions ladder) but WRONG for a generalized ladder denominated in billions
// (Kraken IPO ">$28B") or millions. The ladder LABELS already carry the right
// denomination (the suffix letter), so we derive the scale from them and format the
// headline median/mean/ranges to match — the detail reads naturally for ANY market.
// Pure + server-side (the detail formats before render); unit-tested for T/B/M.
//
// Scope: this covers the numbers the detail formats itself (median/mean/iqr/ranges).
// The stored velocity delta (`analytics.velocity.change_24h.display`) is rendered
// VERBATIM as core produced it — not reformatted here (single source, no drift).

const KNOWN_UNITS = new Set(['T', 'B', 'M', 'K']);

/** Derive the ladder's money unit from the first threshold label's suffix.
 *  Labels look like ">$1.8T" / "$2–2.2T" / ">$28B" / ">$500M" / ">$56K" / ">$90".
 *  The suffix must be ADJACENT to the number (so a trailing word can't be misread).
 *  Falls back to '' (DIMENSIONLESS — never $T: defaulting to T was Bug 1) when the label
 *  carries no recognized suffix, so a bare-dollar ladder (WTI "$90") reads as "$90.00". */
export function unitFromLadder(markets) {
  const label = markets?.[0]?.label ?? '';
  // The LAST unit letter that immediately follows a digit (so a range label like
  // "$2–2.2T" keys off the trailing "2T", and a bare ">$90" yields no suffix).
  const matches = [...label.matchAll(/\d([TBMK])/gi)];
  const u = matches.length ? matches[matches.length - 1][1].toUpperCase() : '';
  return u && KNOWN_UNITS.has(u) ? u : '';
}

/** "$2.10T" / "$28.00B" / "n/a". `unit` from unitFromLadder. */
export function fmtMoney(value, unit) {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `$${value.toFixed(2)}${unit}`;
}

/** "$2.05–$2.15T" from a {low, high} range object, or null when absent/degenerate. */
export function fmtRange(o, unit) {
  if (!o || o.low == null || o.high == null) return null;
  return `$${o.low.toFixed(2)}–$${o.high.toFixed(2)}${unit}`;
}

/**
 * Bug 5: the headline median label. When the adjusted CDF crosses 50% we show the value;
 * when it never does (the median falls OUTSIDE the quoted strike ladder) we say so honestly
 * — "< $lowest" / "> $highest" — instead of a bare "n/a" (mirrors touch boundLabel). The CDF
 * is P(value > X), decreasing: P(>highest) ≥ 0.5 ⇒ median above the top strike; P(>lowest)
 * < 0.5 ⇒ median below the bottom strike.
 */
export function impliedMedianLabel(markets, impliedMedian, unit) {
  if (impliedMedian != null && Number.isFinite(impliedMedian)) return fmtMoney(impliedMedian, unit);
  if (!Array.isArray(markets) || markets.length === 0) return 'n/a';
  const lo = markets[0], hi = markets[markets.length - 1];
  const pHi = hi.adjusted_prob ?? hi.prob;
  const pLo = lo.adjusted_prob ?? lo.prob;
  if (pHi != null && pHi >= 0.5) return `> $${hi.threshold}${unit}`;
  if (pLo != null && pLo < 0.5) return `< $${lo.threshold}${unit}`;
  return 'n/a';
}

/** Enh 5: a compact human-readable dollar volume ($3.5M / $820K / $1.2B / $42). */
export function fmtVolHuman(v) {
  if (v == null || !Number.isFinite(v)) return '';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}

/**
 * Phase 3: a per-threshold survival-probability change (deriveDeltas' d1/d7/d30, a value in
 * [-1,1]) as signed percentage points — "+7.0" / "-20.3" / "0.0". A null/NaN horizon (no
 * matching day in the series) renders as an em dash, NEVER a fabricated 0 (the never-dashes
 * rule cuts the other way here: a real "no data" must be visibly absent, not a false zero).
 */
export function fmtDeltaPp(delta) {
  if (delta == null || !Number.isFinite(delta)) return '—';
  const pp = delta * 100;
  if (pp === 0) return '0.0';
  return `${pp > 0 ? '+' : ''}${pp.toFixed(1)}`;
}

/** Phase 3: the colour class for a delta — 'is-up' / 'is-down' / '' — with a 0.05pp deadband
 *  so sub-tenth-of-a-point noise reads neutral rather than flickering green/red. */
export function deltaSign(delta) {
  if (delta == null || !Number.isFinite(delta)) return '';
  if (delta > 0.0005) return 'is-up';
  if (delta < -0.0005) return 'is-down';
  return '';
}

/**
 * v1 ITEM 3: how much to trust the implied mean at a glance, from |mean − median|. The mean is a
 * bucket-weighted EV with tail-midpoint assumptions; when it sits on top of the median the tails
 * don't move it (trust it), when it diverges, outlier rungs are pulling it (trust it less).
 *   < 0.5% of |median| → "tail-insensitive (≈0)"
 *   > 5%               → "tail-sensitive (+$X) — outlier rungs present"
 *   else               → "tail-insensitive (+$X)"
 */
export function meanRobustnessLabel(mean, median, unit) {
  if (mean == null || median == null || !Number.isFinite(mean) || !Number.isFinite(median)) return '';
  const diff = Math.abs(mean - median);
  const rel = Math.abs(median) > 1e-9 ? diff / Math.abs(median) : 0;
  if (rel < 0.005) return 'tail-insensitive (≈0)';
  const amt = `+$${diff.toFixed(2)}${unit}`;
  return rel > 0.05 ? `tail-sensitive (${amt}) — outlier rungs present` : `tail-insensitive (${amt})`;
}

/** v1 ITEM 1: the largest single concentration of probability — the density bucket with the most
 *  mass — as { prob, label } (label = density-panel style: "$A–$B" / "<$A" / ">$A"). Null on empty. */
export function modeBucket(markets, unit) {
  if (!Array.isArray(markets) || markets.length === 0) return null;
  const buckets = [{ prob: Math.max(0, 1 - (markets[0].adjusted_prob ?? markets[0].prob ?? 0)), label: `<$${markets[0].threshold}${unit}` }];
  for (let i = 0; i < markets.length; i++) {
    const lo = markets[i].threshold, hi = markets[i + 1]?.threshold;
    buckets.push({ prob: markets[i].bucket_prob ?? 0, label: hi != null ? `$${lo}–${hi}${unit}` : `>$${lo}${unit}` });
  }
  return buckets.reduce((top, b) => (b.prob > top.prob ? b : top), buckets[0]);
}

/**
 * v1 ITEM 1: the deterministic detail narrative — current median (+ 30d/7d change when history
 * exists) + the mode bucket + the 25–75% band direction (when ≥30d) + confidence — one paragraph.
 * Display-only (built from the stored derived block + history-derived scalars; the pipeline's own
 * stored narrative is unchanged). Δ/band sentences are OMITTED, not dashed, when history is absent
 * — never "—" in prose.
 *   medianLabel   already-formatted headline (e.g. "$2.10T" / "> $1.4T")
 *   change30/7    signed headline change over the window in `unit`, or null (no history)
 *   mode          { prob, label } from modeBucket, or null
 *   bandDirection 'narrowing' | 'widening' | 'steady' | null (null when <30d history)
 *   confidenceTier 'high' | 'medium' | 'low' | null
 *
 * @param {object} o
 * @param {string} o.medianLabel
 * @param {number|null} [o.change30]
 * @param {number|null} [o.change7]
 * @param {{prob:number,label:string}|null} [o.mode]
 * @param {'narrowing'|'widening'|'steady'|null} [o.bandDirection]
 * @param {string|null} [o.confidenceTier]
 * @param {string} [o.unit]
 * @returns {string}
 */
export function detailNarrative({ medianLabel, change30 = null, change7 = null, mode = null, bandDirection = null, confidenceTier = null, unit = '' }) {
  const parts = [];
  const dir = (x) => (x < 0 ? 'down' : 'up');
  let s1 = `The market implies a median of ${medianLabel}`;
  const deltas = [];
  if (change30 != null && Number.isFinite(change30)) deltas.push(`${dir(change30)} $${Math.abs(change30).toFixed(2)}${unit} over the past month`);
  if (change7 != null && Number.isFinite(change7)) deltas.push(`${dir(change7)} $${Math.abs(change7).toFixed(2)}${unit} this week`);
  if (deltas.length) s1 += `, ${deltas.join(' and ')}`;
  parts.push(`${s1}.`);
  if (mode && mode.prob != null && mode.label) {
    parts.push(`The largest single concentration of probability (${Math.round(mode.prob * 100)}%) sits in the ${mode.label} range.`);
  }
  if (bandDirection === 'narrowing') parts.push('The 25–75% band is narrowing — the market is converging on a view.');
  else if (bandDirection === 'widening') parts.push('The 25–75% band is widening — the market is diverging on a view.');
  else if (bandDirection === 'steady') parts.push('The 25–75% band is steady — the market holds a settled view.');
  if (confidenceTier) parts.push(`Confidence is ${confidenceTier}.`);
  return parts.join(' ');
}

/** Bug 7: a human title from an event slug, used ONLY as a fallback when no gamma title is
 *  stored ("how-many-fed-rate-cuts-in-2026" → "How Many Fed Rate Cuts In 2026"). */
export function titleFromSlug(slug) {
  if (!slug || typeof slug !== 'string') return '';
  return slug.trim().split(/[-_]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Bug 7: the display title — the stored gamma name when present, else a cleaned slug. */
export function displayTitle(name, slug) {
  const n = (name ?? '').trim();
  if (n && n !== slug) return n;
  return titleFromSlug(slug) || n || (slug ?? '');
}

/**
 * Bug 6: the converged "settlement zone" of a near-settled ladder — the bucket holding the
 * most probability mass (where the value has essentially settled). Buckets mirror the density
 * panel: a '<lowest' complement, the interior $lo–$hi buckets, and a '>top' tail. Returns
 * { lo, hi, prob, kind:'below'|'between'|'above' } (lo/hi are thresholds; ±Infinity at the ends)
 * or null for an empty ladder. Pure — unit-tested; the label is formatted at the call site.
 */
export function settlementZone(markets) {
  if (!Array.isArray(markets) || markets.length === 0) return null;
  const buckets = [
    { lo: -Infinity, hi: markets[0].threshold, prob: Math.max(0, 1 - (markets[0].adjusted_prob ?? markets[0].prob ?? 0)), kind: 'below' },
  ];
  for (let i = 0; i < markets.length; i++) {
    const lo = markets[i].threshold;
    const hi = markets[i + 1]?.threshold ?? Infinity;
    buckets.push({ lo, hi, prob: markets[i].bucket_prob ?? 0, kind: hi === Infinity ? 'above' : 'between' });
  }
  return buckets.reduce((top, b) => (b.prob > top.prob ? b : top), buckets[0]);
}

/** Human label for a settlement zone in the ladder's unit: "$2.0–2.2T" / "< $1.4T" / "> $3.0T". */
export function settlementZoneLabel(zone, unit) {
  if (!zone) return 'n/a';
  if (zone.kind === 'below') return `< $${zone.hi}${unit}`;
  if (zone.kind === 'above') return `> $${zone.lo}${unit}`;
  return `$${zone.lo}–${zone.hi}${unit}`;
}

// DISPLAY-ONLY timezone: all stored values stay UTC; absolute times render in
// America/New_York. timeZoneName:'short' yields EST/EDT automatically (DST-safe — never
// hardcode a -4 offset). Built once (Intl formatters are relatively expensive).
const EASTERN = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});
/** A UTC ISO timestamp → "Jun 24, 3:42 PM EDT" in Eastern time, or "—". */
export function fmtEastern(iso) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '—';
  return EASTERN.format(new Date(t));
}
