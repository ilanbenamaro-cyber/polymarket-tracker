// test/scenarios-guards.test.js — Tier-2 share-price math must never emit a
// fabricated band. Audit finding P1-4: impliedSharePrice divided by the
// hand-edited assumptions range bounds with no finiteness/positivity guard,
// so range:[0,x] produced Infinity — which JSON.stringify silently turns
// into null in the published feed (quiet corruption, no loud failure).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { impliedSharePrice } from '../core/scenarios.js';

const finiteOrNull = (n) => n === null || Number.isFinite(n);
const assertSane = (out, label) => {
  for (const k of ['central', 'low', 'high']) {
    assert.ok(finiteOrNull(out[k]), `${label}: ${k}=${out[k]} must be finite or null`);
    assert.ok(!Number.isNaN(out[k]), `${label}: ${k} must not be NaN`);
  }
};

test('impliedSharePrice: zero lower range bound never yields Infinity', () => {
  const out = impliedSharePrice(2.1, 1.9e9, [0, 2.1e9]); // P1-4 evidence input
  assertSane(out, '[0,x]');
});

test('impliedSharePrice: zero upper range bound never yields Infinity', () => {
  assertSane(impliedSharePrice(2.1, 1.9e9, [1.7e9, 0]), '[x,0]');
});

test('impliedSharePrice: negative range bound never yields a fabricated band', () => {
  assertSane(impliedSharePrice(2.1, 1.9e9, [-1, 2.1e9]), '[-1,x]');
});

test('impliedSharePrice: zero / non-finite shares yield nulls', () => {
  assertSane(impliedSharePrice(2.1, 0, [1.7e9, 2.1e9]), 'shares 0');
  assertSane(impliedSharePrice(2.1, Infinity, [1.7e9, 2.1e9]), 'shares Inf');
  assertSane(impliedSharePrice(2.1, NaN, [1.7e9, 2.1e9]), 'shares NaN');
});

test('impliedSharePrice: bad range degrades to a point estimate, not a band', () => {
  const out = impliedSharePrice(2.1, 1.9e9, [0, 2.1e9]);
  assert.ok(Number.isFinite(out.central), 'central survives');
  assert.equal(out.low, out.central, 'low collapses to central');
  assert.equal(out.high, out.central, 'high collapses to central');
});

test('impliedSharePrice: a TRANSPOSED range still yields an ordered band (red-team probe B)', () => {
  const out = impliedSharePrice(2.1, 1.9e9, [2.1e9, 1.7e9]); // bounds swapped in the registry
  assert.ok(out.low <= out.central && out.central <= out.high,
    `band must be ordered: ${JSON.stringify(out)}`);
});

test('impliedSharePrice: a valid range still inverts (more shares → lower price)', () => {
  const out = impliedSharePrice(2.1, 1.9e9, [1.7e9, 2.1e9]);
  assert.equal(out.low, Math.round(2.1e12 / 2.1e9));
  assert.equal(out.high, Math.round(2.1e12 / 1.7e9));
  assert.ok(out.low < out.central && out.central < out.high);
});
