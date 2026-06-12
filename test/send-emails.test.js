// test/send-emails.test.js — the email digest must source its inputs from the
// canonical v1 API. Audit P1-1: the script read the DELETED docs/data.json
// (descending history, today at [0]); the v1 history is ASCENDING with
// same-day replace, so "prior day" = last entry strictly before the current
// record's date — never history[1], never today's own (replaced) entry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDigestInputs, detectSignificantMoves } from '../scripts/send-emails.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const mkLatest = (date, probs) => ({
  snapshot: {
    fetched_at: `${date}T14:00:00.000Z`,
    derived: {
      implied_median: 2.1,
      markets: probs.map((p, i) => ({ label: `>$${i + 1}T`, threshold: i + 1, prob: p })),
    },
  },
});
const mkEntry = (date, probs) => ({
  date,
  implied_median: 2.0,
  markets: probs.map((p, i) => ({ label: `>$${i + 1}T`, threshold: i + 1, prob: p })),
});

test('buildDigestInputs: prior = last entry STRICTLY before today (same-day replaced entry skipped)', () => {
  const latest = mkLatest('2026-06-12', [0.9, 0.5]);
  const history = [
    mkEntry('2026-06-10', [0.8, 0.4]),
    mkEntry('2026-06-11', [0.85, 0.45]),
    mkEntry('2026-06-12', [0.9, 0.5]), // today's own (same-day replace) entry
  ];
  const { current, prior } = buildDigestInputs(latest, history);
  assert.equal(current.date, '2026-06-12');
  assert.equal(prior.date, '2026-06-11', 'must skip today, take the day before');
});

test('buildDigestInputs: no earlier entry → prior null; moves empty', () => {
  const latest = mkLatest('2026-06-12', [0.9]);
  const { prior } = buildDigestInputs(latest, [mkEntry('2026-06-12', [0.9])]);
  assert.equal(prior, null);
  assert.deepEqual(detectSignificantMoves(buildDigestInputs(latest, []).current, prior), []);
});

test('buildDigestInputs: empty/missing history → prior null', () => {
  const latest = mkLatest('2026-06-12', [0.9]);
  assert.equal(buildDigestInputs(latest, []).prior, null);
  assert.equal(buildDigestInputs(latest, undefined).prior, null);
});

test('buildDigestInputs: malformed latest throws loudly', () => {
  assert.throws(() => buildDigestInputs({}, []), /malformed/);
});

test('detectSignificantMoves: ≥5% absolute move detected, smaller ignored', () => {
  const current = { markets: [{ label: '>$2T', threshold: 2, prob: 0.6 }, { label: '>$3T', threshold: 3, prob: 0.3 }] };
  const prior = { markets: [{ label: '>$2T', threshold: 2, prob: 0.54 }, { label: '>$3T', threshold: 3, prob: 0.28 }] };
  const moves = detectSignificantMoves(current, prior);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].label, '>$2T');
});

test('buildDigestInputs: real published v1 files satisfy the digest shape', () => {
  const latest = JSON.parse(readFileSync(join(ROOT, 'docs/api/v1/latest.json'), 'utf8'));
  const history = JSON.parse(readFileSync(join(ROOT, 'docs/api/v1/history-full.json'), 'utf8'));
  const { current, prior } = buildDigestInputs(latest, history);
  assert.match(current.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(current.markets.length > 0);
  for (const m of current.markets.slice(0, 3)) {
    assert.equal(typeof m.label, 'string');
    assert.equal(typeof m.threshold, 'number');
    assert.equal(typeof m.prob, 'number');
  }
  assert.ok(prior, 'real history must yield a prior day');
  assert.ok(prior.date < current.date);
  assert.equal(typeof prior.implied_median, 'number');
});
