// renderers/dashboard.js — bake the current headline into the static HTML.
//
// Why this exists: the dashboard and note must show real numbers on first paint
// even with JS disabled or a failed fetch. At build time we replace the content
// between <!--BAKE:key-->...<!--/BAKE:key--> markers in index.html and note.html
// with the latest canonical values. The runtime JS later refreshes from the API,
// but the baked values are the trustworthy fallback.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS = join(__dirname, '../docs');
const TARGETS = ['index.html', 'note.html'];

function money(m) {
  return m == null ? 'n/a' : `$${m.toFixed(2)}T`;
}

/** Replace every <!--BAKE:key-->...<!--/BAKE:key--> with values[key]. */
function bakeInto(html, values) {
  let out = html;
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(
      `(<!--BAKE:${key}-->)([\\s\\S]*?)(<!--/BAKE:${key}-->)`,
      'g'
    );
    // Function replacement: a literal value containing "$" (e.g. "$2.19T") must
    // NOT be interpreted as a regex backreference like $2.
    out = out.replace(re, (_full, open, _mid, close) => open + value + close);
  }
  return out;
}

/**
 * Bake the canonical record's headline into docs/index.html and docs/note.html.
 * Keys baked: median, mean, date, methodology, tier.
 */
export function bakeFallback(record) {
  const d = record.snapshot.derived;
  const values = {
    median: money(d.implied_median),
    mean: money(d.implied_mean),
    date: record.snapshot.fetched_at.slice(0, 10),
    methodology: record.methodology_version,
    tier: d.confidence.tier,
  };
  for (const file of TARGETS) {
    const path = join(DOCS, file);
    if (!existsSync(path)) continue;
    writeFileSync(path, bakeInto(readFileSync(path, 'utf8'), values));
  }
  return values;
}
