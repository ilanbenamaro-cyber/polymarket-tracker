// test/windowed-volume.test.js — Increment 1: windowed (recent) volume.
//
// All-time cumulative volume is a poor liquidity proxy (a dormant market reads identical to an
// active one). Gamma exposes volume24hr / volume1wk per leg; we aggregate them into a supplementary
// derived.liquidity object (NEVER into raw_inputs / the hash) and drive confidence off the recent
// window, falling back to all-time only when windowed data is absent. These cover the two pure
// functions + the scorer wiring; the omit-when-absent parity safety is covered by the SpaceX gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateLiquidity } from '../core/fetch.js';
import { windowedVolumeSignal as winSig, scoreConfidence } from '../core/confidence.js';

// ── windowedVolumeSignal (the calibrated tiers) ──────────────────────────────
test('windowedVolumeSignal: HIGH at 24h ≥ $50K or 7d ≥ $200K', () => {
  assert.equal(winSig({ volume_24hr: 50_000, volume_1wk: 0 }).tier, 'high');       // Fed/SpaceX/Silver
  assert.equal(winSig({ volume_24hr: 6_000, volume_1wk: 551_000 }).tier, 'high');  // Silver via 7d
  assert.equal(winSig({ volume_24hr: 50_000, volume_1wk: 0 }).reason, null);       // HIGH carries no caveat
});

test('windowedVolumeSignal: MEDIUM at 24h ≥ $5K or 7d ≥ $25K', () => {
  const m = winSig({ volume_24hr: 6_000, volume_1wk: 20_000 });
  assert.equal(m.tier, 'medium');
  assert.match(m.reason, /moderate 24h volume \(\$6,000\)/);
});

test('windowedVolumeSignal: LOW catches the dormant-but-historically-traded market', () => {
  // US recession: $478/24h, $16K/7d — thin recently despite a $1.6M all-time total.
  const l = winSig({ volume_24hr: 478, volume_1wk: 16_071 });
  assert.equal(l.tier, 'low');
  assert.match(l.reason, /thin 24h volume \(\$478\)/);
  // Connecticut primary: $0/$0 — also LOW.
  assert.equal(winSig({ volume_24hr: 0, volume_1wk: 0 }).tier, 'low');
});

test('windowedVolumeSignal: just-over-the-line Anthropic is HIGH (24h $51,666 ≥ $50K)', () => {
  assert.equal(winSig({ volume_24hr: 51_666, volume_1wk: 220_614 }).tier, 'high');
});

test('F1: a STALE 7d spike on a now-dormant market does NOT read HIGH (24h floor $2K)', () => {
  // v7 ≥ $200K but 24h is dead → the floor blocks HIGH; it reads MEDIUM (still ≥ $25K/7d).
  assert.equal(winSig({ volume_24hr: 0, volume_1wk: 250_000 }).tier, 'medium');
  assert.equal(winSig({ volume_24hr: 1_999, volume_1wk: 250_000 }).tier, 'medium'); // just below the floor
  // a live market clearing the $2K floor keeps its 7d-driven HIGH (boundary).
  assert.equal(winSig({ volume_24hr: 2_000, volume_1wk: 250_000 }).tier, 'high'); // exactly at the floor
  assert.equal(winSig({ volume_24hr: 6_000, volume_1wk: 551_000 }).tier, 'high'); // Silver: $6K ≥ floor
  // the 24h≥$50K path is unaffected by the floor.
  assert.equal(winSig({ volume_24hr: 60_000, volume_1wk: 0 }).tier, 'high');
});

test('windowedVolumeSignal: null when no windowed data (drives the all-time fallback + parity safety)', () => {
  assert.equal(winSig(null), null);
  assert.equal(winSig({ volume_24hr: null, volume_1wk: null }), null);
  assert.equal(winSig({}), null);
});

// ── aggregateLiquidity (sum-of-legs == event aggregate, verified vs gamma) ────
test('aggregateLiquidity: sums per-leg windowed + all-time; builds the by_threshold map', () => {
  const legs = [
    { threshold: 1.8, volume: 1000, volume_24hr: 300, volume_1wk: 700 },
    { threshold: 2.0, volume: 2000, volume_24hr: 200, volume_1wk: 800 },
  ];
  const liq = aggregateLiquidity(legs, (l) => l.threshold);
  assert.equal(liq.volume_24hr, 500);
  assert.equal(liq.volume_1wk, 1500);
  assert.equal(liq.volume_all, 3000);
  assert.deepEqual(liq.by_threshold, { 1.8: 300, 2.0: 200 });
});

test('aggregateLiquidity: null when NO leg carries windowed data (omit-when-absent → parity)', () => {
  assert.equal(aggregateLiquidity([{ threshold: 1, volume: 5000 }]), null); // all-time only (frozen replay)
  assert.equal(aggregateLiquidity([]), null);
  assert.equal(aggregateLiquidity(null), null);
});

// ── scoreConfidence wiring (present caps/raises tier; absent is byte-identical) ──
function ladder(n) { return Array.from({ length: n }, (_, i) => ({ threshold: i, prob: 0.5, adjusted_prob: 0.5 })); }

test('scoreConfidence: thin recent volume drags an otherwise-clean ladder to LOW', () => {
  const base = { markets: ladder(16), rawInputs: ladder(16).map(() => ({ best_bid: '0.49', best_ask: '0.51' })) };
  const high = scoreConfidence({ ...base, windowedVolume: { volume_24hr: 80_000, volume_1wk: 300_000 } });
  const low = scoreConfidence({ ...base, windowedVolume: { volume_24hr: 100, volume_1wk: 1_000 } });
  assert.equal(high.tier, 'high');
  assert.equal(low.tier, 'low');
  assert.ok(low.reasons.some((r) => /thin 24h volume/.test(r)));
  assert.ok(low.score < high.score);
});

test('scoreConfidence: absent windowed volume leaves tier/score/reasons unchanged (parity safety)', () => {
  const base = { markets: ladder(16), rawInputs: ladder(16).map(() => ({ best_bid: '0.49', best_ask: '0.51' })) };
  const withNull = scoreConfidence({ ...base, windowedVolume: null });
  const without = scoreConfidence({ ...base });
  assert.deepEqual(withNull, without); // null windowed == omitted entirely
});
