// Locks the multi-leg market-shape classifier against REAL gamma question strings
// (fetched live 2026-06-24). These four shapes were all previously mislabeled 'ladder'
// and fed into the survival-curve model — the P0 cluster (Bugs 1/2/4). See
// MARKET-TYPES-PLAN.md and core/fetch.js ladderShapeFromMarkets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ladderShapeFromMarkets } from '../core/fetch.js';

const q = (arr) => arr.map((question) => ({ question }));

test('survival ladder: all "above $X" nested legs (SpaceX)', () => {
  const m = q([
    'SpaceX IPO closing market cap above $1T?',
    'SpaceX IPO closing market cap above $1.4T?',
    'SpaceX IPO closing market cap above $2T?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'survival');
});

test('bucket PMF: "between / less than / greater than" intervals (Bitcoin)', () => {
  const m = q([
    'Will the price of Bitcoin be between $62,000 and $64,000 on June 24?',
    'Will the price of Bitcoin be less than $56,000 on June 24?',
    'Will the price of Bitcoin be greater than $74,000 on June 24?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'bucket_pmf');
});

test('bucket PMF tolerates one categorical leg (Anthropic IPO "not IPO")', () => {
  const m = q([
    "Will Anthropic's market cap be less than $1.25T at market close on IPO day?",
    "Will Anthropic's market cap be between $1.5T and $1.75T at market close on IPO day?",
    "Will Anthropic's market cap be $3.0T or greater at market close on IPO day?",
    'Will Anthropic not IPO by December 31, 2027?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'bucket_pmf');
});

test('directional touch: "(LOW)/(HIGH) $X hit" legs, incl. colliding levels (WTI)', () => {
  const m = q([
    'Will WTI Crude Oil (WTI) hit (LOW) $90 in June?',
    'Will WTI Crude Oil (WTI) hit (HIGH) $90 in June?',
    'Will WTI Crude Oil (WTI) hit (HIGH) $120 in June?',
    'Will WTI Crude Oil (WTI) hit (LOW) $40 in June?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'directional_touch');
});

test('directional touch: Silver HIGH/LOW legs', () => {
  const m = q([
    'Will Silver (XAGUSD) hit (HIGH) $71 Week of June 22 2026?',
    'Will Silver (XAGUSD) hit (LOW) $58 Week of June 22 2026?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'directional_touch');
});

test('categorical: multi-leg, no numeric $ threshold', () => {
  const m = q([
    'Will the Fed cut rates in June?',
    'Will the Fed hold rates in June?',
  ]);
  assert.equal(ladderShapeFromMarkets(m), 'categorical');
});
