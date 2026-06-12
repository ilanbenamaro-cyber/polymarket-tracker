// test/firewall.test.js — the Tier-1/Tier-2 firewall must catch UNSOURCED numeric
// scenario leaves even when the numeric value is exactly 0 (falsy). Audit finding
// P1-3: hasNumbers used truthiness, so `implied_change_pct: 0` (median == last
// round, a real numeric output) slipped past the sourced-assumption requirement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRecord } from '../core/validate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const latest = () =>
  JSON.parse(readFileSync(join(ROOT, 'docs/api/v1/latest.json'), 'utf8'));

function assertFirewallThrows(record, label) {
  assert.throws(
    () => validateRecord(record),
    (e) => /firewall/.test(e.message),
    `${label}: expected a firewall error`
  );
}

test('firewall: unsourced scalar implied_change_pct of exactly 0 is caught', () => {
  const rec = latest();
  rec.snapshot.derived.scenarios.round_over_round = {
    unit: 'percent',
    implied_change_pct: 0, // numeric output, falsy — the P1-3 bypass input
  };
  assertFirewallThrows(rec, 'implied_change_pct:0');
});

test('firewall: unsourced at_median of exactly 0 is caught', () => {
  const rec = latest();
  rec.snapshot.derived.scenarios.share_price = { at_median: 0 };
  assertFirewallThrows(rec, 'at_median:0');
});

test('firewall: unsourced ladder price of exactly 0 is caught', () => {
  const rec = latest();
  rec.snapshot.derived.scenarios.share_price = {
    ladder: [{ threshold: 2.0, price: 0 }],
  };
  assertFirewallThrows(rec, 'ladder price:0');
});

test('firewall: the real published record still validates (no false tightening)', () => {
  assert.doesNotThrow(() => validateRecord(latest()));
});

test('firewall: input_required scenario without numbers still passes', () => {
  const rec = latest();
  rec.snapshot.derived.scenarios.round_over_round = {
    status: 'input_required',
    assumptions: [],
  };
  assert.doesNotThrow(() => validateRecord(rec));
});
