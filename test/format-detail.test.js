// test/format-detail.test.js — the 2c.3 unit-aware formatter: the headline must read
// in the market's OWN denomination (T/B/M), derived from the ladder labels, not a
// hardcoded $T. Covers the generalization tightening for non-trillion markets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitFromLadder, fmtMoney, fmtRange } from '../lib/format-detail.mjs';

test('derives T from a trillions ladder (SpaceX-style)', () => {
  assert.equal(unitFromLadder([{ label: '>$1T' }, { label: '>$1.8T' }]), 'T');
  assert.equal(unitFromLadder([{ label: '$2–2.2T' }]), 'T'); // bucket-style label
});

test('derives B from a billions ladder (Kraken-style) and M from millions', () => {
  assert.equal(unitFromLadder([{ label: '>$28B' }]), 'B');
  assert.equal(unitFromLadder([{ label: '>$500M' }]), 'M');
});

test('falls back to T on a missing/odd label', () => {
  assert.equal(unitFromLadder([]), 'T');
  assert.equal(unitFromLadder(undefined), 'T');
  assert.equal(unitFromLadder([{ label: '' }]), 'T');
});

test('fmtMoney renders in the derived unit', () => {
  assert.equal(fmtMoney(2.1, 'T'), '$2.10T');
  assert.equal(fmtMoney(28, 'B'), '$28.00B');
  assert.equal(fmtMoney(500, 'M'), '$500.00M');
  assert.equal(fmtMoney(null, 'T'), 'n/a');
  assert.equal(fmtMoney(Infinity, 'B'), 'n/a');
});

test('fmtRange formats a {low,high} band or returns null', () => {
  assert.equal(fmtRange({ low: 2.05, high: 2.15 }, 'T'), '$2.05–$2.15T');
  assert.equal(fmtRange({ low: 26, high: 30 }, 'B'), '$26.00–$30.00B');
  assert.equal(fmtRange(null, 'T'), null);
  assert.equal(fmtRange({ low: 1 }, 'T'), null); // missing high
});

test('end-to-end: a billions market formats its headline in $B', () => {
  const markets = [{ label: '>$16B' }, { label: '>$20B' }, { label: '>$28B' }];
  const unit = unitFromLadder(markets);
  assert.equal(fmtMoney(22.4, unit), '$22.40B');
});
