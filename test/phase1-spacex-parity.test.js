// test/phase1-spacex-parity.test.js — THE BLOCKING GATE for the Phase 1
// generalization. Proves that running the generalized core/ with the SpaceX
// market config reproduces the frozen pre-generalization oracle EXACTLY. A diff
// here is a real behavior change to investigate — never edit the fixture to pass.
//
// Gate 1: hashRawInputs(frozen raw_inputs) === frozen raw_sha256 (recipe untouched).
// Gate 2: the full derived block, rebuilt via generalized core/ + the SpaceX
//         config over the frozen inputs, is deep-equal to the frozen derived.
// Gate 3: every frozen history day, re-derived through generalized core/ with the
//         SpaceX config, reproduces the frozen curve math. (Confidence is excluded
//         from Gate 3 only because history entries do not retain raw_inputs, so the
//         spread that drove an appended day's confidence cannot be reconstructed
//         from stored history — confidence is fully covered by Gate 2.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashRawInputs } from '../core/fetch.js';
import { loadMarketConfig, labelGt } from '../core/market-config.js';
import {
  buildSnapshotRecord, attachAnalytics, attachScenarios, attachNarrative, buildHistoryEntry,
} from '../core/snapshot.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fx = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/spacex-reference-latest.json'), 'utf8'));
const histFx = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/spacex-reference-history.json'), 'utf8'));
const assumptions = JSON.parse(readFileSync(join(ROOT, 'core/assumptions.json'), 'utf8'));
const CFG = loadMarketConfig('spacex');

const dateMinus = (s, n) => {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const entryOnOrBefore = (h, target) => {
  let r = null;
  for (const e of h) { if (e.date <= target) r = e; else break; }
  return r;
};

test('GATE 1: frozen raw_sha256 reproduces (hash recipe untouched)', () => {
  assert.equal(hashRawInputs(fx.snapshot.raw_inputs), fx.snapshot.source.raw_sha256);
});

test('GATE 2: generalized core/ + SpaceX config reproduces the frozen derived block', () => {
  // Reconstruct the orchestrator inputs from the frozen oracle.
  const live = {
    fetched_at: fx.snapshot.fetched_at,
    endpoints: fx.snapshot.source.endpoints,
    raw_inputs: fx.snapshot.raw_inputs,
    raw_sha256: fx.snapshot.source.raw_sha256,
    markets: fx.snapshot.raw_inputs.map((r) => ({
      label: labelGt(CFG, r.threshold),
      threshold: r.threshold,
      prob: parseFloat(r.midpoint),
      volume: r.volume,
    })),
  };
  // Confidence reasons in the frozen record are the benign default → anomalies
  // were all falsy at capture time.
  const anomalies = { stale: false, closedCount: 0, liquidityDrop: null };
  const today = live.fetched_at.slice(0, 10);
  const p1d = entryOnOrBefore(histFx, dateMinus(today, 1));
  const p7d = entryOnOrBefore(histFx, dateMinus(today, 7));
  const p30d = entryOnOrBefore(histFx, dateMinus(today, 30));
  const widthOf = (e) => (e && e.iqr && e.iqr.p25 != null && e.iqr.p75 != null ? e.iqr.p75 - e.iqr.p25 : null);
  const priors = {
    median_1d: p1d ? p1d.implied_median : null,
    median_7d: p7d ? p7d.implied_median : null,
    median_30d: p30d ? p30d.implied_median : null,
    iqr_width_7d: widthOf(p7d),
    iqr_width_30d: widthOf(p30d),
  };

  const rec = buildSnapshotRecord(live, fx.methodology_version, anomalies, CFG, null);
  attachAnalytics(rec, { priors, config: CFG });
  attachScenarios(rec, assumptions);
  attachNarrative(rec, { prior7d: priors.median_7d, prior30d: priors.median_30d, config: CFG });

  // Deep-equal the entire derived block (median, mean, iqr, buckets, confidence,
  // markets, analytics, narrative, scenarios, freshness) against the frozen oracle.
  assert.deepEqual(rec.snapshot.derived, fx.snapshot.derived);
});

test('GATE 3: every frozen history day reproduces its curve math through generalized core/', () => {
  for (const day of histFx) {
    const markets = day.markets.map((m) => ({
      label: m.label, threshold: m.threshold, prob: m.raw_prob, volume: m.volume,
    }));
    const re = buildHistoryEntry(day.date, markets, null, CFG);
    // rawInputs-independent fields (curve math): generalization must not move them.
    assert.equal(re.implied_median, day.implied_median, `median @ ${day.date}`);
    assert.equal(re.implied_mean, day.implied_mean, `mean @ ${day.date}`);
    assert.deepEqual(re.iqr, day.iqr, `iqr @ ${day.date}`);
    assert.equal(re.prob_1_8t, day.prob_1_8t, `prob_1_8t @ ${day.date}`);
    assert.equal(re.prob_2_0t, day.prob_2_0t, `prob_2_0t @ ${day.date}`);
    assert.equal(re.prob_2_4t, day.prob_2_4t, `prob_2_4t @ ${day.date}`);
    assert.deepEqual(re.adjustment, day.adjustment, `adjustment @ ${day.date}`);
    assert.deepEqual(
      re.markets.map((m) => ({ t: m.threshold, a: m.adjusted_prob, b: m.bucket_prob, v: m.volume_tier })),
      day.markets.map((m) => ({ t: m.threshold, a: m.adjusted_prob, b: m.bucket_prob, v: m.volume_tier })),
      `markets curve @ ${day.date}`
    );
  }
});
