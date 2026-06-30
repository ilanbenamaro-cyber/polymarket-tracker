// test/time-to-expiry.test.js — Increment 3: time-to-expiry normalized confidence.
//
// A wide bid/ask spread near expiry is market-makers exiting (expected), not illiquidity; the same
// spread months out is genuine illiquidity. We widen the spread tolerance as expiry approaches, so
// the SAME spread reads differently by horizon. days-to-expiry itself is computed display-side (never
// stored in derived — the frozen SpaceX block is byte-identical; the parity gate covers that).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spreadToleranceMultiplier, expiryNote, daysUntil, scoreConfidence } from '../core/confidence.js';
import { daysToExpiryLabel } from '../lib/format-detail.mjs';

// ── spreadToleranceMultiplier (the horizon bands) ────────────────────────────
test('spreadToleranceMultiplier: widens as expiry approaches, never tightens', () => {
  assert.equal(spreadToleranceMultiplier(null), 1.0);   // unknown → standard
  assert.equal(spreadToleranceMultiplier(550), 1.0);    // SpaceX-far → standard (parity-safe)
  assert.equal(spreadToleranceMultiplier(91), 1.0);
  assert.equal(spreadToleranceMultiplier(90), 1.5);     // 30–90
  assert.equal(spreadToleranceMultiplier(31), 1.5);
  assert.equal(spreadToleranceMultiplier(30), 2.5);     // 7–30
  assert.equal(spreadToleranceMultiplier(7), 2.5);
  assert.equal(spreadToleranceMultiplier(3), 2.5);      // <7 (near-settlement handles pinned rungs on top)
});

test('expiryNote / daysUntil', () => {
  assert.equal(expiryNote(12), ' — 12d remaining');
  assert.equal(expiryNote(null), '');
  assert.ok(Math.abs(daysUntil('2026-01-31', '2026-01-01T00:00:00Z') - 30) < 1e-9);
  assert.equal(daysUntil(null, '2026-01-01T00:00:00Z'), null);
});

// ── daysToExpiryLabel (display-side header label) ────────────────────────────
test('daysToExpiryLabel: future → "Nd to expiry", today → "expires today", past/null → null', () => {
  const now = '2026-06-29T12:00:00Z';
  assert.equal(daysToExpiryLabel('2026-07-11', now), '12d to expiry');
  assert.equal(daysToExpiryLabel('2026-06-29', now), 'expires today');
  assert.equal(daysToExpiryLabel('2026-06-01', now), null); // already past
  assert.equal(daysToExpiryLabel(null, now), null);
});

// ── scoreConfidence: the SAME spread reads differently by horizon ────────────
function ladder(n) { return Array.from({ length: n }, (_, i) => ({ threshold: i, prob: 0.5, adjusted_prob: 0.5 })); }
// an 18% spread on every rung
const wideSpread = ladder(16).map(() => ({ best_bid: '0.41', best_ask: '0.59' }));

test('scoreConfidence: an 18% spread is ILLIQUID far from expiry but EXPECTED near it', () => {
  const far = scoreConfidence({ markets: ladder(16), rawInputs: wideSpread, daysToExpiry: 180 });
  const near = scoreConfidence({ markets: ladder(16), rawInputs: wideSpread, daysToExpiry: 12 });
  // Spread drives RELIABILITY (how well-defined the displayed price is).
  // far out: 18% > 8% standard medium → LOW, illiquid
  assert.equal(far.reliability.tier, 'low');
  assert.ok(far.reliability.reasons.some((r) => /illiquid — 180d remaining/.test(r)));
  // near expiry (×2.5 → medium band is 20%): 18% ≤ 20% → MEDIUM, "expected near expiry"
  assert.equal(near.reliability.tier, 'medium');
  assert.ok(near.reliability.reasons.some((r) => /expected near expiry — 12d remaining/.test(r)));
});

test('scoreConfidence: a far-dated market with no daysToExpiry is unchanged (SpaceX parity safety)', () => {
  const base = { markets: ladder(16), rawInputs: ladder(16).map(() => ({ best_bid: '0.49', best_ask: '0.51' })) };
  assert.deepEqual(scoreConfidence({ ...base, daysToExpiry: 550 }), scoreConfidence({ ...base }));
});
