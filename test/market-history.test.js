// test/market-history.test.js — unit coverage for the Phase 1 history analytics.
//
// These exercise the PURE derive functions of lib/market-history.mjs (no DB), the
// same pattern as market-scan.test.js covering assembleScanRows. The DB I/O paths
// (readHistory/writeHistory/allWatchedMarketIds) are exercised by the live gate
// (scripts/verify-history.mjs), not here. The contract under test: velocity needs
// ≥7 days, dispersion needs ≥30, both return an explicit "collecting" state (never
// dashes), and deltas/biggest-moves read per-threshold survival probs from the
// stored record JSONB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linregSlope, headlineValue,
  deriveVelocity, deriveDispersion, deriveDeltas, deriveBiggestMoves,
  MIN_VELOCITY_DAYS, MIN_DISPERSION_DAYS,
} from '../lib/market-history.mjs';

// ── fixture helpers ──────────────────────────────────────────────────────────
const dayMs = 86_400_000;
const dateAt = (i) => new Date(i * dayMs).toISOString().slice(0, 10); // day-index → YYYY-MM-DD

/** One history row. `markets` = [{threshold,prob}] and `iqr` go into the record JSONB. */
function mkRow(dayIdx, { kind = 'survival', median = null, probability = null,
  touchLo = null, touchHi = null, markets = null, iqr = null } = {}) {
  const derived = {};
  if (markets) derived.markets = markets;
  if (iqr) derived.iqr = iqr;
  return {
    snapshot_date: dateAt(dayIdx),
    kind,
    implied_median: median,
    probability,
    touch_range_lo: touchLo,
    touch_range_hi: touchHi,
    record: { snapshot: { derived } },
  };
}

// ── linregSlope ──────────────────────────────────────────────────────────────
test('linregSlope: slope of a straight line y = 2x + 1', () => {
  assert.equal(linregSlope([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }]), 2);
});

test('linregSlope: null when fewer than two points', () => {
  assert.equal(linregSlope([{ x: 0, y: 1 }]), null);
  assert.equal(linregSlope([]), null);
});

test('linregSlope: null when all x are identical (no horizontal span)', () => {
  assert.equal(linregSlope([{ x: 5, y: 1 }, { x: 5, y: 9 }]), null);
});

// ── headlineValue ────────────────────────────────────────────────────────────
test('headlineValue: survival/bucket use implied_median, binary uses probability, touch uses range midpoint', () => {
  assert.equal(headlineValue(mkRow(0, { kind: 'survival', median: 60 })), 60);
  assert.equal(headlineValue(mkRow(0, { kind: 'bucket_pmf', median: 61.1 })), 61.1);
  assert.equal(headlineValue(mkRow(0, { kind: 'binary', probability: 0.42 })), 0.42);
  assert.equal(headlineValue(mkRow(0, { kind: 'directional_touch', touchLo: 66, touchHi: 90 })), 78);
});

test('headlineValue: touch midpoint is null when a bound is missing', () => {
  assert.equal(headlineValue(mkRow(0, { kind: 'directional_touch', touchLo: 66, touchHi: null })), null);
});

// ── deriveVelocity ───────────────────────────────────────────────────────────
test('deriveVelocity: collecting state when fewer than 7 days', () => {
  const hist = [0, 1, 2, 3, 4].map((i) => mkRow(i, { median: 60 }));
  const v = deriveVelocity(hist);
  assert.equal(v.status, 'collecting');
  assert.equal(v.days_needed, MIN_VELOCITY_DAYS);
  assert.equal(v.days_have, 5);
});

test('deriveVelocity: rising binary series → trend rising, positive slope', () => {
  // 0.30 → 0.50 over 7 days
  const hist = [0, 1, 2, 3, 4, 5, 6].map((i) => mkRow(i, { kind: 'binary', probability: 0.30 + i * (0.20 / 6) }));
  const v = deriveVelocity(hist);
  assert.equal(v.status, 'ok');
  assert.equal(v.trend, 'rising');
  assert.ok(v.slope > 0);
});

test('deriveVelocity: flat series → trend steady', () => {
  const hist = [0, 1, 2, 3, 4, 5, 6].map((i) => mkRow(i, { median: 60 }));
  const v = deriveVelocity(hist);
  assert.equal(v.status, 'ok');
  assert.equal(v.trend, 'steady');
});

test('deriveVelocity: falling median series → trend falling, negative slope', () => {
  const hist = [0, 1, 2, 3, 4, 5, 6].map((i) => mkRow(i, { median: 66 - i }));
  const v = deriveVelocity(hist);
  assert.equal(v.status, 'ok');
  assert.equal(v.trend, 'falling');
  assert.ok(v.slope < 0);
});

test('deriveVelocity: touch market drives velocity off the range midpoint', () => {
  // midpoint 70 → 80 (lo fixed, hi rising)
  const hist = [0, 1, 2, 3, 4, 5, 6].map((i) => mkRow(i, { kind: 'directional_touch', touchLo: 60, touchHi: 80 + i * (20 / 6) }));
  const v = deriveVelocity(hist);
  assert.equal(v.status, 'ok');
  assert.equal(v.trend, 'rising');
});

// ── deriveDispersion ─────────────────────────────────────────────────────────
test('deriveDispersion: collecting when fewer than 30 days', () => {
  const hist = [0, 1, 2].map((i) => mkRow(i, { median: 60, iqr: { p25: 50, p75: 70 } }));
  const d = deriveDispersion(hist);
  assert.equal(d.status, 'collecting');
  assert.equal(d.days_needed, MIN_DISPERSION_DAYS);
});

test('deriveDispersion: not applicable for binary / touch markets', () => {
  const hist = Array.from({ length: 31 }, (_, i) => mkRow(i, { kind: 'binary', probability: 0.5 }));
  assert.equal(deriveDispersion(hist).status, 'not_applicable');
});

test('deriveDispersion: narrowing IQR over ≥30 days → converging', () => {
  // width 40 → 10 over 31 days
  const hist = Array.from({ length: 31 }, (_, i) => {
    const half = (20 - i * (15 / 30)) / 1; // p75-p25 shrinks 40→10
    return mkRow(i, { median: 60, iqr: { p25: 60 - half, p75: 60 + half } });
  });
  const d = deriveDispersion(hist);
  assert.equal(d.status, 'ok');
  assert.equal(d.direction, 'converging');
  assert.ok(d.change_pct < 0);
});

test('deriveDispersion: widening IQR over ≥30 days → diverging', () => {
  const hist = Array.from({ length: 31 }, (_, i) => {
    const half = (5 + i * (15 / 30)); // width 10 → 40
    return mkRow(i, { median: 60, iqr: { p25: 60 - half, p75: 60 + half } });
  });
  const d = deriveDispersion(hist);
  assert.equal(d.status, 'ok');
  assert.equal(d.direction, 'diverging');
  assert.ok(d.change_pct > 0);
});

// ── deriveDeltas ─────────────────────────────────────────────────────────────
test('deriveDeltas: per-threshold P(>X) change at 1d / 7d / 30d horizons', () => {
  // prob at 1.8 climbs 0.50 + 0.01*idx over 31 days; today idx30 = 0.80
  const hist = Array.from({ length: 31 }, (_, i) =>
    mkRow(i, { median: 60, markets: [{ threshold: 1.8, prob: 0.50 + i * 0.01 }] }));
  const deltas = deriveDeltas(hist, [1.8]);
  const row = deltas.find((r) => r.threshold === 1.8);
  assert.ok(Math.abs(row.d1 - 0.01) < 1e-9); // 0.80 - 0.79
  assert.ok(Math.abs(row.d7 - 0.07) < 1e-9); // 0.80 - 0.73
  assert.ok(Math.abs(row.d30 - 0.30) < 1e-9); // 0.80 - 0.50
});

test('deriveDeltas: horizon with no matching day is null, not fabricated', () => {
  const hist = [0, 1, 2].map((i) => mkRow(i, { markets: [{ threshold: 2.0, prob: 0.4 + i * 0.01 }] }));
  const row = deriveDeltas(hist, [2.0]).find((r) => r.threshold === 2.0);
  assert.ok(Math.abs(row.d1 - 0.01) < 1e-9);
  assert.equal(row.d7, null);
  assert.equal(row.d30, null);
});

// ── deriveBiggestMoves ───────────────────────────────────────────────────────
test('deriveBiggestMoves: top movers ranked by absolute change (survival ladder)', () => {
  const hist = Array.from({ length: 31 }, (_, i) => mkRow(i, {
    markets: [
      { threshold: 1.8, prob: 0.50 + i * (0.30 / 30) }, // +0.30
      { threshold: 2.0, prob: 0.40 + i * (0.05 / 30) }, // +0.05
      { threshold: 2.4, prob: 0.30 - i * (0.20 / 30) }, // -0.20
    ],
  }));
  const moves = deriveBiggestMoves(hist, 30);
  assert.equal(moves.kind, 'ladder');
  assert.equal(moves.movers.length, 3);
  assert.equal(moves.movers[0].threshold, 1.8);
  assert.equal(moves.movers[1].threshold, 2.4);
  assert.equal(moves.movers[2].threshold, 2.0);
  assert.equal(moves.movers[0].direction, 'up');
  assert.equal(moves.movers[1].direction, 'down');
});

test('deriveBiggestMoves: binary reports the max probability swing', () => {
  const hist = Array.from({ length: 31 }, (_, i) => mkRow(i, { kind: 'binary', probability: 0.20 + i * (0.40 / 30) }));
  const moves = deriveBiggestMoves(hist, 30);
  assert.equal(moves.kind, 'binary');
  assert.ok(Math.abs(moves.change - 0.40) < 1e-9);
  assert.equal(moves.direction, 'up');
});
