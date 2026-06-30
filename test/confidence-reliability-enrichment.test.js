// test/confidence-reliability-enrichment.test.js — Increment B: consensus/decisiveness → RELIABILITY.
//
// A strong-consensus market's HEADLINE number is reliable even when its long-tail legs have wider
// books (the CT-Governor reliability half). So low entropy (categorical) / extreme probability
// (binary) LIFTS a spread-driven 'medium' reliability to 'high' — but never overrides a genuine
// defect (a truly illiquid >8% book, a missing/last-trade outcome). Liquidity is untouched (still
// volume-driven). SpaceX is a ladder → unaffected (parity gate stays green, checked separately).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCategoricalConfidence } from '../core/categorical.js';
import { scoreBinaryConfidence } from '../core/binary.js';

// Averaged-medium-spread legs: a tight leader book + wide tail-leg books → mean spread in the 4–8%
// 'medium' band (the CT shape — the leader is decisive, the long tail is thin).
const mediumSpreadLegs = [
  { best_bid: '0.97', best_ask: '0.98' }, // tight leader
  { best_bid: '0.005', best_ask: '0.075' }, // wide tail (7pp)
];

// ── categorical: entropy → reliability ───────────────────────────────────────
test('categorical: strong consensus (low entropy) lifts a medium-spread reliability to HIGH', () => {
  const weak = scoreCategoricalConfidence({ rawInputs: mediumSpreadLegs, totalVolume: 500, entropy: 0.85, dominantProb: 0.45 });
  const strong = scoreCategoricalConfidence({ rawInputs: mediumSpreadLegs, totalVolume: 500, entropy: 0.12, dominantProb: 0.98 });
  assert.equal(weak.reliability.tier, 'medium', 'contested field: spread medium stays medium');
  assert.equal(strong.reliability.tier, 'high', 'strong consensus lifts the medium to high');
  assert.ok(strong.reliability.reasons.some((r) => /strong consensus/.test(r)));
  // Liquidity is untouched by consensus — still thin-volume LOW in both.
  assert.equal(strong.liquidity.tier, 'low');
  assert.equal(weak.liquidity.tier, 'low');
});

test('categorical: consensus does NOT override a genuinely illiquid (>8%) book', () => {
  const wideLegs = [{ best_bid: '0.90', best_ask: '0.99' }, { best_bid: '0.01', best_ask: '0.10' }]; // ~9pp mean
  const c = scoreCategoricalConfidence({ rawInputs: wideLegs, totalVolume: 500, entropy: 0.1, dominantProb: 0.98 });
  assert.equal(c.reliability.tier, 'low', 'a truly illiquid book is not lifted by consensus');
});

test('categorical: consensus does NOT override a missing-outcome defect', () => {
  const c = scoreCategoricalConfidence({
    rawInputs: mediumSpreadLegs, totalVolume: 500, entropy: 0.1, dominantProb: 0.98,
    midpointFallback: { lastTradeCount: 0, skippedCount: 1 },
  });
  assert.equal(c.reliability.tier, 'low', 'a skipped outcome still caps reliability low');
});

// ── binary: extreme probability → reliability (a positive REASON, no tier lift — see binary.js) ──
test('binary: a decisive probability with a tail-minority spread adds a "well-determined" basis', () => {
  // prob 0.99 (tail 1pp), spread 0.4pp → relSpread 0.4 ≤ 0.5 → well-determined. Tight absolute spread
  // is already HIGH; the decisive reason is the added positive basis.
  const decisive = scoreBinaryConfidence({ probability: 0.99, bestBid: '0.988', bestAsk: '0.992', totalVolume: 500 });
  assert.equal(decisive.reliability.tier, 'high');
  assert.ok(decisive.reliability.reasons.some((r) => /decisive probability \(99%\) — price well-determined/.test(r)));
  // A non-decisive line gets no such basis.
  const mid = scoreBinaryConfidence({ probability: 0.50, bestBid: '0.488', bestAsk: '0.492', totalVolume: 500 });
  assert.ok(!mid.reliability.reasons.some((r) => /decisive/.test(r)));
});

test('binary: a decisive probability whose spread EATS the tail is NOT well-determined (caveat instead)', () => {
  // prob 0.98 (tail 2pp), spread 6pp → relSpread 3 → the price is NOT well-determined: the caveat
  // fires, the decisive basis does NOT, and the medium spread is not lifted.
  const c = scoreBinaryConfidence({ probability: 0.98, bestBid: '0.95', bestAsk: '0.99', totalVolume: 500 });
  assert.notEqual(c.reliability.tier, 'high');
  assert.ok(!c.reliability.reasons.some((r) => /well-determined/.test(r)));
  assert.ok(c.reliability.reasons.some((r) => /% of the implied probability/.test(r)));
});
