// Bug 3 foundation: NEAR SETTLEMENT detection. A market expiring within 7 days whose
// rungs are mostly pinned to 0/1 (the outcome is essentially decided) is in a distinct
// state — its large monotonicity adjustments are EXPECTED, not noise, and it should show an
// amber "NEAR SETTLEMENT" badge rather than be scored/labelled like a live, uncertain market.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearSettlement } from '../core/confidence.js';

const rungs = (...probs) => probs.map((p) => ({ adjusted_prob: p }));

test('near settlement: expiring ≤7d AND >50% rungs pinned to ~0/~1', () => {
  // 8 of 10 rungs extreme (≤0.01 or ≥0.99), expiry in 3 days
  const m = rungs(0.999, 0.998, 0.995, 0.99, 0.6, 0.4, 0.005, 0.003, 0.001, 0.0005);
  assert.equal(nearSettlement(m, 3), true);
});

test('NOT near settlement: same pinned rungs but expiry far out (>7d)', () => {
  const m = rungs(0.999, 0.998, 0.995, 0.99, 0.6, 0.4, 0.005, 0.003, 0.001, 0.0005);
  assert.equal(nearSettlement(m, 30), false);
});

test('NOT near settlement: expiring soon but rungs still uncertain (mid-range)', () => {
  const m = rungs(0.8, 0.7, 0.6, 0.55, 0.45, 0.4, 0.3, 0.2);
  assert.equal(nearSettlement(m, 2), false);
});

test('NOT near settlement: exactly 50% extreme is not a majority', () => {
  const m = rungs(0.999, 0.998, 0.001, 0.002, 0.5, 0.5, 0.4, 0.6); // 4/8 extreme
  assert.equal(nearSettlement(m, 1), false);
});

test('null/unknown expiry → not near settlement (no false badge)', () => {
  const m = rungs(0.999, 0.001, 0.999, 0.001);
  assert.equal(nearSettlement(m, null), false);
});
