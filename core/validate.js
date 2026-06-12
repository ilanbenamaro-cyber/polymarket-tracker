// core/validate.js — schema + invariant validation of the canonical record.
//
// Why this exists: a data product must fail loudly rather than publish a wrong
// number. snapshot.js calls validateRecord() and aborts (non-zero exit) if any
// invariant is broken. Two layers:
//   1. JSON Schema (docs/api/v1/schema.json) via ajv — structural contract.
//   2. Statistical invariants the schema can't express — the adjusted CDF is
//      non-increasing, every bucket_prob >= 0, buckets sum to 1.0, and each
//      bucket_prob equals adjusted_i - adjusted_{i+1}.

import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '../docs/api/v1/schema.json');
const BUCKET_SUM_EPSILON = 1e-6;
const MONO_EPSILON = 1e-9;

let _validateSchema = null;
function schemaValidator() {
  if (_validateSchema) return _validateSchema;
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  _validateSchema = ajv.compile(schema);
  return _validateSchema;
}

/**
 * Statistical invariants on a markets[] that carries adjusted_prob + bucket_prob.
 * Returns an array of error strings (empty if valid).
 */
function bucketErrors(markets, label) {
  const errors = [];
  if (!Array.isArray(markets) || markets.length === 0) {
    return [`${label}: missing/empty markets`];
  }
  const s = [...markets].sort((a, b) => a.threshold - b.threshold);
  for (let i = 0; i < s.length; i++) {
    const m = s[i];
    const adj = m.adjusted_prob ?? m.prob;
    if (m.bucket_prob == null) {
      errors.push(`${label}: ${m.label} missing bucket_prob`);
      continue;
    }
    if (m.bucket_prob < -BUCKET_SUM_EPSILON) {
      errors.push(`${label}: ${m.label} bucket_prob ${m.bucket_prob} < 0`);
    }
    // Adjusted CDF must be non-increasing.
    if (i < s.length - 1) {
      const nextAdj = s[i + 1].adjusted_prob ?? s[i + 1].prob;
      if (nextAdj > adj + MONO_EPSILON) {
        errors.push(`${label}: adjusted CDF rises ${m.label}=${adj} -> ${s[i + 1].label}=${nextAdj}`);
      }
    }
    // Consistency: bucket_prob == adjusted_i - adjusted_{i+1} (top = adjusted_top).
    const nextAdj = i < s.length - 1 ? s[i + 1].adjusted_prob ?? s[i + 1].prob : 0;
    const expected = adj - nextAdj;
    if (Math.abs(m.bucket_prob - expected) > BUCKET_SUM_EPSILON) {
      errors.push(`${label}: ${m.label} bucket_prob ${m.bucket_prob} != adj_i-adj_{i+1} ${expected}`);
    }
  }
  const belowLowest = 1 - (s[0].adjusted_prob ?? s[0].prob);
  const sum = belowLowest + s.reduce((a, m) => a + (m.bucket_prob ?? 0), 0);
  if (Math.abs(sum - 1) > BUCKET_SUM_EPSILON) {
    errors.push(`${label}: bucket probabilities sum to ${sum} (expected 1.0)`);
  }
  return errors;
}

/**
 * THE FIREWALL. Tier-2 (assumption-based) output is quarantined from Tier-1:
 *   1. assumptions_version must be present.
 *   2. Any derived.scenarios leaf with NUMBERS must carry a non-empty assumptions[]
 *      with at least one entry that has a source, an as_of, AND a value.
 *   3. No `assumptions` key may appear anywhere under `derived` except inside
 *      `derived.scenarios` (no Tier-2 assumption leaking into the market tier).
 */
function firewallErrors(record) {
  const errors = [];
  if (record.assumptions_version == null) errors.push('missing assumptions_version');

  const d = record?.snapshot?.derived;
  if (!d) return errors;

  const sc = d.scenarios;
  if (sc) {
    for (const [name, scenario] of Object.entries(sc)) {
      if (name === 'assumptions_version' || !scenario || typeof scenario !== 'object') continue;
      // Null-checks, NOT truthiness: a numeric output of exactly 0 (e.g.
      // implied_change_pct when median == last round) is still a number that
      // must carry sourced assumptions (audit P1-3).
      const hasNumbers =
        scenario.at_median != null ||
        scenario.implied_change_pct != null ||
        (Array.isArray(scenario.ladder) && scenario.ladder.some((x) => x && x.price != null));
      if (hasNumbers) {
        const a = scenario.assumptions;
        if (!Array.isArray(a) || a.length === 0) {
          errors.push(`firewall: scenario "${name}" has numeric output but no assumptions[]`);
        } else if (!a.some((x) => x && x.source && x.as_of && x.value != null)) {
          errors.push(`firewall: scenario "${name}" lacks a sourced+dated assumption with a value`);
        }
      }
    }
  }

  // No 'assumptions' key anywhere under derived except the scenarios subtree.
  const scan = (obj, path) => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      if (path === '' && k === 'scenarios') continue; // Tier-2 is allowed to hold assumptions
      if (k === 'assumptions') {
        errors.push(`firewall: Tier-2 leak — 'assumptions' at derived.${path ? path + '.' : ''}${k}`);
      } else {
        scan(obj[k], path ? `${path}.${k}` : k);
      }
    }
  };
  scan(d, '');
  return errors;
}

/** Throw with all problems joined, or return true. Validates schema + invariants + firewall. */
export function validateRecord(record) {
  const errors = [];

  const validate = schemaValidator();
  if (!validate(record)) {
    for (const e of validate.errors) errors.push(`schema ${e.instancePath || '/'} ${e.message}`);
  }

  const d = record?.snapshot?.derived;
  if (d) errors.push(...bucketErrors(d.markets, 'derived'));
  errors.push(...firewallErrors(record));

  if (errors.length > 0) {
    throw new Error('Record invalid:\n  - ' + errors.join('\n  - '));
  }
  return true;
}

/** Lightweight invariant check for a single history-day entry (no schema). */
export function validateHistoryEntry(entry) {
  if (!entry.date) throw new Error('history entry missing date');
  if (!entry.confidence || !entry.confidence.tier) {
    throw new Error(`history ${entry.date} missing confidence.tier`);
  }
  const errors = bucketErrors(entry.markets, `history ${entry.date}`);
  if (errors.length > 0) throw new Error(errors.join('; '));
  return true;
}
