// test/lifecycle.test.js — the two-stage resolution guard (ARCHITECTURE §5).
// Classifier states + record-level invariants: a RESOLVED record is frozen and
// carries a final outcome and is NOT flagged stale; a CLOSED_PENDING record claims
// NO final outcome; an OPEN market is unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyLifecycle, LIFECYCLE } from '../core/lifecycle.js';
import { defaultConfigForLadder, labelGt } from '../core/market-config.js';
import { buildSnapshotRecord, attachAnalytics, attachNarrative } from '../core/snapshot.js';
import { validateRecord } from '../core/validate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fx = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/second-market-kraken.json'), 'utf8'));

const rungs = (over) => fx.status.map((s) => ({
  threshold: s.threshold,
  closed: false,
  umaResolutionStatus: null,
  outcomes: '["Yes", "No"]',
  outcomePrices: '["0.2", "0.8"]',
  ...over(s),
}));

// ── classifier ──
test('classify: all live → OPEN, no outcome', () => {
  const lc = classifyLifecycle(rungs(() => ({})), '2026-06-17T00:00:00Z');
  assert.equal(lc.state, LIFECYCLE.OPEN);
  assert.equal(lc.resolved_outcome, null);
});

test('classify: all closed but UMA unconfirmed → CLOSED_PENDING, no outcome', () => {
  const lc = classifyLifecycle(rungs(() => ({ closed: true })), null);
  assert.equal(lc.state, LIFECYCLE.CLOSED_PENDING);
  assert.equal(lc.resolved_outcome, null);
});

test('classify: closed:true on SOME rungs only → still OPEN (conservative)', () => {
  let i = 0;
  const lc = classifyLifecycle(rungs(() => ({ closed: i++ === 0 })), null);
  assert.equal(lc.state, LIFECYCLE.OPEN);
});

test('classify: all UMA-resolved → RESOLVED with the settled outcome per rung', () => {
  const lc = classifyLifecycle(
    rungs(() => ({ closed: true, umaResolutionStatus: 'resolved', outcomePrices: '["0", "1"]' })),
    '2026-06-17T00:00:00Z'
  );
  assert.equal(lc.state, LIFECYCLE.RESOLVED);
  assert.equal(lc.resolved_outcome.length, fx.status.length);
  assert.equal(lc.resolved_outcome[0].outcome, 'No'); // price "1" is on "No"
});

test('classify: closed but uma "proposed"/"disputed" is NOT resolved (no false final)', () => {
  for (const st of ['proposed', 'disputed', 'challenged', null]) {
    const lc = classifyLifecycle(rungs(() => ({ closed: true, umaResolutionStatus: st })), null);
    assert.equal(lc.state, LIFECYCLE.CLOSED_PENDING, `uma=${st} must not be RESOLVED`);
  }
});

// ── record-level invariants ──
function recordWith(lifecycle) {
  const cfg = defaultConfigForLadder(fx.raw_inputs.map((r) => r.threshold), fx.meta);
  const live = {
    fetched_at: fx.fetched_at, endpoints: fx.endpoints, raw_inputs: fx.raw_inputs, raw_sha256: fx.raw_sha256,
    markets: fx.raw_inputs.map((r) => ({ label: labelGt(cfg, r.threshold), threshold: r.threshold, prob: parseFloat(r.midpoint), volume: r.volume })),
  };
  const rec = buildSnapshotRecord(live, '1.4.0', { stale: false, closedCount: live.markets.length, liquidityDrop: null }, cfg, lifecycle);
  attachAnalytics(rec, { priors: {}, config: cfg });
  rec.assumptions_version = null;
  attachNarrative(rec, { config: cfg });
  return rec;
}

test('record: RESOLVED is frozen — carries outcome, marked final, not stale', () => {
  const rec = recordWith({ state: 'RESOLVED', resolved_outcome: [{ threshold: 16, outcome: 'No' }], as_of: fx.fetched_at });
  assert.doesNotThrow(() => validateRecord(rec));
  assert.equal(rec.snapshot.lifecycle.state, 'RESOLVED');
  assert.equal(rec.snapshot.derived.freshness.final, true);
});

test('record: RESOLVED without an outcome is rejected by validate', () => {
  const rec = recordWith({ state: 'RESOLVED', resolved_outcome: null, as_of: fx.fetched_at });
  assert.throws(() => validateRecord(rec), /lifecycle: RESOLVED/);
});

test('record: CLOSED_PENDING claiming an outcome is rejected by validate', () => {
  const rec = recordWith({ state: 'CLOSED_PENDING', resolved_outcome: [{ threshold: 16, outcome: 'No' }], as_of: fx.fetched_at });
  assert.throws(() => validateRecord(rec), /lifecycle: CLOSED_PENDING/);
});

test('record: a settled market is not dragged to low confidence by its closed rungs', () => {
  // closedCount == every rung, but lifecycle is non-OPEN → "closed" is expected,
  // not a data-quality anomaly. (An OPEN market with all rungs closed WOULD be.)
  const settled = recordWith({ state: 'CLOSED_PENDING', resolved_outcome: null, as_of: fx.fetched_at });
  // "closed / not accepting" is now a LIQUIDITY reason; for a non-OPEN market it is suppressed there.
  const c = settled.snapshot.derived.confidence;
  const reasons = [...c.reliability.reasons, ...c.liquidity.reasons].join(' ');
  assert.doesNotMatch(reasons, /closed \/ not accepting/);
});

test('record: OPEN market has no freshness.final flag (byte-identical-safe)', () => {
  const rec = recordWith({ state: 'OPEN', resolved_outcome: null, as_of: fx.fetched_at });
  assert.equal('final' in rec.snapshot.derived.freshness, false);
});
