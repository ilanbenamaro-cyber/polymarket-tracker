// test/format-detail.test.js — the 2c.3 unit-aware formatter: the headline must read
// in the market's OWN denomination (T/B/M), derived from the ladder labels, not a
// hardcoded $T. Covers the generalization tightening for non-trillion markets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitFromLadder, fmtMoney, fmtRange, fmtEastern } from '../lib/format-detail.mjs';

test('derives T from a trillions ladder (SpaceX-style)', () => {
  assert.equal(unitFromLadder([{ label: '>$1T' }, { label: '>$1.8T' }]), 'T');
  assert.equal(unitFromLadder([{ label: '$2–2.2T' }]), 'T'); // bucket-style label
});

test('derives B from a billions ladder (Kraken-style) and M from millions', () => {
  assert.equal(unitFromLadder([{ label: '>$28B' }]), 'B');
  assert.equal(unitFromLadder([{ label: '>$500M' }]), 'M');
});

test('derives K from a thousands ladder (Bitcoin) and plain $ from a bare ladder (WTI)', () => {
  assert.equal(unitFromLadder([{ label: '>$56K' }, { label: '>$74K' }]), 'K');
  assert.equal(unitFromLadder([{ label: '>$90' }, { label: '>$120' }]), ''); // bare dollars
});

test('falls back to dimensionless (NOT $T) on a missing/odd label', () => {
  // Defaulting to "T" was Bug 1 — an ambiguous label must render dimensionless, never $T.
  assert.equal(unitFromLadder([]), '');
  assert.equal(unitFromLadder(undefined), '');
  assert.equal(unitFromLadder([{ label: '' }]), '');
});

test('fmtMoney renders in the derived unit', () => {
  assert.equal(fmtMoney(2.1, 'T'), '$2.10T');
  assert.equal(fmtMoney(28, 'B'), '$28.00B');
  assert.equal(fmtMoney(500, 'M'), '$500.00M');
  assert.equal(fmtMoney(61.13, 'K'), '$61.13K');
  assert.equal(fmtMoney(90, ''), '$90.00'); // plain dollars — no unit suffix
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

test('fmtEastern converts UTC → America/New_York with a DST-aware zone label', () => {
  // 19:42 UTC in summer = 3:42 PM EDT (UTC-4)
  const summer = fmtEastern('2026-06-24T19:42:00Z');
  assert.match(summer, /3:42\s?PM/);
  assert.match(summer, /EDT/);
  assert.doesNotMatch(summer, /UTC/);
  // 18:42 UTC in winter = 1:42 PM EST (UTC-5) — proves we never hardcode -4
  const winter = fmtEastern('2026-01-15T18:42:00Z');
  assert.match(winter, /1:42\s?PM/);
  assert.match(winter, /EST/);
  // bad input degrades, never throws
  assert.equal(fmtEastern(null), '—');
  assert.equal(fmtEastern('not-a-date'), '—');
});
