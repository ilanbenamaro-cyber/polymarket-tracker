// test/signal-synthesis.test.js — Increment 5: narrative cross-signal synthesis.
//
// The narrative states each signal independently; synthesizeSignals adds ONE closing sentence that
// reasons across them (conflict or reinforcement), or null when they agree / history is insufficient.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeSignals } from '../lib/format-detail.mjs';

const okVel = (over = {}) => ({ status: 'ok', change: 0, trend: 'steady', ...over });

test('CONFLICT: rising median + falling confidence', () => {
  const s = synthesizeSignals({ velocity: okVel({ change: 0.05, trend: 'rising' }), confidenceTrend: 'falling', kind: 'ladder' });
  assert.match(s, /median is rising but confidence is falling/);
});

test('CONFLICT: converging dispersion + volatile velocity', () => {
  const s = synthesizeSignals({ velocity: okVel({ change: 0.02, trend: 'volatile' }), dispersion: { status: 'ok', direction: 'converging' }, kind: 'ladder' });
  assert.match(s, /IQR is narrowing but price drift is volatile/);
});

test('REINFORCEMENT: rising median + converging dispersion + high confidence', () => {
  const s = synthesizeSignals({ velocity: okVel({ change: 0.05, trend: 'rising' }), dispersion: { status: 'ok', direction: 'converging' }, currentConfidence: 'high', kind: 'ladder' });
  assert.match(s, /Rising median, narrowing uncertainty band, and high confidence/);
});

test('BINARY: falling probability + recent jump → pricing out', () => {
  const s = synthesizeSignals({ velocity: okVel({ change: -0.08, trend: 'volatile', jump: { hasRecentJump: true, jumpDate: '2026-06-10' } }), kind: 'binary' });
  assert.match(s, /Probability is falling and momentum is accelerating/);
});

test('JUMP fallback: a recent jump with no other conflict', () => {
  const s = synthesizeSignals({ velocity: okVel({ change: 0.0, jump: { hasRecentJump: true, jumpDate: '2026-06-03' } }), kind: 'ladder' });
  assert.match(s, /moved sharply on 2026-06-03 — the current reading reflects post-jump consensus/);
});

test('NO conflict → null (the base narrative is sufficient)', () => {
  assert.equal(synthesizeSignals({ velocity: okVel({ change: 0.05, trend: 'rising' }), confidenceTrend: 'rising', currentConfidence: 'medium', kind: 'ladder' }), null);
});

test('insufficient history (velocity collecting) → null', () => {
  assert.equal(synthesizeSignals({ velocity: { status: 'collecting' }, kind: 'ladder' }), null);
  assert.equal(synthesizeSignals({ kind: 'ladder' }), null);
});
