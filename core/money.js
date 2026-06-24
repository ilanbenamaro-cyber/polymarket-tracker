// core/money.js — unit-aware money parsing + display-scale derivation.
//
// Why this exists: the legacy threshold parser `\$(\d+\.?\d*)` captured only the bare
// mantissa — it dropped thousands-commas ("$56,000" → 56) and unit suffixes ("$53.58K"
// → 53.58), and the display layer only recognized T/B/M so everything else fell back to
// "T" (Bug 1). parseMoney normalizes ANY label to absolute dollars; deriveUnit then picks
// one display scale (T/B/M/K/$) from the absolute ladder so a market reads in its own
// denomination. Pure + dependency-free: imported by core/fetch.js (compute time, to set a
// market's stored unit) and the display layer. NEVER applied to SpaceX (its pinned config
// keeps the mantissa-only pattern → frozen hash byte-identical). See MARKET-TYPES-PLAN.md.

const SUFFIX_FACTOR = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

// $ then a comma-grouped number, optional decimals, with the unit letter IMMEDIATELY
// adjacent (no whitespace) — adjacency avoids matching a following word like "$90 by
// June" as 90·B. Matches the FIRST money token in the string.
const MONEY_RE = /\$\s?([\d,]+(?:\.\d+)?)([KMBT])?/i;

/** First "$…" money token in a string → { value (absolute dollars), unit } or null.
 *  null when the string carries no $ amount (e.g. a "not IPO" categorical leg). */
export function parseMoney(str) {
  if (str == null) return null;
  const m = String(str).match(MONEY_RE);
  if (!m) return null;
  const mantissa = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(mantissa)) return null;
  const unit = m[2] ? m[2].toUpperCase() : '';
  return { value: unit ? mantissa * SUFFIX_FACTOR[unit] : mantissa, unit };
}

/** Pick the display scale for a ladder from its absolute-dollar values.
 *  → { unit: 'T'|'B'|'M'|'K'|'', divisor }. '' (divisor 1) for sub-$1,000 ladders. */
export function deriveUnit(values) {
  const finite = (values || []).map((v) => Math.abs(Number(v))).filter(Number.isFinite);
  const max = finite.length ? Math.max(...finite) : 0;
  if (max >= 1e12) return { unit: 'T', divisor: 1e12 };
  if (max >= 1e9) return { unit: 'B', divisor: 1e9 };
  if (max >= 1e6) return { unit: 'M', divisor: 1e6 };
  if (max >= 1e3) return { unit: 'K', divisor: 1e3 };
  return { unit: '', divisor: 1 };
}

/** Absolute-dollar value → "$1.84T" / "$53.58K" / "$90.00" using a deriveUnit() result. */
export function fmtScaled(value, { unit, divisor }) {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `$${(value / divisor).toFixed(2)}${unit}`;
}
