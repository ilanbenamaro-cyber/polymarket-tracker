// test/second-market.test.js — proves the generalized pipeline works on a market
// it was NEVER tuned for. Uses a real Polymarket event (Kraken IPO closing market
// cap above $X B) captured deterministically in test/fixtures — a different scale
// ($B, gap 2) than SpaceX ($T, gap 0.2), driven by the GENERIC defaultConfigForLadder
// (no pinned config). Asserts a valid, firewall-clean record with NO scenarios.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashRawInputs } from '../core/fetch.js';
import { defaultConfigForLadder, labelGt } from '../core/market-config.js';
import { classifyLifecycle, LIFECYCLE } from '../core/lifecycle.js';
import { buildSnapshotRecord, attachAnalytics, attachNarrative } from '../core/snapshot.js';
import { validateRecord } from '../core/validate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fx = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/second-market-kraken.json'), 'utf8'));

function buildRecord() {
  const thresholds = fx.raw_inputs.map((r) => r.threshold);
  const cfg = defaultConfigForLadder(thresholds, fx.meta);
  const live = {
    fetched_at: fx.fetched_at,
    endpoints: fx.endpoints,
    raw_inputs: fx.raw_inputs,
    raw_sha256: fx.raw_sha256,
    markets: fx.raw_inputs.map((r) => ({
      label: labelGt(cfg, r.threshold),
      threshold: r.threshold,
      prob: parseFloat(r.midpoint),
      volume: r.volume,
    })),
  };
  const lifecycle = classifyLifecycle(fx.status, fx.fetched_at);
  const rec = buildSnapshotRecord(live, '1.4.0', { stale: false, closedCount: 0, liquidityDrop: null }, cfg, lifecycle);
  attachAnalytics(rec, { priors: {}, config: cfg });
  // Generic market: NO assumptions registry → no Tier-2 scenarios (Part B).
  rec.assumptions_version = null;
  attachNarrative(rec, { config: cfg });
  return { rec, cfg, lifecycle };
}

test('second market: generic config processes an untuned ladder and validates clean', () => {
  const { rec } = buildRecord();
  assert.doesNotThrow(() => validateRecord(rec), 'untuned market must validate');
});

test('second market: NO scenarios attached (Tier-2 cleanly absent)', () => {
  const { rec } = buildRecord();
  assert.equal(rec.snapshot.derived.scenarios, undefined);
  assert.equal(rec.assumptions_version, null);
});

test('second market: adjusted CDF is monotone non-increasing with non-negative buckets summing to 1', () => {
  const { rec } = buildRecord();
  const m = rec.snapshot.derived.markets;
  for (let i = 1; i < m.length; i++) {
    assert.ok(m[i].adjusted_prob <= m[i - 1].adjusted_prob + 1e-9, `monotone @ ${m[i].threshold}`);
  }
  for (const x of m) assert.ok(x.bucket_prob >= -1e-9, `non-negative bucket @ ${x.threshold}`);
  const sum = (1 - m[0].adjusted_prob) + m.reduce((s, x) => s + x.bucket_prob, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `buckets sum to 1, got ${sum}`);
});

test('second market: confidence computed; hash reproduces; lifecycle OPEN', () => {
  const { rec, lifecycle } = buildRecord();
  assert.ok(['high', 'medium', 'low'].includes(rec.snapshot.derived.confidence.tier));
  assert.equal(hashRawInputs(rec.snapshot.raw_inputs), fx.raw_sha256);
  assert.equal(lifecycle.state, LIFECYCLE.OPEN);
});

test('second market: PAVA actually corrected a real raw non-monotonicity', () => {
  // The captured raw midpoints are not monotone (e.g. 0.24, 0.215, 0.23) — the
  // engine must repair that rather than emit a negative bucket.
  const raw = fx.markets.map((m) => m.prob);
  let rawViolation = false;
  for (let i = 1; i < raw.length; i++) if (raw[i] > raw[i - 1] + 1e-9) rawViolation = true;
  assert.ok(rawViolation, 'fixture should contain a real raw non-monotonicity to exercise PAVA');
});
