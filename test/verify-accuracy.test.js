// test/verify-accuracy.test.js — proves the reconciliation logic of the accuracy
// harness with synthetic cases. The network path (main/capture) is not exercised
// here; only the pure, exported decision functions. Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOL,
  parseThreshold,
  crossSource,
  reconcileRow,
  tokenDrift,
  assessIsotonic,
  freshness,
  overallVerdict,
} from '../scripts/verify-accuracy.js';

test('parseThreshold extracts the dollar threshold; throws on garbage', () => {
  assert.equal(parseThreshold('SpaceX IPO closing market cap above $1.8T?'), 1.8);
  assert.equal(parseThreshold('above $1T?'), 1);
  assert.throws(() => parseThreshold('no number here'));
});

test('crossSource agrees within tol, flags upstream disagreement beyond it', () => {
  assert.equal(crossSource(0.50, 0.505).agree, true); // 0.5pt apart
  assert.equal(crossSource(0.50, 0.52).agree, false); // 2pt apart > 1pt
  assert.equal(crossSource(null, 0.5).comparable, false);
});

test('reconcileRow folds observed drift into the effective tolerance', () => {
  // 2.5pt apart, base tol 2pt → fails without drift...
  assert.equal(reconcileRow({ published: 0.50, liveMid: 0.525 }).within_tol, false);
  // ...but a 1pt drift on the token lifts effective tol to 3pt → passes.
  const r = reconcileRow({ published: 0.50, liveMid: 0.525, drift: 0.01 });
  assert.equal(r.within_tol, true);
  assert.equal(r.effective_tol, TOL.PUBLISHED + 0.01);
});

test('reconcileRow reports non-comparable when a side is missing', () => {
  assert.equal(reconcileRow({ published: null, liveMid: 0.5 }).comparable, false);
});

test('tokenDrift is absolute movement, null when a capture is missing', () => {
  assert.ok(Math.abs(tokenDrift(0.50, 0.53) - 0.03) < 1e-9);
  assert.ok(Math.abs(tokenDrift(0.53, 0.50) - 0.03) < 1e-9);
  assert.equal(tokenDrift(null, 0.5), null);
});

test('assessIsotonic accepts a valid non-increasing curve summing to 1', () => {
  // adjusted CDF 0.8, 0.5, 0.2 → buckets 0.3,0.3,0.2 and below-lowest 0.2 = 1.0
  const markets = [
    { label: '>$1T', threshold: 1, adjusted_prob: 0.8, bucket_prob: 0.3 },
    { label: '>$2T', threshold: 2, adjusted_prob: 0.5, bucket_prob: 0.3 },
    { label: '>$3T', threshold: 3, adjusted_prob: 0.2, bucket_prob: 0.2 },
  ];
  const r = assessIsotonic(markets);
  assert.equal(r.valid, true);
  assert.ok(Math.abs(r.sum - 1) < 1e-9);
});

test('assessIsotonic rejects a rising CDF and a negative bucket', () => {
  const rising = assessIsotonic([
    { label: '>$1T', threshold: 1, adjusted_prob: 0.4, bucket_prob: -0.1 },
    { label: '>$2T', threshold: 2, adjusted_prob: 0.5, bucket_prob: 0.5 },
  ]);
  assert.equal(rising.valid, false);
  assert.equal(rising.monotone, false);
  assert.equal(rising.bucketsNonNeg, false);
});

test('assessIsotonic agrees with core adjustSnapshot on monotone-violating raw', async () => {
  const { adjustSnapshot } = await import('../core/stats.js');
  const adj = adjustSnapshot([
    { label: '>$1T', threshold: 1, prob: 0.9, volume: 100 },
    { label: '>$2T', threshold: 2, prob: 0.95, volume: 100 }, // violation: rises
    { label: '>$3T', threshold: 3, prob: 0.3, volume: 100 },
  ]);
  // The production transform must always emit a curve our checker calls valid.
  assert.equal(assessIsotonic(adj.markets).valid, true);
});

test('freshness flags age beyond the window', () => {
  const base = '2026-06-08T00:00:00.000Z';
  assert.equal(freshness('2026-06-07T23:00:00.000Z', base).fresh, true); // 1h
  assert.equal(freshness('2026-06-05T00:00:00.000Z', base).fresh, false); // 72h
  assert.ok(Math.abs(freshness('2026-06-05T00:00:00.000Z', base).ageHours - 72) < 1e-6);
});

test('overallVerdict: fresh + within tol = PASS', () => {
  const v = overallVerdict({ sourceValid: true, fresh: true, publishedOutOfTol: 0, crossSourceDisagree: 0, strict: false });
  assert.equal(v.verdict, 'PASS');
  assert.equal(v.exit, 0);
});

test('overallVerdict: invalid live curve = FAIL regardless of freshness', () => {
  const v = overallVerdict({ sourceValid: false, fresh: true, publishedOutOfTol: 0, crossSourceDisagree: 0, strict: false });
  assert.equal(v.verdict, 'FAIL');
  assert.equal(v.exit, 1);
});

test('overallVerdict: fresh but out-of-tol = FAIL (a real discrepancy)', () => {
  const v = overallVerdict({ sourceValid: true, fresh: true, publishedOutOfTol: 2, crossSourceDisagree: 0, strict: false });
  assert.equal(v.verdict, 'FAIL');
});

test('overallVerdict: stale + valid method = STALE (exit 2), not FAIL', () => {
  const v = overallVerdict({ sourceValid: true, fresh: false, publishedOutOfTol: 5, crossSourceDisagree: 0, strict: false });
  assert.equal(v.verdict, 'STALE');
  assert.equal(v.exit, 2);
});

test('overallVerdict: --strict promotes STALE and cross-source disagreement to FAIL', () => {
  assert.equal(overallVerdict({ sourceValid: true, fresh: false, publishedOutOfTol: 0, crossSourceDisagree: 0, strict: true }).verdict, 'FAIL');
  assert.equal(overallVerdict({ sourceValid: true, fresh: true, publishedOutOfTol: 0, crossSourceDisagree: 3, strict: true }).verdict, 'FAIL');
});
