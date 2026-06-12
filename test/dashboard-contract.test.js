// test/dashboard-contract.test.js — node-side contract checks on the dashboard's
// inline JS. The dashboard must DISPLAY stored core values, never re-derive them
// (one-source-of-truth; defect class D1, caught three times now — audit P1-2:
// velDelta re-formatted velocity deltas via toFixed and re-decided flat via dir,
// so a card said "flat" while the narrative on the SAME record said "+$0.02T").
//
// Extraction is by brace-counting from the `function velDelta` token; if the
// function is renamed/moved the test FAILS LOUDLY (never skips) so this
// contract can't rot silently.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roundT, fmtSignedDeltaT, deltaDir } from '../core/format.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'docs/index.html'), 'utf8');

/** Extract a top-level `function name(...){...}` body by brace counting. */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found in docs/index.html — fix the test, do not skip it`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`unbalanced braces extracting ${name}`);
}

const velDeltaSrc = extractFunction(html, 'velDelta');
// eslint-disable-next-line no-new-func
const velDelta = new Function(`return (${velDeltaSrc});`)();

test('velDelta renders the STORED display verbatim (no toFixed re-derivation)', () => {
  assert.ok(
    !/toFixed/.test(velDeltaSrc),
    'velDelta must not contain toFixed — that is the D1 re-derivation pattern'
  );
});

test('velDelta: flat-eps divergence case — stored display wins over dir', () => {
  // raw delta +0.02: deltaDir says 'flat' (flatEps boundary) but the stored
  // display is '+$0.02T'. The card must show the stored display's number,
  // exactly as the narrative does.
  const ch = { abs: 0.02, dir: 'flat', display: '+$0.02T' };
  const out = velDelta(ch);
  assert.match(out, /\$0\.02T/, `card must render the stored $0.02T, got: ${out}`);
  assert.doesNotMatch(out, />flat</, 'card must not say "flat" when display carries a number');
});

test('velDelta: stored "flat" renders flat', () => {
  const out = velDelta({ abs: 0.001, dir: 'flat', display: 'flat' });
  assert.match(out, />flat</);
});

test('velDelta: null/missing input renders the em-dash placeholder', () => {
  assert.match(velDelta(null), /—/);
  assert.match(velDelta({}), /—/);
});

// ── Auto-refresh contract (cadence migration): one interval, visibility-bound,
// silent failure path that keeps the last good view.

test('auto-refresh: exactly one setInterval, bound to visibilitychange', () => {
  const script = html.slice(html.lastIndexOf('<script>'));
  assert.equal(
    (script.match(/setInterval\(/g) || []).length, 1,
    'exactly one setInterval in the dashboard script'
  );
  assert.match(script, /visibilitychange/, 'visibilitychange listener present');
});

test('auto-refresh: load has a silent path that preserves the working view', () => {
  const loadSrc = extractFunction(html, 'load');
  assert.match(loadSrc, /silent/, 'load must accept the silent flag');
  assert.match(loadSrc, /silent\s*&&\s*LATEST/, 'silent failures bail out only when a good view exists');
});

test('auto-refresh: refresh button does not leak its click event into silent', () => {
  assert.match(html, /addEventListener\('click',\(\)=>load\(\)\)/, 'refreshBtn must call load() with no args');
});

test('velDelta agrees with the canonical formatter across a sweep (D1 contract)', () => {
  for (let i = -50; i <= 50; i++) {
    const raw = i / 1000;
    const abs = roundT(raw);
    const ch = { abs, dir: deltaDir(raw), display: fmtSignedDeltaT(abs) };
    const out = velDelta(ch);
    if (ch.display === 'flat') {
      assert.match(out, />flat</, `raw=${raw}: display flat must render flat`);
    } else {
      const magnitude = ch.display.slice(1); // "$0.02T"
      assert.ok(out.includes(magnitude), `raw=${raw}: expected ${magnitude} in ${out}`);
      const cls = ch.display.startsWith('+') ? 'up' : 'down';
      assert.ok(out.includes(`class="${cls}"`), `raw=${raw}: expected class ${cls} in ${out}`);
    }
  }
});
