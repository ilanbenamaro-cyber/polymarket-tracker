// Bug 3 foundation: NEAR SETTLEMENT detection. A market expiring within 7 days whose
// rungs are mostly pinned to 0/1 (the outcome is essentially decided) is in a distinct
// state — its large monotonicity adjustments are EXPECTED, not noise, and it should show an
// amber "NEAR SETTLEMENT" badge rather than be scored/labelled like a live, uncertain market.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearSettlement, scoreConfidence } from '../core/confidence.js';
import { buildSnapshotRecord } from '../core/snapshot.js';
import { defaultConfigForLadder, labelGt } from '../core/market-config.js';
import { classifyLifecycle } from '../core/lifecycle.js';

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

// ── Bug 3: confidence recalibration (confined to the near-settlement path) ──────
// A near-settled ladder's "noise" — large monotonicity adjustments, closed rungs, last-trade
// legs — is the EXPECTED signature of a book winding down once the outcome is decided, not a
// data-quality problem. So those signals must not drag a liquid market to LOW. The carve-out
// is gated entirely on nearSettled, so a normal market (incl. frozen SpaceX) is unaffected.

const ladderInputs = (nearSettled) => ({
  // 14 thresholds, mostly pinned 0/1 (a converged ladder), tight 1pp spreads, deep books
  markets: Array.from({ length: 14 }, (_, i) => ({ threshold: i + 1, adjusted_prob: i < 7 ? 0.999 : 0.001 })),
  rawInputs: Array.from({ length: 14 }, () => ({ best_bid: '0.01', best_ask: '0.02' })),
  rawViolations: 5, maxAdjustment: 0.3, // large adjustments — would be LOW on a live ladder
  liquidity: { thinCount: 1, total: 14, thinShare: 0.07 },
  anomalies: { stale: false, closedCount: 5, liquidityDrop: null },
  midpointFallback: { lastTradeCount: 3, skippedCount: 0 },
  nearSettled,
});

test('recalibration: a near-settled liquid ladder is MEDIUM or HIGH, not LOW', () => {
  assert.notEqual(scoreConfidence(ladderInputs(true)).tier, 'low');
});

test('recalibration: identical inputs WITHOUT near-settlement are LOW (the carve-out is what lifts it)', () => {
  assert.equal(scoreConfidence(ladderInputs(false)).tier, 'low');
});

test('recalibration: near-settled reasons explain the expected artifacts (settled / near settlement)', () => {
  const c = scoreConfidence(ladderInputs(true));
  assert.ok(c.reasons.some((r) => /settl/i.test(r)), `expected a settlement reason, got: ${c.reasons.join(' | ')}`);
});

test('recalibration: a genuinely skipped rung (no price) still penalizes even near settlement', () => {
  const inp = ladderInputs(true);
  inp.midpointFallback = { lastTradeCount: 0, skippedCount: 2 }; // a real CDF hole, not an expected artifact
  assert.equal(scoreConfidence(inp).tier, 'low');
});

// ── Bug 3: ladder derived.near_settlement wiring (omit-when-false → parity-safe) ──
function buildLadder(daysOut) {
  const thresholds = Array.from({ length: 14 }, (_, i) => i + 1);
  const cfg = defaultConfigForLadder(thresholds, { id: 'x', event_slug: 'x', name: 'X', unit_prefix: '$', unit_suffix: 'B' });
  const fetched_at = new Date().toISOString();
  cfg.resolves = new Date(Date.now() + daysOut * 86_400_000).toISOString().slice(0, 10);
  const probs = thresholds.map((_, i) => (i < 7 ? 0.999 : 0.001));
  const live = {
    fetched_at, endpoints: [], raw_sha256: 'x',
    raw_inputs: thresholds.map((t, i) => ({ token_id: String(t), threshold: t, midpoint: String(probs[i]), best_bid: '0.01', best_ask: '0.02', volume: 1000 })),
    markets: thresholds.map((t, i) => ({ label: labelGt(cfg, t), threshold: t, prob: probs[i], volume: 1000 })),
  };
  const lifecycle = classifyLifecycle([{ threshold: 1, closed: false }], fetched_at);
  return buildSnapshotRecord(live, '1.4.0', { stale: false, closedCount: 0, liquidityDrop: null }, cfg, lifecycle);
}

test('wiring: a near-expiry converged ladder sets derived.near_settlement === true', () => {
  assert.equal(buildLadder(3).snapshot.derived.near_settlement, true);
});

test('wiring: a far-expiry ladder OMITS near_settlement (undefined) — derived stays byte-identical for SpaceX-like markets', () => {
  assert.equal(buildLadder(400).snapshot.derived.near_settlement, undefined);
});
