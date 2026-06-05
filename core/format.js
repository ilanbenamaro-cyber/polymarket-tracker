// core/format.js — the ONE place trillions-valued numbers are rounded/formatted.
//
// Why this exists: defect D1 was a rounding mismatch — the narrative said a median
// move of "-$0.20T" while a card said "-$0.19T" for the same quantity, because two
// surfaces rounded independently. Every surface now formats through these helpers,
// and deltas are computed once in core (analytics.velocity) so the same stored
// number is displayed identically everywhere.

/** Round a $T value to 2 decimals, half-away-from-zero (stable, sign-symmetric). */
export function roundT(x) {
  if (x == null || !Number.isFinite(x)) return null;
  return Math.sign(x) * Math.round(Math.abs(x) * 100) / 100;
}

/** "$2.15T" (2dp) or "n/a". */
export function fmtT(x) {
  const r = roundT(x);
  return r == null ? 'n/a' : `$${r.toFixed(2)}T`;
}

/**
 * Signed delta in $T, rounded to 2dp: "+$0.05T", "-$0.20T", or "flat" when it
 * rounds to zero. This is the canonical delta string used by narrative + cards
 * + note (they all read the same stored delta value through this function).
 */
export function fmtSignedDeltaT(x) {
  const r = roundT(x);
  if (r == null) return null;
  if (r === 0) return 'flat';
  return `${r > 0 ? '+' : '-'}$${Math.abs(r).toFixed(2)}T`;
}

/** Direction word for a $T delta given a flat threshold (default $0.02T). */
export function deltaDir(x, flatEps = 0.02) {
  if (x == null) return null;
  if (x > flatEps) return 'up';
  if (x < -flatEps) return 'down';
  return 'flat';
}
