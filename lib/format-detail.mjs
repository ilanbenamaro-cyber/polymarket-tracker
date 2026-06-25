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
