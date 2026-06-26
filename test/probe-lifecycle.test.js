// test/probe-lifecycle.test.js — audit F1: probeLifecycle must classify the market shape FIRST
// and route to the shape's lifecycle-status fetcher, so a non-survival market never hits the
// survival `$X` threshold parser (which threw "Cannot parse threshold" → 500 on the PROBE path).
//
// probeLifecycle does network I/O; here we inject mock deps to prove the routing without gamma.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeLifecycle } from '../lib/compute.mjs';

const SHAPES = ['binary', 'bucket_pmf', 'directional_touch', 'categorical', 'survival'];
const openStatus = () => [{ threshold: 1, closed: false, active: true, accepting_orders: true, umaResolutionStatus: null, outcomes: null, outcomePrices: null }];

/** Deps whose status fetchers record which shape-branch ran (and never parse `$X`). */
function spyDeps(shape, statusByShape = {}) {
  const calls = [];
  const statusFetchers = Object.fromEntries(SHAPES.map((s) => [s, async (slug) => {
    calls.push({ shape: s, slug });
    return statusByShape[s] ?? openStatus();
  }]));
  return { deps: { classifyShape: async () => shape, statusFetchers }, calls };
}

test('routes each shape to its OWN status fetcher (never falls back to survival)', async () => {
  for (const shape of SHAPES) {
    const { deps, calls } = spyDeps(shape);
    const { lifecycle } = await probeLifecycle('any-slug', deps);
    assert.equal(calls.length, 1, `${shape}: exactly one status fetch`);
    assert.equal(calls[0].shape, shape, `${shape}: routed to its own fetcher`);
    assert.equal(calls[0].slug, 'any-slug');
    assert.equal(lifecycle.state, 'OPEN');
  }
});

test('a non-survival shape never invokes the survival fetcher (the $X-parser path)', async () => {
  for (const shape of ['binary', 'bucket_pmf', 'directional_touch', 'categorical']) {
    const { deps, calls } = spyDeps(shape);
    await probeLifecycle('s', deps);
    assert.ok(!calls.some((c) => c.shape === 'survival'), `${shape} must not touch the survival parser`);
  }
});

test('classifies lifecycle from the shape fetcher output (RESOLVED propagates)', async () => {
  const resolved = [{ threshold: 1, closed: true, active: false, accepting_orders: false, umaResolutionStatus: 'resolved', outcomes: '["Yes","No"]', outcomePrices: '["1","0"]' }];
  const { deps } = spyDeps('binary', { binary: resolved });
  const { lifecycle } = await probeLifecycle('s', deps);
  assert.equal(lifecycle.state, 'RESOLVED');
});

test('an unknown/missing shape falls back to the survival fetcher (no crash)', async () => {
  const { deps, calls } = spyDeps('mystery');
  const { lifecycle } = await probeLifecycle('s', deps);
  assert.equal(calls[0].shape, 'survival');
  assert.equal(lifecycle.state, 'OPEN');
});
