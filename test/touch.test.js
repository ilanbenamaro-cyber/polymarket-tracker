// Directional-touch core (WTI/Silver "(LOW)/(HIGH) hit $X"). These markets price
// P(price touches a level before expiry) — NOT a settlement distribution, so there is no
// implied median. The honest signal is the IMPLIED RANGE: the band between the HIGH series'
// 50% crossover (upper: 50% chance of breaking above) and the LOW series' 50% crossover
// (lower: 50% chance of breaking below). parseTouchLeg locked against real gamma questions;
// impliedRange against controlled series with hand-computed crossovers. See MARKET-TYPES-PLAN.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTouchLeg, impliedRange } from '../core/touch.js';

test('parseTouchLeg: HIGH/LOW side + level (WTI)', () => {
  assert.deepEqual(parseTouchLeg('Will WTI Crude Oil (WTI) hit (HIGH) $90 in June?'), { side: 'HIGH', level: 90 });
  assert.deepEqual(parseTouchLeg('Will WTI Crude Oil (WTI) hit (LOW) $85 in June?'), { side: 'LOW', level: 85 });
});

test('parseTouchLeg: Silver levels', () => {
  assert.deepEqual(parseTouchLeg('Will Silver (XAGUSD) hit (HIGH) $71 Week of June 22 2026?'), { side: 'HIGH', level: 71 });
  assert.deepEqual(parseTouchLeg('Will Silver (XAGUSD) hit (LOW) $58 Week of June 22 2026?'), { side: 'LOW', level: 58 });
});

test('parseTouchLeg: a non-touch leg → null', () => {
  assert.equal(parseTouchLeg('SpaceX IPO closing market cap above $1.4T?'), null);
});

test('impliedRange: 50% crossovers of the HIGH (down) and LOW (up) series', () => {
  // HIGH = P(touch ≥ level), decreasing; crosses 0.5 between 85(0.6) and 90(0.4) → 87.5
  const high = [{ level: 80, prob: 0.7 }, { level: 85, prob: 0.6 }, { level: 90, prob: 0.4 }, { level: 95, prob: 0.2 }];
  // LOW = P(touch ≤ level), increasing; crosses 0.5 between 60(0.4) and 65(0.6) → 62.5
  const low = [{ level: 55, prob: 0.2 }, { level: 60, prob: 0.4 }, { level: 65, prob: 0.6 }, { level: 70, prob: 0.8 }];
  assert.deepEqual(impliedRange(high, low), { low: 62.5, high: 87.5, confidence: 0.5 });
});

test('impliedRange: null bound when a series never crosses 50% (no false precision)', () => {
  const high = [{ level: 80, prob: 0.3 }, { level: 90, prob: 0.1 }]; // already < 0.5 → no upper crossover
  const low = [{ level: 55, prob: 0.6 }, { level: 60, prob: 0.8 }]; // already > 0.5 → no lower crossover
  assert.deepEqual(impliedRange(high, low), { low: null, high: null, confidence: 0.5 });
});
