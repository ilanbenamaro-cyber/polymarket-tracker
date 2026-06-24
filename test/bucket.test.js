// Locks the bucket-PMF core: parseBucketLeg against REAL gamma questions (Bitcoin,
// Anthropic IPO) and buildPmfLadder against a controlled PMF whose median/mean are
// hand-computable. A bucket market is a disjoint-interval PMF; the survival curve P(>X)
// is DERIVED from it (so the existing median/IQR/density math applies), and the mean is
// computed directly from the PMF (no astronomical-outlier blowup — Bug 2). See
// MARKET-TYPES-PLAN.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBucketLeg, buildPmfLadder } from '../core/bucket.js';
import { computeImpliedMedian } from '../core/metrics.js';

test('parseBucketLeg: "less than $X" → [0, X]', () => {
  assert.deepEqual(parseBucketLeg('Will the price of Bitcoin be less than $56,000 on June 24?'), { lo: 0, hi: 56000 });
});

test('parseBucketLeg: "between $X and $Y" → [X, Y]', () => {
  assert.deepEqual(parseBucketLeg('Will the price of Bitcoin be between $62,000 and $64,000 on June 24?'), { lo: 62000, hi: 64000 });
});

test('parseBucketLeg: "greater than $Y" → [Y, Infinity)', () => {
  assert.deepEqual(parseBucketLeg('Will the price of Bitcoin be greater than $74,000 on June 24?'), { lo: 74000, hi: Infinity });
});

test('parseBucketLeg: trillion-unit brackets (Anthropic IPO)', () => {
  assert.deepEqual(parseBucketLeg("Will Anthropic's market cap be less than $1.25T at market close on IPO day?"), { lo: 0, hi: 1.25e12 });
  assert.deepEqual(parseBucketLeg("Will Anthropic's market cap be between $1.5T and $1.75T at market close on IPO day?"), { lo: 1.5e12, hi: 1.75e12 });
  assert.deepEqual(parseBucketLeg("Will Anthropic's market cap be $3.0T or greater at market close on IPO day?"), { lo: 3.0e12, hi: Infinity });
});

test('parseBucketLeg: categorical leg with no $ → null (excluded from the PMF)', () => {
  assert.equal(parseBucketLeg('Will Anthropic not IPO by December 31, 2027?'), null);
});

test('buildPmfLadder: derives the survival curve P(>boundary) from the PMF', () => {
  const legs = [
    { lo: 0, hi: 60000, prob: 0.2 },
    { lo: 60000, hi: 62000, prob: 0.5 },
    { lo: 62000, hi: Infinity, prob: 0.3 },
  ];
  const { markets } = buildPmfLadder(legs);
  assert.deepEqual(markets, [
    { threshold: 60000, prob: 0.8 }, // legs with lo >= 60000
    { threshold: 62000, prob: 0.3 }, // legs with lo >= 62000
  ]);
});

test('buildPmfLadder: derived median + PMF mean are correct (no outlier blowup)', () => {
  const legs = [
    { lo: 0, hi: 60000, prob: 0.2 },
    { lo: 60000, hi: 62000, prob: 0.5 },
    { lo: 62000, hi: Infinity, prob: 0.3 },
  ];
  const { markets, mean } = buildPmfLadder(legs);
  // median: CDF crosses 0.5 between (60000,0.8) and (62000,0.3) → 61200
  assert.equal(Math.round(computeImpliedMedian(markets)), 61200);
  // mean = 0.2·59000 + 0.5·61000 + 0.3·63000 = 61200 (tail offset = half the 2000 width)
  assert.equal(Math.round(mean), 61200);
});
