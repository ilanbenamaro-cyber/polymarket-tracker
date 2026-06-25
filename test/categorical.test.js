// test/categorical.test.js — the categorical market model (Phase 1b).
//
// Categorical events (e.g. "How many Fed rate cuts in 2026?") are N mutually-exclusive
// Yes/No legs whose YES midpoints form a PMF over named outcomes. The model de-vigs that
// PMF (display normalization — the RAW observed midpoints stay in raw_inputs, never
// normalized, per constraint #2), then derives the dominant outcome, Shannon entropy, and
// a consensus strength. These tests cover the pure math + the record builder's shape and
// provenance. Live compute is verified by scripts/verify-categorical.mjs (handed off).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProbabilities, shannonEntropy, consensusStrength,
  parseCategoricalOutcomes, scoreCategoricalConfidence, buildCategoricalRecord,
} from '../core/categorical.js';
import { hashRawInputs } from '../core/fetch.js';
import { validateRecord } from '../core/validate.js';

// ── normalizeProbabilities (de-vig) ──────────────────────────────────────────
test('normalizeProbabilities: scales a PMF to sum 1, preserving ratios', () => {
  const out = normalizeProbabilities([0.8, 0.135, 0.03]); // sum 0.965 (overround removed)
  assert.ok(Math.abs(out.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(Math.abs(out[0] / out[1] - 0.8 / 0.135) < 1e-9); // ratio preserved
});

test('normalizeProbabilities: all-zero input returns zeros (no divide-by-zero)', () => {
  assert.deepEqual(normalizeProbabilities([0, 0, 0]), [0, 0, 0]);
});

// ── shannonEntropy (normalized to [0,1]) ─────────────────────────────────────
test('shannonEntropy: uniform distribution is maximal (1.0)', () => {
  assert.ok(Math.abs(shannonEntropy([0.5, 0.5]) - 1) < 1e-9);
  assert.ok(Math.abs(shannonEntropy([0.25, 0.25, 0.25, 0.25]) - 1) < 1e-9);
});

test('shannonEntropy: a certain outcome is minimal (0)', () => {
  assert.equal(shannonEntropy([1, 0, 0]), 0);
});

test('shannonEntropy: a single outcome is 0 (no uncertainty)', () => {
  assert.equal(shannonEntropy([1]), 0);
});

// ── consensusStrength ────────────────────────────────────────────────────────
test('consensusStrength: tiers off the dominant probability', () => {
  assert.equal(consensusStrength(0.8), 'HIGH');
  assert.equal(consensusStrength(0.5), 'MEDIUM');
  assert.equal(consensusStrength(0.4), 'LOW');
  assert.equal(consensusStrength(0.2), 'LOW');
});

// ── parseCategoricalOutcomes ─────────────────────────────────────────────────
test('parseCategoricalOutcomes: sorts descending, normalizes, keeps the raw probability', () => {
  const legs = [
    { label: '1 cut', prob: 0.135, volume: 100 },
    { label: '0 cuts', prob: 0.8, volume: 500 },
    { label: '2 cuts', prob: 0.03, volume: 50 },
  ];
  const outs = parseCategoricalOutcomes(legs);
  assert.equal(outs[0].label, '0 cuts'); // highest first
  assert.equal(outs[0].raw_probability, 0.8); // raw preserved
  assert.ok(outs[0].probability > 0.8); // normalized up (overround removed)
  assert.ok(Math.abs(outs.reduce((a, o) => a + o.probability, 0) - 1) < 1e-9);
});

// ── scoreCategoricalConfidence ───────────────────────────────────────────────
test('scoreCategoricalConfidence: deep, tight, liquid book scores high', () => {
  const rawInputs = [
    { best_bid: '0.79', best_ask: '0.80' }, { best_bid: '0.13', best_ask: '0.14' },
  ];
  const c = scoreCategoricalConfidence({ rawInputs, totalVolume: 5_000_000, midpointFallback: null });
  assert.equal(c.tier, 'high');
  assert.ok(c.score > 0.5);
});

test('scoreCategoricalConfidence: thin volume + last-trade fallback degrades + explains', () => {
  const c = scoreCategoricalConfidence({
    rawInputs: [{ best_bid: null, best_ask: null }],
    totalVolume: 500,
    midpointFallback: { lastTradeCount: 1, skippedCount: 0 },
  });
  assert.equal(c.tier, 'low'); // thin volume forces low
  assert.ok(c.reasons.some((r) => /thin volume/.test(r)));
  assert.ok(c.reasons.some((r) => /last trade/.test(r)));
});

// ── buildCategoricalRecord ───────────────────────────────────────────────────
function liveFixture() {
  const raw_inputs = [
    { token_id: 'y0', threshold: 0, midpoint: '0.80', best_bid: '0.79', best_ask: '0.80', volume: 500, midpoint_source: 'clob_midpoint' },
    { token_id: 'y1', threshold: 1, midpoint: '0.135', best_bid: '0.13', best_ask: '0.14', volume: 100, midpoint_source: 'clob_midpoint' },
    { token_id: 'y2', threshold: 2, midpoint: '0.03', best_bid: '0.02', best_ask: '0.03', volume: 50, midpoint_source: 'clob_midpoint' },
  ];
  return {
    fetched_at: '2026-06-25T00:00:00.000Z',
    endpoints: ['gamma', 'midpoints', 'prices'],
    raw_inputs,
    raw_sha256: hashRawInputs(raw_inputs),
    outcomes: [
      { label: '0 cuts', prob: 0.80, volume: 500, midpoint_source: 'clob_midpoint' },
      { label: '1 cut', prob: 0.135, volume: 100, midpoint_source: 'clob_midpoint' },
      { label: '2 cuts', prob: 0.03, volume: 50, midpoint_source: 'clob_midpoint' },
    ],
    total_volume: 650,
    title: 'How many Fed rate cuts in 2026?',
    end_date: '2026-12-31',
    status: [{ threshold: 0, closed: false }],
    midpoint_fallback: { lastTradeCount: 0, skippedCount: 0 },
  };
}

test('buildCategoricalRecord: produces a kind=categorical derived block with dominant + entropy', () => {
  const config = { id: 'fed', name: 'How many Fed rate cuts in 2026?', platform: 'polymarket', market_url: 'u', resolves: '2026-12-31' };
  const rec = buildCategoricalRecord(liveFixture(), '1.4.0', config, { state: 'OPEN' });
  const d = rec.snapshot.derived;
  assert.equal(d.kind, 'categorical');
  assert.equal(d.dominant_outcome, '0 cuts');
  assert.ok(d.dominant_prob > 0.8);
  assert.ok(Math.abs(d.outcomes.reduce((a, o) => a + o.probability, 0) - 1) < 1e-9);
  assert.ok(d.entropy >= 0 && d.entropy <= 1);
  assert.equal(d.consensus_strength, 'HIGH');
  assert.equal(d.implied_winner, '0 cuts'); // dominant > 0.5
  assert.ok(d.confidence.tier);
  assert.ok(typeof d.narrative === 'string' && d.narrative.length > 0);
});

test('buildCategoricalRecord: raw_inputs keep the OBSERVED midpoints (provenance re-hashes)', () => {
  const config = { id: 'fed', name: 'Fed', platform: 'polymarket', market_url: 'u', resolves: null };
  const rec = buildCategoricalRecord(liveFixture(), '1.4.0', config, { state: 'OPEN' });
  // the stored raw midpoints are the un-normalized observed values
  assert.equal(rec.snapshot.raw_inputs[0].midpoint, '0.80');
  assert.equal(rec.snapshot.source.raw_sha256, hashRawInputs(rec.snapshot.raw_inputs));
});

test('buildCategoricalRecord: the built record passes validateRecord (schema + firewall + lifecycle)', () => {
  const config = { id: 'fed', name: 'How many Fed rate cuts in 2026?', platform: 'polymarket', market_url: 'u', resolves: '2026-12-31' };
  const rec = buildCategoricalRecord(liveFixture(), '1.4.0', config, { state: 'OPEN', resolved_outcome: null });
  assert.doesNotThrow(() => validateRecord(rec)); // schema allOf categorical branch + firewall + lifecycle
});

test('buildCategoricalRecord: no-consensus market reports implied_winner = "no consensus"', () => {
  const live = liveFixture();
  live.outcomes = [
    { label: 'A', prob: 0.34, volume: 1 }, { label: 'B', prob: 0.33, volume: 1 }, { label: 'C', prob: 0.33, volume: 1 },
  ];
  const rec = buildCategoricalRecord(live, '1.4.0', { id: 'x', name: 'X', platform: 'polymarket', market_url: 'u', resolves: null }, { state: 'OPEN' });
  assert.equal(rec.snapshot.derived.implied_winner, 'no consensus');
});
