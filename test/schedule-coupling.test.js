// test/schedule-coupling.test.js — mechanically couples the CI snapshot cron to
// the staleness-threshold derivation in core/freshness.js. Audit P0-1: the old
// 50h threshold carried a correct, well-written comment about the daily cadence —
// and desynced anyway the moment the schedule changed. Comments don't couple;
// this test does: it re-derives the snapshot gap profile from the ACTUAL cron in
// update.yml and asserts it equals the SCHEDULE facts the threshold is built from.
//
// If the schedule changes, this test fails loudly and forces a human to
// re-derive SCHEDULE (and hence the threshold). It deliberately rejects cron
// syntax it can't reason about (step values, ranges in the hour field) — loud
// failure on format drift is the feature.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEDULE } from '../core/freshness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const yml = readFileSync(join(ROOT, '.github/workflows/update.yml'), 'utf8');

/** Extract cron expressions from `- cron: '...'` lines. */
function cronLines(source) {
  return [...source.matchAll(/-\s*cron:\s*'([^']+)'/g)].map((m) => m[1].trim());
}

/**
 * The SNAPSHOT crons are the daily ones (day-of-week '*'); weekday-gated (1-5)
 * crons are the email runs. Returns the snapshot crons' UTC hour lists.
 */
function snapshotHourLists(crons) {
  const daily = crons.filter((c) => {
    const fields = c.split(/\s+/);
    assert.equal(fields.length, 5, `unexpected cron field count: "${c}"`);
    return fields[4] === '*';
  });
  assert.ok(daily.length >= 1, 'no daily (snapshot) cron found in update.yml');
  return daily.map((c) => {
    const [min, hour] = c.split(/\s+/);
    assert.match(min, /^\d+$/, `snapshot cron minute must be a literal: "${c}"`);
    assert.match(
      hour,
      /^\d+(,\d+)*$/,
      `snapshot cron hour field must be an explicit list (no steps/ranges — re-derive SCHEDULE if you change the format): "${c}"`
    );
    return hour.split(',').map(Number);
  });
}

test('update.yml snapshot cron gap profile matches the SCHEDULE the threshold is derived from', () => {
  const lists = snapshotHourLists(cronLines(yml));
  assert.equal(lists.length, 1, 'expected exactly one snapshot cron');
  const hours = [...lists[0]].sort((a, b) => a - b);
  assert.ok(hours.length >= 2, 'need at least two firings to derive a gap profile');

  // Consecutive gaps including the wrap-around (last firing → first next day).
  const gaps = [];
  for (let i = 1; i < hours.length; i++) gaps.push(hours[i] - hours[i - 1]);
  gaps.push(24 - hours[hours.length - 1] + hours[0]);

  const maxGap = Math.max(...gaps);
  const minGap = Math.min(...gaps);
  assert.equal(
    maxGap,
    SCHEDULE.MAX_EXPECTED_GAP_H,
    `max scheduled gap (${maxGap}h) must equal SCHEDULE.MAX_EXPECTED_GAP_H (${SCHEDULE.MAX_EXPECTED_GAP_H}h) — re-derive core/freshness.js SCHEDULE`
  );
  assert.equal(
    minGap,
    SCHEDULE.CADENCE_H,
    `min scheduled gap (${minGap}h) must equal SCHEDULE.CADENCE_H (${SCHEDULE.CADENCE_H}h) — re-derive core/freshness.js SCHEDULE`
  );
});

test('email crons remain weekday-gated and are excluded from the gap profile', () => {
  const crons = cronLines(yml);
  const weekday = crons.filter((c) => c.split(/\s+/)[4] === '1-5');
  assert.equal(weekday.length, 2, 'expected the two weekday email crons');
});
