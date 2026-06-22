// test/hash-verify-parity.test.js — proves the 2c.3 trust-layer verify recipe.
//
// The detail view hands the client the canonical string from core/fetch.js
// `canonicalizeRawInputs` (server-side reuse — the browser can't import core/fetch.js,
// which pulls node:crypto), and the client SHA-256s it via crypto.subtle. This asserts
// that recipe reproduces the published raw_sha256 EXACTLY on the real frozen SpaceX
// record — i.e. the in-browser "verify hash" will report ✓, the single most important
// trust assertion. If core's canonicalization ever drifts, this fails before the UI does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalizeRawInputs, hashRawInputs } from '../core/fetch.js';

test('SHA-256 of the server-canonical raw_inputs === published raw_sha256 (verify ✓)', () => {
  const rec = JSON.parse(readFileSync(new URL('../docs/api/v1/latest.json', import.meta.url), 'utf8'));
  const canonical = canonicalizeRawInputs(rec.snapshot.raw_inputs); // what the detail passes to the client
  const browserWouldCompute = createHash('sha256').update(canonical).digest('hex'); // crypto.subtle equiv
  assert.equal(browserWouldCompute, rec.snapshot.source.raw_sha256, 'in-browser hash must match the published hash');
  assert.equal(browserWouldCompute, hashRawInputs(rec.snapshot.raw_inputs), 'and match core hashRawInputs');
});
