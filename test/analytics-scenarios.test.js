// test/analytics-scenarios.test.js — Tier-1 analytics, Tier-2 firewall, rounding (D1).
// Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildAnalytics } from '../core/analytics.js';
import { loadMarketConfig } from '../core/market-config.js';
import { impliedSharePrice, buildScenarios } from '../core/scenarios.js';

const SPACEX_CFG = loadMarketConfig('spacex');
import { buildNarrative } from '../core/narrative.js';
import { validateRecord } from '../core/validate.js';
import { roundT, fmtSignedDeltaT } from '../core/format.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LATEST = JSON.parse(readFileSync(join(__dirname, '../docs/api/v1/latest.json'), 'utf8'));

const SNAP = [
  { threshold: 1.8, prob: 0.7 }, { threshold: 2.0, prob: 0.55 },
  { threshold: 2.2, prob: 0.45 }, { threshold: 2.4, prob: 0.3 }, { threshold: 2.6, prob: 0.2 },
];

test('FIREWALL: scenario number without assumptions throws', () => {
  const t = structuredClone(LATEST);
  t.snapshot.derived.scenarios.share_price.assumptions = [];
  assert.throws(() => validateRecord(t), /firewall.*share_price/s);
});

test('FIREWALL: an assumptions key leaking into Tier-1 throws', () => {
  const t = structuredClone(LATEST);
  t.snapshot.derived.market.assumptions = [{ leak: true }];
  assert.throws(() => validateRecord(t), /Tier-2 leak/);
});

test('FIREWALL: missing assumptions_version throws', () => {
  const t = structuredClone(LATEST);
  delete t.assumptions_version;
  assert.throws(() => validateRecord(t), /assumptions_version/);
});

test('the real published record passes (schema + invariants + firewall)', () => {
  assert.equal(validateRecord(LATEST), true);
});

test('impliedSharePrice: central = cap/shares; band inverts the shares range', () => {
  const p = impliedSharePrice(2.0, 2e9, [1.8e9, 2.2e9]);
  assert.equal(p.central, Math.round(2e12 / 2e9)); // 1000
  assert.ok(p.low < p.central && p.central < p.high); // more shares → lower price
  assert.equal(p.low, Math.round(2e12 / 2.2e9));
  assert.equal(p.high, Math.round(2e12 / 1.8e9));
});

test('buildScenarios: "input_required" when shares missing, sourced otherwise', () => {
  const noShares = buildScenarios({ median: 2.0, markets: SNAP, registry: { version: '1.0.0', assumptions: {} } });
  assert.equal(noShares.share_price.status, 'input_required');
  assert.ok(noShares.share_price.assumptions.length >= 1); // still carries the (input_required) assumption view

  const reg = { version: '1.0.0', assumptions: { shares_outstanding: { name: 's', value: 2e9, unit: 'shares', source: 'X', as_of: '2025-12-13', confidence: 'low', range: [1.8e9, 2.2e9], adjustable: true } } };
  const withShares = buildScenarios({ median: 2.0, markets: SNAP, registry: reg });
  assert.ok(withShares.share_price.at_median.central > 0);
  assert.ok(withShares.share_price.assumptions[0].source && withShares.share_price.assumptions[0].as_of);
});

test('analytics: shape/dispersion/velocity computed and sane', () => {
  const a = buildAnalytics({
    markets: SNAP, iqr: { p25: 1.9, p75: 2.45 }, median: 2.1,
    priors: { median_1d: 2.12, median_7d: 2.2, median_30d: 2.0, iqr_width_7d: 0.7, iqr_width_30d: 0.9 },
    asOf: '2026-06-05', config: SPACEX_CFG,
  });
  assert.ok(Math.abs(a.shape.skew_bowley) <= 1);
  assert.ok(a.shape.entropy >= 0 && a.shape.entropy <= 1);
  assert.equal(a.dispersion.trend, 'converging'); // 0.55 width now < 0.9 30d ago
  assert.equal(a.velocity.change_30d.dir, 'up'); // 2.1 vs 2.0
  assert.equal(a.velocity.change_7d.dir, 'down'); // 2.1 vs 2.2
  assert.equal(a.calibration.status, 'pending_resolution');
  assert.ok(!('brier' in a.calibration) && !('score' in a.calibration)); // never faked
});

test('D1 rounding: stored velocity display == formatter, and narrative uses it', () => {
  const v = LATEST.snapshot.derived.market.analytics.velocity;
  for (const k of ['change_24h', 'change_7d', 'change_30d']) {
    if (v[k]) assert.equal(v[k].display, fmtSignedDeltaT(v[k].abs)); // single source of rounding
  }
  // narrative's stated weekly move magnitude matches the stored 7d delta (2dp)
  if (v.change_7d && v.change_7d.dir !== 'flat') {
    const mag = Math.abs(roundT(v.change_7d.abs)).toFixed(2);
    assert.ok(LATEST.snapshot.derived.narrative.includes(`$${mag}T this week`));
  }
});

test('narrative claims are all backed by components; trend gated on confidence', () => {
  const derived = { implied_median: 2.1, confidence: { tier: 'low', reasons: ['price-only history (no bid/ask spread)'] } };
  const analytics = {
    velocity: { change_7d: { abs: -0.2, dir: 'down' }, change_30d: { abs: 0.05, dir: 'up' } },
    shape: { skew_bowley: 0.2 },
    dispersion: { trend: 'converging' },
  };
  const { narrative, narrative_components } = buildNarrative({
    derived, analytics, density: [{ label: '$2–2.2T', prob: 0.3 }],
  });
  assert.equal(narrative_components.dispersion_trend, null); // low confidence → no trend claim
  assert.ok(!/converging|narrowing/.test(narrative));
  assert.ok(/Confidence is low/.test(narrative));
});
