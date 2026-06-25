// test/seed-history-fixture.test.js — verifies the Phase 3 dev fixture (scripts/seed-history-dev)
// produces the exact display states + Δ/mover values the operator's Playwright gate asserts,
// WITHOUT a database. It feeds the SAME pure history rows the seed upserts through the SAME
// derive functions the detail view uses (deriveVelocity/Dispersion/Deltas/BiggestMoves), so the
// fixture math is proven offline and can't silently drift from the gate expectations.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveVelocity, deriveDispersion, deriveDeltas, deriveBiggestMoves } from '../lib/market-history.mjs';
import {
  ladderHistoryRows, binaryHistoryRows, THRESHOLDS, SLOPE, TODAY_P,
} from '../scripts/seed-history-dev.mjs';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// ── FULL ladder (31 rows) → velocity ok, dispersion ok, Δ at all horizons, movers over 30d ──
test('FULL ladder fixture: velocity is "ok" and rising', () => {
  const v = deriveVelocity(ladderHistoryRows('full', 31));
  assert.equal(v.status, 'ok');
  assert.equal(v.trend, 'rising');
  assert.equal(v.days_have, 31);
});

test('FULL ladder fixture: dispersion is "ok" and converging', () => {
  const d = deriveDispersion(ladderHistoryRows('full', 31));
  assert.equal(d.status, 'ok');
  assert.equal(d.direction, 'converging'); // IQR width narrows 0.50 → ~0.30
  assert.ok(d.change_pct < 0);
});

test('FULL ladder fixture: per-threshold Δ equals slope·days exactly (the table values)', () => {
  const rows = ladderHistoryRows('full', 31);
  const deltas = deriveDeltas(rows, THRESHOLDS);
  const at = (t) => deltas.find((r) => r.threshold === t);
  for (let k = 0; k < THRESHOLDS.length; k++) {
    const row = at(THRESHOLDS[k]);
    close(row.d1, SLOPE[k] * 1);
    close(row.d7, SLOPE[k] * 7);
    close(row.d30, SLOPE[k] * 30);
  }
  // The >$2T row is the showcase: +1.0 / +7.0 / +30.0 percentage points.
  close(at(2).d1, 0.01); close(at(2).d7, 0.07); close(at(2).d30, 0.30);
});

test('FULL ladder fixture: biggest movers (30d) rank >$2T, >$2.5T, >$3T', () => {
  const moves = deriveBiggestMoves(ladderHistoryRows('full', 31), 30);
  assert.equal(moves.kind, 'ladder');
  assert.equal(moves.movers.length, 3);
  assert.deepEqual(moves.movers.map((m) => m.threshold), [2, 2.5, 3]);
  assert.equal(moves.movers[0].direction, 'up');
  close(moves.movers[0].change, 0.30); // >$2T moved +30pp
  // start → end on the top mover: 40% → 70%.
  close(moves.movers[0].start, TODAY_P[2] - SLOPE[2] * 30);
  close(moves.movers[0].end, TODAY_P[2]);
});

// ── VELOCITY-ONLY ladder (18 rows) → velocity ok, dispersion collecting, Δ30d null ─────────
test('VELOCITY-ONLY ladder fixture: velocity ok, dispersion still collecting (18/30)', () => {
  const rows = ladderHistoryRows('vel', 18);
  assert.equal(deriveVelocity(rows).status, 'ok');
  const d = deriveDispersion(rows);
  assert.equal(d.status, 'collecting');
  assert.equal(d.days_have, 18);
  assert.equal(d.days_needed, 30);
});

test('VELOCITY-ONLY ladder fixture: Δ 24h+7d present, 30d is null (no day 30 back)', () => {
  const row = deriveDeltas(ladderHistoryRows('vel', 18), THRESHOLDS).find((r) => r.threshold === 2);
  close(row.d1, 0.01);
  close(row.d7, 0.07);
  assert.equal(row.d30, null);
});

// ── COLLECTING ladder (4 rows) → velocity & dispersion both collecting, only Δ24h present ──
test('COLLECTING ladder fixture: velocity and dispersion both collecting', () => {
  const rows = ladderHistoryRows('coll', 4);
  const v = deriveVelocity(rows);
  assert.equal(v.status, 'collecting');
  assert.equal(v.days_have, 4);
  assert.equal(v.days_needed, 7);
  assert.equal(deriveDispersion(rows).status, 'collecting');
});

test('COLLECTING ladder fixture: only the 24h Δ is present; 7d/30d null', () => {
  const row = deriveDeltas(ladderHistoryRows('coll', 4), THRESHOLDS).find((r) => r.threshold === 2);
  close(row.d1, 0.01);
  assert.equal(row.d7, null);
  assert.equal(row.d30, null);
});

// ── BINARY (31 rows) → velocity ok & rising, dispersion not_applicable ─────────────────────
test('BINARY fixture: velocity ok & rising on the YES probability; dispersion n/a', () => {
  const rows = binaryHistoryRows('bin', 31);
  const v = deriveVelocity(rows);
  assert.equal(v.status, 'ok');
  assert.equal(v.kind, 'binary');
  assert.equal(v.trend, 'rising'); // 0.30 → 0.60
  assert.equal(deriveDispersion(rows).status, 'not_applicable');
});

test('BINARY fixture: biggest move is the net YES swing (+30pp over 30d)', () => {
  const moves = deriveBiggestMoves(binaryHistoryRows('bin', 31), 30);
  assert.equal(moves.kind, 'binary');
  close(moves.change, 0.30);
  assert.equal(moves.direction, 'up');
});
