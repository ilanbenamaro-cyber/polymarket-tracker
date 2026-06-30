// test/phase1-spacex-parity.test.js — THE BLOCKING GATE for the Phase 1
// generalization. Proves that running the generalized core/ with the SpaceX
// market config reproduces the frozen pre-generalization oracle EXACTLY. A diff
// here is a real behavior change to investigate — never edit the fixture to pass.
//
// Gate 1: hashRawInputs(frozen raw_inputs) === frozen raw_sha256 (recipe untouched).
// Gate 2: the full derived block, rebuilt via generalized core/ + the SpaceX
//         config over the frozen inputs, is deep-equal to the frozen derived.
// Gate 2b (confidence split): the frozen derived.confidence was DELIBERATELY regenerated to the
//         new two-dimension shape { reliability, liquidity } when the single tier was split (a
//         provable shape migration, NOT fixture-editing to mask a regression). This gate proves the
//         split preserved the frozen single-tier ASSESSMENT: reliability.tier === the old frozen
//         tier, liquidity.tier === 'high', worst(reliability,liquidity) recovers the old tier, and
//         the two new reason lists' union equals the old reasons. The OLD values are hardcoded here
//         (independent of the fixture), so the proof is meaningful even though the fixture moved.
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
import { worstTier, collapseConfidenceTier } from '../core/confidence.js';
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

/** Rebuild the full SpaceX record from the frozen oracle inputs through the generalized core/.
 *  Shared by GATE 2 (full deep-equal) and GATE 2b (confidence faithfulness proof). */
function rebuildSpaceXRecord() {
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
  return rec;
}

test('GATE 2: generalized core/ + SpaceX config reproduces the frozen derived block', () => {
  const rec = rebuildSpaceXRecord();
  // Deep-equal the entire derived block (median, mean, iqr, buckets, confidence,
  // markets, analytics, narrative, scenarios, freshness) against the frozen oracle.
  assert.deepEqual(rec.snapshot.derived, fx.snapshot.derived);
});

test('GATE 2b: the confidence split is provably faithful to the frozen single-tier assessment', () => {
  // The frozen single tier BEFORE the split — hardcoded here, independent of the (now-regenerated)
  // fixture, so the proof has real content. The old single confidence was the worst of all signals;
  // the split partitions those signals into two dimensions, so the old assessment must be recoverable.
  const OLD_TIER = 'high';
  const OLD_REASONS = ['full threshold set, monotonic, tight spreads, deep books'];

  const c = rebuildSpaceXRecord().snapshot.derived.confidence;
  // Shape: two independent {tier,score,reasons} dimensions.
  assert.ok(c.reliability && c.liquidity, 'confidence has reliability + liquidity dimensions');

  // 1) RELIABILITY preserves the frozen single tier (the number's trustworthiness was the dominant
  //    meaning of the old HIGH — SpaceX is a full, monotonic, tight-spread ladder).
  assert.equal(c.reliability.tier, OLD_TIER, 'reliability.tier === frozen single tier');
  // 2) LIQUIDITY is HIGH (the old "deep books" clause — SpaceX books are deep).
  assert.equal(c.liquidity.tier, 'high', 'liquidity.tier === high (deep books)');
  // 3) The old collapsed tier is recoverable as worst(reliability, liquidity).
  assert.equal(worstTier([c.reliability.tier, c.liquidity.tier]), OLD_TIER, 'worst() recovers old tier');
  assert.equal(collapseConfidenceTier(c), OLD_TIER, 'collapseConfidenceTier() recovers old tier');
  // 4) Every old reason is preserved across exactly one of the two new lists (their union == old).
  assert.deepEqual(
    [...c.reliability.reasons, ...c.liquidity.reasons].join(', ').split(', '),
    OLD_REASONS.join(', ').split(', '),
    'reliability ∪ liquidity reasons === frozen reasons (each in exactly one list)'
  );
  // 5) No reason is double-counted across the two dimensions.
  const overlap = c.reliability.reasons.filter((r) => c.liquidity.reasons.includes(r));
  assert.deepEqual(overlap, [], 'no reason appears in both dimensions');
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
