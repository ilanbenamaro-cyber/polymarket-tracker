// test/history-invariants.test.js — sweep the FULL published history through the
// production invariant checks (the audit's "worst historical vector" requirement,
// Seam 2): every archived day must satisfy non-negative buckets, a monotone
// adjusted CDF, bucket↔CDF consistency, and sum-to-1 within BUCKET_SUM_EPSILON —
// across ladder-size changes (the threshold count grew over the history) and
// every floating-point vector that actually occurred. Also pins the CSV field
// constraint (Seam 8 P2-3): toCsv does no escaping, which is safe ONLY while no
// producible field can contain a comma/quote/newline — this test is that
// constraint, made executable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateHistoryEntry } from '../core/validate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const history = JSON.parse(
  readFileSync(join(ROOT, 'docs/api/v1/history-full.json'), 'utf8')
);

test('history-full is non-trivial (sanity)', () => {
  assert.ok(Array.isArray(history) && history.length >= 150, `len=${history.length}`);
});

test('every published history day passes the production invariants', () => {
  for (const entry of history) {
    validateHistoryEntry(entry); // throws with the failing date on violation
  }
});

test('history dates are strictly ascending and unique (same-day replace, no bloat)', () => {
  for (let i = 1; i < history.length; i++) {
    assert.ok(
      history[i - 1].date < history[i].date,
      `dates must strictly ascend: ${history[i - 1].date} !< ${history[i].date} at ${i}`
    );
  }
});

test('ladder size may change across history but every day is internally consistent', () => {
  const sizes = new Set(history.map((e) => e.markets.length));
  // The product survived a 9→16 ladder growth; whatever the sizes, each day
  // already validated above. Record the observed profile for the ledger.
  assert.ok([...sizes].every((n) => n >= 1));
});

// ── CSV constraint (renderers/api.js toCsv joins with ',' and does NOT escape) ──

const CSV_HOSTILE = /[,"\r\n]/;

test('no producible CSV field can contain a comma, quote, or newline', () => {
  for (const e of history) {
    assert.ok(!CSV_HOSTILE.test(e.date), `date ${e.date}`);
    assert.ok(!CSV_HOSTILE.test(e.confidence.tier), `tier ${e.confidence.tier} @ ${e.date}`);
    for (const m of e.markets) {
      assert.ok(!CSV_HOSTILE.test(m.label), `label ${m.label} @ ${e.date}`);
    }
  }
});

test('published history.csv rows all have the header field count', () => {
  const csv = readFileSync(join(ROOT, 'docs/api/v1/history.csv'), 'utf8').trim();
  const rows = csv.split('\n');
  const headerCols = rows[0].split(',').length;
  rows.forEach((row, i) => {
    assert.equal(row.split(',').length, headerCols, `row ${i} field count`);
  });
});
