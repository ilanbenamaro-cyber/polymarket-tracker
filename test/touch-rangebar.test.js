// test/touch-rangebar.test.js — the directional-touch range-bar label placement (Phase 4 Bug B).
// A narrow band must stack the lo/hi labels (above/below) instead of overlapping them over the bar.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeBarLayout, RANGEBAR_W, NARROW_FRAC } from '../lib/touch-rangebar.mjs';

const LEVELS = [0, 50, 100, 150, 200]; // axis 0..200

test('empty axis → null (nothing to place)', () => {
  assert.equal(rangeBarLayout(95, 105, []), null);
});

test('wide band (≥20%): both labels above the bar, anchored to opposite edges', () => {
  const L = rangeBarLayout(40, 160, LEVELS); // band = 120/200 = 60% of axis
  assert.equal(L.narrow, false);
  assert.equal(L.lo.y, L.hi.y);          // same row
  assert.equal(L.lo.anchor, 'start');    // left edge
  assert.equal(L.hi.anchor, 'end');      // right edge
  assert.ok(L.lo.x < L.hi.x);            // lo left of hi
});

test('narrow band (<20%): labels stack — hi above, lo below — centred on the band', () => {
  const L = rangeBarLayout(99, 101, LEVELS); // band = 2/200 = 1% of axis
  assert.equal(L.narrow, true);
  assert.ok(L.hi.y < L.lo.y);            // hi above, lo below (distinct rows)
  assert.equal(L.lo.x, L.hi.x);          // both centred on the band → no horizontal overlap
  assert.equal(L.lo.anchor, 'middle');   // mid-axis band → centred anchor
  assert.equal(L.hi.anchor, 'middle');
});

test('the 20% threshold is the boundary (exactly 20% is NOT narrow)', () => {
  // band width = exactly NARROW_FRAC of the axis → strict "<" keeps it wide.
  const lo = 0, hi = (NARROW_FRAC * 200); // 40 → band 0..40 = 20% of 0..200
  const L = rangeBarLayout(lo, hi, LEVELS);
  assert.equal((L.bandR - L.bandL) / RANGEBAR_W, NARROW_FRAC);
  assert.equal(L.narrow, false);
  // a hair narrower flips it
  assert.equal(rangeBarLayout(lo, hi - 1, LEVELS).narrow, true);
});

test('null bound → band extends to that edge → full width, never narrow', () => {
  const L = rangeBarLayout(null, 120, LEVELS); // lower crossover outside ladder → bandL = 0
  assert.equal(L.bandL, 0);
  assert.equal(L.narrow, false);
});

test('narrow band at an extreme edge hugs that edge so the label stays in view', () => {
  const lo = rangeBarLayout(2, 4, LEVELS);   // band near the far left
  assert.equal(lo.narrow, true);
  assert.equal(lo.hi.anchor, 'start');       // < 15% → left-anchored, not centred off-screen
  const hi = rangeBarLayout(196, 198, LEVELS); // band near the far right
  assert.equal(hi.hi.anchor, 'end');         // > 85% → right-anchored
});
