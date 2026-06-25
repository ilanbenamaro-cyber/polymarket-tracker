// test/format-detail.test.js — the 2c.3 unit-aware formatter: the headline must read
// in the market's OWN denomination (T/B/M), derived from the ladder labels, not a
// hardcoded $T. Covers the generalization tightening for non-trillion markets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitFromLadder, fmtMoney, fmtRange, fmtEastern, settlementZone, settlementZoneLabel } from '../lib/format-detail.mjs';

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

// ── Bug 6: settlement zone (the converged bucket for a near-settled ladder) ──────
test('settlementZone: picks the interior bucket holding the most mass', () => {
  // converged: ~all mass between $2.0 and $2.2 (P(>2.0)=0.99, P(>2.2)=0.01)
  const m = [
    { threshold: 1.8, adjusted_prob: 0.999, bucket_prob: 0.009 },
    { threshold: 2.0, adjusted_prob: 0.99, bucket_prob: 0.98 },
    { threshold: 2.2, adjusted_prob: 0.01, bucket_prob: 0.01 },
  ];
  const z = settlementZone(m);
  assert.equal(z.kind, 'between');
  assert.equal(z.lo, 2.0);
  assert.equal(z.hi, 2.2);
  assert.equal(settlementZoneLabel(z, 'T'), '$2–2.2T');
});

test('settlementZone: converged ABOVE the top strike → the ">top" tail wins', () => {
  const m = [
    { threshold: 1.8, adjusted_prob: 0.999, bucket_prob: 0.001 },
    { threshold: 2.0, adjusted_prob: 0.999, bucket_prob: 0.001 },
    { threshold: 2.2, adjusted_prob: 0.998, bucket_prob: 0.998 }, // top tail holds the mass
  ];
  const z = settlementZone(m);
  assert.equal(z.kind, 'above');
  assert.equal(z.lo, 2.2);
  assert.equal(settlementZoneLabel(z, 'T'), '> $2.2T');
});

test('settlementZone: converged BELOW the lowest strike → the "<lowest" bucket wins', () => {
  const m = [
    { threshold: 1.8, adjusted_prob: 0.02, bucket_prob: 0.01 }, // P(<1.8) = 0.98
    { threshold: 2.0, adjusted_prob: 0.01, bucket_prob: 0.01 },
  ];
  const z = settlementZone(m);
  assert.equal(z.kind, 'below');
  assert.equal(z.hi, 1.8);
  assert.equal(settlementZoneLabel(z, 'T'), '< $1.8T');
});

test('settlementZone: empty ladder → null (degrades, never throws)', () => {
  assert.equal(settlementZone([]), null);
  assert.equal(settlementZoneLabel(null, 'T'), 'n/a');
});

// ── Bug 5: implied-median label (honest <lowest / >highest, not bare n/a) ────────
import { impliedMedianLabel, titleFromSlug, displayTitle } from '../lib/format-detail.mjs';

test('impliedMedianLabel: shows the value when the CDF crosses 50%', () => {
  const m = [{ threshold: 1.8, adjusted_prob: 0.7 }, { threshold: 2.4, adjusted_prob: 0.3 }];
  assert.equal(impliedMedianLabel(m, 2.05, 'T'), '$2.05T');
});

test('impliedMedianLabel: median above the top strike → "> $highest"', () => {
  // even at the highest strike P(>X) ≥ 0.5 → value is above it
  const m = [{ threshold: 1.8, adjusted_prob: 0.95 }, { threshold: 2.4, adjusted_prob: 0.6 }];
  assert.equal(impliedMedianLabel(m, null, 'T'), '> $2.4T');
});

test('impliedMedianLabel: median below the lowest strike → "< $lowest"', () => {
  // even at the lowest strike P(>X) < 0.5 → value is below it
  const m = [{ threshold: 1.8, adjusted_prob: 0.3 }, { threshold: 2.4, adjusted_prob: 0.05 }];
  assert.equal(impliedMedianLabel(m, null, 'T'), '< $1.8T');
});

test('impliedMedianLabel: no markets → n/a (degrades, never throws)', () => {
  assert.equal(impliedMedianLabel([], null, 'T'), 'n/a');
});

// ── Bug 7: title fallback (cleaned slug when no gamma title) ─────────────────────
test('titleFromSlug: humanizes a hyphenated event slug', () => {
  assert.equal(titleFromSlug('how-many-fed-rate-cuts-in-2026'), 'How Many Fed Rate Cuts In 2026');
  assert.equal(titleFromSlug(''), '');
});

test('displayTitle: prefers the stored name, falls back to a cleaned slug', () => {
  assert.equal(displayTitle('SpaceX IPO market cap', 'spacex-ipo'), 'SpaceX IPO market cap');
  assert.equal(displayTitle(null, 'how-many-fed-rate-cuts-in-2026'), 'How Many Fed Rate Cuts In 2026');
  // a name that is just the raw slug is treated as missing → cleaned
  assert.equal(displayTitle('wti-crude-oil', 'wti-crude-oil'), 'Wti Crude Oil');
});
