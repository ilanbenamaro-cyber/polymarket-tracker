// test/hardening.test.js — proves each statistical / anomaly / provenance claim
// with a synthetic case. Run: node --test
//
// Covers: PAVA monotonicity + volume weighting, non-negative buckets, median band
// ordering, mean sensitivity ordering, every confidence anomaly reason, validation
// failing loudly on impossible values, and hash match vs mismatch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { pava, adjustSnapshot, medianBand, meanSensitivity } from '../core/stats.js';
import { computeImpliedMedian } from '../core/metrics.js';
import { scoreConfidence } from '../core/confidence.js';
import { buildNarrative } from '../core/narrative.js';
import { validateRecord } from '../core/validate.js';
import { hashRawInputs, canonicalizeRawInputs } from '../core/fetch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LATEST = JSON.parse(readFileSync(join(__dirname, '../docs/api/v1/latest.json'), 'utf8'));

test('PAVA enforces non-increasing and pools violators', () => {
  const out = pava([0.9, 0.95, 0.8], [1, 1, 1]); // 0.9<0.95 violates non-increasing
  for (let i = 0; i < out.length - 1; i++) assert.ok(out[i] >= out[i + 1] - 1e-12);
  assert.ok(Math.abs(out[0] - 0.925) < 1e-9 && Math.abs(out[1] - 0.925) < 1e-9); // pooled mean
});

test('PAVA volume weighting pulls toward the more liquid quote', () => {
  // 0.90 (vol 1000) then 0.96 (vol 1) violate; pooled mean ~ 0.90006, near the liquid one
  const out = pava([0.9, 0.96], [1000, 1]);
  assert.ok(out[0] === out[1]); // pooled into one block
  assert.ok(out[0] < 0.905, `pooled ${out[0]} should sit near the high-volume 0.90`);
});

test('adjustSnapshot: non-negative buckets, monotone, sum=1, raw preserved', () => {
  const markets = [
    { label: '>$1T', threshold: 1, prob: 0.9, volume: 1000 },
    { label: '>$1.2T', threshold: 1.2, prob: 0.95, volume: 10 }, // violation
    { label: '>$1.4T', threshold: 1.4, prob: 0.6, volume: 500 },
  ];
  const a = adjustSnapshot(markets);
  assert.equal(a.monotonicity_violations, 1);
  assert.ok(a.max_adjustment > 0);
  for (const m of a.markets) assert.ok(m.bucket_prob >= -1e-9, `bucket ${m.bucket_prob} >= 0`);
  for (let i = 0; i < a.markets.length - 1; i++)
    assert.ok(a.markets[i].adjusted_prob >= a.markets[i + 1].adjusted_prob - 1e-12);
  const sum = 1 - a.markets[0].adjusted_prob + a.markets.reduce((s, m) => s + m.bucket_prob, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.equal(a.markets[1].raw_prob, 0.95); // raw preserved
});

test('medianBand: low <= central <= high', () => {
  const raw = [
    { threshold: 1.8, midpoint: '0.7', best_bid: '0.68', best_ask: '0.72', volume: 100 },
    { threshold: 2.0, midpoint: '0.45', best_bid: '0.43', best_ask: '0.47', volume: 100 },
  ];
  const central = computeImpliedMedian([
    { threshold: 1.8, prob: 0.7 },
    { threshold: 2.0, prob: 0.45 },
  ]);
  const band = medianBand(raw, central);
  assert.ok(band && band.low <= band.central + 1e-9 && band.central <= band.high + 1e-9);
  assert.equal(medianBand(null, central), null); // price-only => null
});

test('meanSensitivity: low <= central <= high', () => {
  const adj = [
    { threshold: 1.8, prob: 0.7 },
    { threshold: 2.0, prob: 0.45 },
    { threshold: 2.4, prob: 0.2 },
  ];
  const m = meanSensitivity(adj);
  assert.ok(m.low <= m.central + 1e-9 && m.central <= m.high + 1e-9);
});

test('confidence surfaces each anomaly reason', () => {
  const markets = Array.from({ length: 16 }, (_, i) => ({ threshold: 1 + i * 0.2, prob: 0.9 - i * 0.05 }));
  const rawInputs = markets.map((m) => ({ best_bid: '0.5', best_ask: '0.51' }));
  const liquidity = { thinCount: 0, total: 16, thinShare: 0 };

  const stale = scoreConfidence({ markets, rawInputs, liquidity, anomalies: { stale: true, closedCount: 0, liquidityDrop: null } });
  assert.ok(stale.reasons.some((r) => /identical to prior snapshot/.test(r)));

  const closed = scoreConfidence({ markets, rawInputs, liquidity, anomalies: { stale: false, closedCount: 3, liquidityDrop: null } });
  assert.ok(closed.reasons.some((r) => /closed \/ not accepting/.test(r)) && closed.tier === 'low');

  const drop = scoreConfidence({ markets, rawInputs, liquidity, anomalies: { stale: false, closedCount: 0, liquidityDrop: { triggered: true, pct: 0.55 } } });
  assert.ok(drop.reasons.some((r) => /below 7-day median/.test(r)));

  const thin = scoreConfidence({ markets, rawInputs, liquidity: { thinCount: 9, total: 16, thinShare: 9 / 16 } });
  assert.ok(thin.reasons.some((r) => /thin liquidity on 9 of 16/.test(r)));
});

test('validateRecord throws on a negative/inconsistent bucket', () => {
  const tampered = JSON.parse(JSON.stringify(LATEST));
  tampered.snapshot.derived.markets[3].adjusted_prob = 0.999; // breaks monotonicity + bucket
  assert.throws(() => validateRecord(tampered), /invalid/i);
});

test('validateRecord passes on the real published record', () => {
  assert.equal(validateRecord(LATEST), true);
});

test('hash: MATCH on real inputs, MISMATCH on a mutated copy', () => {
  const ri = LATEST.snapshot.raw_inputs;
  assert.equal(hashRawInputs(ri), LATEST.snapshot.source.raw_sha256); // match
  const mutated = JSON.parse(JSON.stringify(ri));
  mutated[0].midpoint = (Number(mutated[0].midpoint) + 0.01).toFixed(4);
  assert.notEqual(hashRawInputs(mutated), LATEST.snapshot.source.raw_sha256); // mismatch
  // canonicalization is stable / order-independent
  assert.equal(canonicalizeRawInputs(ri), canonicalizeRawInputs([...ri].reverse()));
});

test('narrative asserts nothing absent from narrative_components', () => {
  const derived = {
    implied_median: 2.1,
    confidence: { tier: 'medium', reasons: ['price-only history (no bid/ask spread)'] },
  };
  const density = [{ label: '$2–2.2T', prob: 0.3 }, { label: '$1.8–2T', prob: 0.2 }];
  const { narrative, narrative_components } = buildNarrative({ derived, prior7d: 2.0, prior30d: 2.05, density });
  assert.ok(narrative_components.dominant_bucket.label === '$2–2.2T');
  assert.ok(/\$2–2.2T/.test(narrative)); // dominant bucket claim backed
  assert.ok(/Confidence is medium/.test(narrative)); // caveat backed by tier
  assert.ok(narrative_components.change_7d && narrative_components.change_30d);
});
