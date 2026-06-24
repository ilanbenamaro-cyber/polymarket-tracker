// Locks the unit-aware money parser + display-unit derivation (Bug 1 root cause: the
// old parser `\$(\d+\.?\d*)` dropped thousands-commas and unit suffixes, and the display
// fallback only knew T/B/M → defaulted everything to "T"). parseMoney → absolute dollars;
// deriveUnit picks the display scale from the absolute ladder. See MARKET-TYPES-PLAN.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, deriveUnit, fmtScaled } from '../core/money.js';

test('parseMoney: thousands commas are not truncated', () => {
  assert.equal(parseMoney('$56,000').value, 56000);
  assert.equal(parseMoney('Will the price of Bitcoin be less than $56,000 on June 24?').value, 56000);
});

test('parseMoney: unit suffixes normalize to absolute dollars', () => {
  assert.equal(parseMoney('$1.5T').value, 1.5e12);
  assert.equal(parseMoney('$100B').value, 1e11);
  assert.equal(parseMoney('$53.58K').value, 53580);
  assert.equal(parseMoney('$5M').value, 5e6);
});

test('parseMoney: bare dollar amount, no suffix', () => {
  assert.equal(parseMoney('Will WTI Crude Oil (WTI) hit (HIGH) $90 in June?').value, 90);
});

test('parseMoney: first money token in interval/comparator phrasing', () => {
  assert.equal(parseMoney('between $1.5T and $1.75T').value, 1.5e12);
  assert.equal(parseMoney("$3.0T or greater").value, 3.0e12);
});

test('parseMoney: returns null on a leg with no $ amount (categorical leg)', () => {
  assert.equal(parseMoney('Will Anthropic not IPO by December 31, 2027?'), null);
});

test('deriveUnit: scale chosen from the absolute-dollar magnitude', () => {
  assert.deepEqual(deriveUnit([1.5e12, 2e12, 3e12]), { unit: 'T', divisor: 1e12 });
  assert.deepEqual(deriveUnit([1e11, 6e11]), { unit: 'B', divisor: 1e9 });
  assert.deepEqual(deriveUnit([5e6]), { unit: 'M', divisor: 1e6 });
  assert.deepEqual(deriveUnit([56000, 74000]), { unit: 'K', divisor: 1e3 });
  assert.deepEqual(deriveUnit([90, 120]), { unit: '', divisor: 1 });
});

test('fmtScaled: value (absolute) → headline string in the ladder unit', () => {
  const t = deriveUnit([1.5e12, 3e12]);
  assert.equal(fmtScaled(1.84e12, t), '$1.84T');
  const k = deriveUnit([56000, 74000]);
  assert.equal(fmtScaled(53580, k), '$53.58K');
  const d = deriveUnit([90, 120]);
  assert.equal(fmtScaled(90, d), '$90.00');
});
