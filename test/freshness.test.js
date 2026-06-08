// test/freshness.test.js — proves the Tier-1 data-freshness policy: the published
// record carries policy only (no frozen flag), stale_after is the as-of anchor plus
// the documented threshold, and read-time evaluation flips exactly at the boundary.
// Run: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFreshness, ageLabel, STALENESS_THRESHOLD_HOURS } from '../core/freshness.js';

const AS_OF = '2026-06-08T14:00:00.000Z';

test('published policy carries no frozen age/flag (read-time quantities)', () => {
  const f = buildFreshness(AS_OF);
  assert.equal(f.as_of, AS_OF);
  assert.equal(f.staleness_threshold_hours, STALENESS_THRESHOLD_HOURS);
  assert.equal('age_hours' in f, false);
  assert.equal('stale' in f, false);
});

test('stale_after = as_of + threshold (single consumer comparison)', () => {
  const f = buildFreshness(AS_OF);
  const expected = new Date(Date.parse(AS_OF) + STALENESS_THRESHOLD_HOURS * 3_600_000).toISOString();
  assert.equal(f.stale_after, expected);
});

test('read-time evaluation: not stale just inside the window', () => {
  const now = new Date(Date.parse(AS_OF) + (STALENESS_THRESHOLD_HOURS - 1) * 3_600_000).toISOString();
  const f = buildFreshness(AS_OF, now);
  assert.equal(f.stale, false);
  assert.ok(Math.abs(f.age_hours - (STALENESS_THRESHOLD_HOURS - 1)) < 1e-6);
});

test('read-time evaluation: stale just past the window', () => {
  const now = new Date(Date.parse(AS_OF) + (STALENESS_THRESHOLD_HOURS + 1) * 3_600_000).toISOString();
  assert.equal(buildFreshness(AS_OF, now).stale, true);
});

test('a fresh snapshot (just built) is never stale', () => {
  assert.equal(buildFreshness(AS_OF, AS_OF).stale, false);
  assert.equal(buildFreshness(AS_OF, AS_OF).age_hours, 0);
});

test('threshold is overridable for what-if checks without touching the default', () => {
  const now = new Date(Date.parse(AS_OF) + 30 * 3_600_000).toISOString();
  assert.equal(buildFreshness(AS_OF, now, 24).stale, true);  // 30h > 24h
  assert.equal(buildFreshness(AS_OF, now, 50).stale, false); // 30h < 50h
});

test('buildFreshness rejects an unparseable timestamp (fail loud)', () => {
  assert.throws(() => buildFreshness('not-a-date'));
  assert.throws(() => buildFreshness(AS_OF, 'not-a-date'));
});

test('ageLabel formats hours/days/just-now', () => {
  assert.equal(ageLabel(0.4), 'just now');
  assert.equal(ageLabel(3), '3h ago');
  assert.equal(ageLabel(25), '1d 1h ago');
  assert.equal(ageLabel(48), '2d ago');
  assert.equal(ageLabel(null), 'just now');
});
