// core/validate.js — schema + invariant validation of the canonical record.
//
// Why this exists: a data product must fail loudly rather than publish a wrong
// number. snapshot.js calls validateRecord() and aborts (non-zero exit) if any
// invariant is broken — most importantly that the full probability distribution
// (all bucket_probs plus the "< lowest" bucket) sums to 1.0.

const BUCKET_SUM_EPSILON = 1e-6;

/**
 * Validate the STORED bucket_prob fields (not a recomputation — a recomputation
 * from prob always telescopes to 1.0 and would catch nothing). Two invariants:
 *   1. each stored bucket_prob equals P(>this) - P(>next) (top = P(>top));
 *   2. the "< lowest" bucket (1 - P(>min)) + all stored bucket_probs sum to 1.0.
 * Returns an array of error strings (empty if valid).
 */
function bucketErrors(markets, label) {
  const errors = [];
  if (!Array.isArray(markets) || markets.length === 0) {
    return [`${label}: missing/empty markets`];
  }
  const sorted = [...markets].sort((a, b) => a.threshold - b.threshold);
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    if (m.bucket_prob == null) {
      errors.push(`${label}: ${m.label} missing bucket_prob`);
      continue;
    }
    const next = sorted[i + 1];
    const expected = next ? m.prob - next.prob : m.prob;
    if (Math.abs(m.bucket_prob - expected) > BUCKET_SUM_EPSILON) {
      errors.push(
        `${label}: ${m.label} bucket_prob ${m.bucket_prob} != P(>this)-P(>next) ${expected}`
      );
    }
  }
  const belowLowest = 1 - sorted[0].prob;
  const sum = belowLowest + sorted.reduce((s, m) => s + (m.bucket_prob ?? 0), 0);
  if (Math.abs(sum - 1) > BUCKET_SUM_EPSILON) {
    errors.push(`${label}: bucket probabilities sum to ${sum} (expected 1.0)`);
  }
  return errors;
}

/** Throw with all problems joined, or return true. */
export function validateRecord(record) {
  const errors = [];

  if (record.schema_version == null) errors.push('missing schema_version');
  if (record.methodology_version == null) errors.push('missing methodology_version');

  const snap = record.snapshot;
  if (!snap) {
    errors.push('missing snapshot');
    throw new Error('Record invalid:\n  - ' + errors.join('\n  - '));
  }

  for (const f of ['snapshot_id', 'fetched_at']) {
    if (snap[f] == null) errors.push(`missing snapshot.${f}`);
  }
  if (!snap.source || snap.source.raw_sha256 == null) {
    errors.push('missing snapshot.source.raw_sha256');
  }
  if (!Array.isArray(snap.raw_inputs) || snap.raw_inputs.length === 0) {
    errors.push('missing/empty snapshot.raw_inputs');
  }

  const d = snap.derived;
  if (!d) {
    errors.push('missing snapshot.derived');
  } else {
    if (!d.confidence || !d.confidence.tier) errors.push('missing derived.confidence.tier');
    errors.push(...bucketErrors(d.markets, 'derived'));
  }

  if (errors.length > 0) {
    throw new Error('Record invalid:\n  - ' + errors.join('\n  - '));
  }
  return true;
}

/** Lightweight invariant check for a single history-day entry. */
export function validateHistoryEntry(entry) {
  if (!entry.date) throw new Error('history entry missing date');
  if (!entry.confidence || !entry.confidence.tier) {
    throw new Error(`history ${entry.date} missing confidence.tier`);
  }
  const errors = bucketErrors(entry.markets, `history ${entry.date}`);
  if (errors.length > 0) throw new Error(errors.join('; '));
  return true;
}
