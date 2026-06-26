// test/price-history.test.js — the pure CLOB price-history reconstruction (backfill I1).
//
// The history backfill rebuilds market_history from Polymarket's per-token prices-history
// (`{history:[{t,p}]}`, daily fidelity). This module is the PURE half: floor each point to a
// UTC date, dedup to the last point per date per token, then forward-fill across the union of
// dates so every reconstructable day has a full leg set. No I/O — fetching lives in I3.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utcDate, dailyByDate, reconstructDailySeries } from '../core/price-history.js';

// ── utcDate ───────────────────────────────────────────────────────────────────
test('utcDate floors a unix-seconds timestamp to its UTC calendar date', () => {
  // the real SpaceX >$1T first point: 1765497607 = 2025-12-12T00:00:07Z
  assert.equal(utcDate(1765497607), '2025-12-12');
  assert.equal(utcDate(0), '1970-01-01');
  // a few seconds before midnight stays on the prior day
  assert.equal(utcDate(1765497607 - 8), '2025-12-11');
});

// ── dailyByDate ─────────────────────────────────────────────────────────────────
const D = (dateStr, hour, p) => ({ t: Math.floor(Date.parse(`${dateStr}T${hour}Z`) / 1000), p });

test('dailyByDate keeps the LAST point per UTC date and returns dates ascending', () => {
  const hist = [
    D('2026-01-02', '00:00:05', 0.40),
    D('2026-01-01', '00:00:07', 0.30),
    D('2026-01-02', '23:50:00', 0.45), // later same-day point wins
  ];
  const m = dailyByDate(hist);
  assert.deepEqual([...m.keys()], ['2026-01-01', '2026-01-02']);
  assert.equal(m.get('2026-01-01'), 0.30);
  assert.equal(m.get('2026-01-02'), 0.45); // the 23:50 point, not the 00:00 one
});

test('dailyByDate ignores malformed points (null t/p) and tolerates empty input', () => {
  assert.equal(dailyByDate([]).size, 0);
  assert.equal(dailyByDate(null).size, 0);
  const m = dailyByDate([{ t: null, p: 0.5 }, { t: 100, p: null }, D('2026-01-01', '00:00:01', 0.5)]);
  assert.equal(m.size, 1);
  assert.equal(m.get('1970-01-01'), undefined); // the malformed ones dropped
});

// ── reconstructDailySeries ──────────────────────────────────────────────────────
test('reconstructDailySeries: aligned legs → every date complete, nothing forward-filled', () => {
  const A = [D('2026-01-01', '00:00:03', 0.90), D('2026-01-02', '00:00:09', 0.92)];
  const B = [D('2026-01-01', '00:00:21', 0.40), D('2026-01-02', '00:00:11', 0.45)];
  const { tokenIds, rows } = reconstructDailySeries([{ token_id: 'A', history: A }, { token_id: 'B', history: B }]);
  assert.deepEqual(tokenIds, ['A', 'B']);
  assert.deepEqual(rows.map((r) => r.date), ['2026-01-01', '2026-01-02']);
  assert.deepEqual(rows[0].prices, { A: 0.90, B: 0.40 });
  assert.equal(rows[0].complete, true);
  assert.deepEqual(rows[0].filled, { A: false, B: false });
});

test('reconstructDailySeries: a per-leg gap is forward-filled and flagged (still complete)', () => {
  // B is missing 2026-01-02 → carry its 01-01 value forward.
  const A = [D('2026-01-01', '00:00:03', 0.90), D('2026-01-02', '00:00:09', 0.92), D('2026-01-03', '00:00:01', 0.93)];
  const B = [D('2026-01-01', '00:00:21', 0.40), D('2026-01-03', '00:00:05', 0.50)];
  const { rows } = reconstructDailySeries([{ token_id: 'A', history: A }, { token_id: 'B', history: B }]);
  const jan2 = rows.find((r) => r.date === '2026-01-02');
  assert.equal(jan2.prices.B, 0.40);     // carried from 01-01
  assert.equal(jan2.filled.B, true);     // flagged as forward-filled
  assert.equal(jan2.filled.A, false);
  assert.equal(jan2.complete, true);     // all legs present (one carried)
});

test('reconstructDailySeries: a leg that starts late leaves earlier days incomplete (no back-fill)', () => {
  const A = [D('2026-01-01', '00:00:03', 0.90), D('2026-01-02', '00:00:09', 0.92)];
  const B = [D('2026-01-02', '00:00:21', 0.40)]; // B only exists from 01-02
  const { rows } = reconstructDailySeries([{ token_id: 'A', history: A }, { token_id: 'B', history: B }]);
  const jan1 = rows.find((r) => r.date === '2026-01-01');
  const jan2 = rows.find((r) => r.date === '2026-01-02');
  assert.equal(jan1.complete, false);          // B has no value yet → not back-filled
  assert.equal('B' in jan1.prices, false);
  assert.equal(jan2.complete, true);
});

test('reconstructDailySeries: dedups multiple same-date points to the last one', () => {
  const A = [D('2026-01-01', '01:00:00', 0.10), D('2026-01-01', '20:00:00', 0.80)];
  const { rows } = reconstructDailySeries([{ token_id: 'A', history: A }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].prices.A, 0.80);
});

test('reconstructDailySeries: all-empty histories → no rows, tokenIds preserved', () => {
  const out = reconstructDailySeries([{ token_id: 'A', history: [] }, { token_id: 'B', history: null }]);
  assert.deepEqual(out.tokenIds, ['A', 'B']);
  assert.deepEqual(out.rows, []);
});
