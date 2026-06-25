// lib/touch-rangebar.mjs — pure geometry for the directional-touch implied-range bar.
//
// Why this exists: the lo/hi bound labels are anchored at the band's two edges. When the
// implied band is NARROW relative to the strike axis those edges nearly coincide, so the two
// labels (lo anchored start, hi anchored end) overlap and stack illegibly (Phase 4 Bug B).
// Below a width threshold we instead place the labels ABOVE and BELOW the bar at the band
// centre, so they never collide. Isolated here as a pure function so the threshold + placement
// are unit-tested without rendering SVG (TouchDetailView.tsx consumes the result verbatim).

export const RANGEBAR_W = 1000;        // viewBox width units
export const NARROW_FRAC = 0.20;       // band < 20% of the axis → stack labels (Bug B)
const Y_ABOVE = 16, Y_BELOW = 72;      // baselines above / below the bar (within the 80u viewBox)

/**
 * Layout for the implied-range bar from the bound values and the strike levels.
 *   low/high: bound values in the axis unit, or null when the 50% crossover is outside the
 *             quoted ladder (the band extends to that edge — a full-width, never-narrow band).
 *   levels:   every quoted strike level (sets the axis min/max).
 * Returns null for an empty axis; otherwise { min, max, W, bandL, bandR, narrow, lo, hi } where
 * lo/hi are { x, y, anchor } placements. When narrow, hi sits ABOVE and lo BELOW the bar (both
 * centred on the band); otherwise both sit above, lo anchored to the left edge, hi to the right.
 */
export function rangeBarLayout(low, high, levels) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  const min = Math.min(...levels), max = Math.max(...levels);
  const span = (max - min) || 1;
  const W = RANGEBAR_W;
  const x = (lvl) => ((lvl - min) / span) * W;
  const bandL = low != null ? x(low) : 0;
  const bandR = high != null ? x(high) : W;
  const narrow = (bandR - bandL) / W < NARROW_FRAC;
  const cx = (bandL + bandR) / 2;
  // Keep a centred label inside the viewport: hug the near edge when the band sits at an extreme.
  const anchorFor = (px) => (px < W * 0.15 ? 'start' : px > W * 0.85 ? 'end' : 'middle');
  const lo = narrow
    ? { x: cx, y: Y_BELOW, anchor: anchorFor(cx) }
    : { x: Math.max(0, bandL), y: Y_ABOVE, anchor: 'start' };
  const hi = narrow
    ? { x: cx, y: Y_ABOVE, anchor: anchorFor(cx) }
    : { x: Math.min(W, bandR), y: Y_ABOVE, anchor: 'end' };
  return { min, max, W, bandL, bandR, narrow, lo, hi };
}
