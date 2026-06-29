// core/categorical.js — build the canonical record for a CATEGORICAL market.
//
// Peer to binary.js / touch-record.js. A categorical event (e.g. "How many Fed rate cuts
// in 2026?") is N mutually-exclusive Yes/No legs whose YES midpoints form a PMF over named
// outcomes. Unlike a ladder there is no ordering/CDF/median — the signal is the probability
// distribution itself, plus which outcome leads and how concentrated the consensus is.
//
// DE-VIG ⟂ PROVENANCE: the leg midpoints carry the market-maker overround, so we NORMALIZE
// them to sum to 1 for DISPLAY. That normalization is a presentation transform — the RAW
// observed midpoints are what land in raw_inputs and the hash (constraint #2: the hash is
// over truth, not presentation). Same hash recipe as every other kind (canonicalizeRawInputs
// over raw_inputs; synthetic threshold = leg index for a stable canonical sort, mirroring
// binary's 1=YES/0=NO).

import { buildFreshness } from './freshness.js';
import { SCHEMA_VERSION } from './snapshot.js';
import { windowedVolumeSignal } from './confidence.js';

const TIER_RANK = { low: 0, medium: 1, high: 2 };
const SPREAD_HIGH = 0.04; // mirror the ladder/binary/touch spread thresholds (4pp / 8pp)
const SPREAD_MEDIUM = 0.08;
const VOL_HIGH = 100_000;
const VOL_MEDIUM = 10_000;
const CONSENSUS_HIGH = 0.7;
const CONSENSUS_MEDIUM = 0.4;

// Polymarket seeds categorical events with PLACEHOLDER / UNTRADED legs — generic "Candidate C"
// through "Candidate Z" (also "Choice X" / "Option X"), plus catch-all legs like "Other" — that
// carry $0 all-time volume and sit at the untraded listing-price midpoint (~0.5 each). They are
// market-structure artifacts, not real outcomes. CRITICAL (Bug Zero): they MUST be removed BEFORE
// the de-vig normalization — including 25+ legs at ~0.5 in the denominator collapses a real leader
// (Ryan Fazio's true 97% → ~7%; even one surviving "Other" at 0.5 drags him to ~65%).
//
// A leg is an artifact only when it has ZERO all-time volume AND EITHER a generic "<word> <letter>"
// label OR a midpoint still pinned at the ~0.5 listing default (never traded → no market signal).
// Any leg that has actually traded (volume > 0) is ALWAYS kept, however thin; and a zero-volume leg
// with a real divergent quote (not ~0.5) is kept too — so a genuine low-odds candidate survives.
const GENERIC_LEG_LABEL = /^(candidate|choice|option|name)\s+[a-z]$/i;
const UNTRADED_MIDPOINT = 0.5;     // Polymarket's no-information seed price for a fresh leg
const UNTRADED_EPS = 0.02;         // a leg within this of 0.5 with $0 volume has never traded

/** True when a leg is a zero-volume placeholder / untraded artifact (not a real, active outcome). */
export function isPlaceholderLeg(leg) {
  if (!leg) return false;
  const vol = leg.volume ?? 0;
  if (vol !== 0) return false; // any traded leg is real, regardless of label or price
  const label = String(leg.label ?? '').trim();
  if (GENERIC_LEG_LABEL.test(label)) return true;
  const raw = leg.prob;
  return raw != null && Number.isFinite(raw) && Math.abs(raw - UNTRADED_MIDPOINT) <= UNTRADED_EPS;
}

/** Drop placeholder legs, but never strip a market below its real outcomes: if filtering would
 *  leave nothing (a degenerate all-generic event), fall back to the original legs unchanged. */
export function realCategoricalLegs(legs) {
  const real = (legs ?? []).filter((l) => !isPlaceholderLeg(l));
  return real.length > 0 ? real : (legs ?? []);
}

/** De-vig: scale a raw PMF to sum to 1, preserving ratios. All-zero ⇒ zeros (no div by 0). */
export function normalizeProbabilities(rawProbs) {
  const sum = (rawProbs ?? []).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  if (sum <= 0) return (rawProbs ?? []).map(() => 0);
  return rawProbs.map((p) => (Number.isFinite(p) ? p / sum : 0));
}

/** Shannon entropy normalized to [0,1] (0 = certain, 1 = maximally uncertain over N
 *  outcomes). Probabilities are normalized first; a single outcome is 0 by definition. */
export function shannonEntropy(probs) {
  const p = normalizeProbabilities(probs);
  const n = p.length;
  if (n <= 1) return 0;
  let h = 0;
  for (const x of p) if (x > 0) h -= x * Math.log(x);
  return h / Math.log(n);
}

/** Consensus tier from the leading outcome's probability. */
export function consensusStrength(dominantProb) {
  if (dominantProb > CONSENSUS_HIGH) return 'HIGH';
  if (dominantProb > CONSENSUS_MEDIUM) return 'MEDIUM';
  return 'LOW';
}

/** legs [{label, prob (RAW YES midpoint), volume, midpoint_source}] → outcome distribution,
 *  normalized + sorted descending. Each outcome keeps BOTH the normalized `probability` and
 *  the `raw_probability` so the de-vig is transparent. */
export function parseCategoricalOutcomes(legs) {
  // Bug Zero: filter placeholder legs BEFORE de-vig so the normalization denominator is built
  // from real candidates only (else a real leader collapses, e.g. Ryan Fazio 97% → 7%).
  const real = realCategoricalLegs(legs);
  const raw = real.map((l) => (Number.isFinite(l.prob) ? l.prob : 0));
  const norm = normalizeProbabilities(raw);
  return real
    .map((l, i) => ({
      label: l.label,
      probability: norm[i],
      raw_probability: l.prob ?? null,
      volume: l.volume ?? null,
      midpoint_source: l.midpoint_source ?? null,
    }))
    .sort((a, b) => b.probability - a.probability);
}

/** Mean bid/ask spread across the priced legs, or null if no book data. */
function meanSpread(rawInputs) {
  const spreads = (rawInputs ?? [])
    .filter((r) => r.best_bid != null && r.best_ask != null)
    .map((r) => Number(r.best_ask) - Number(r.best_bid));
  return spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null;
}

/**
 * Score a categorical snapshot — worst of spread, volume, midpoint-fallback, lifecycle —
 * each surfaced as a reason. Peer to scoreBinary/Touch. Returns { tier, score(0..1), reasons[] }.
 */
export function scoreCategoricalConfidence({ rawInputs, totalVolume, midpointFallback = null, lifecycle = null, windowedVolume = null }) {
  const reasons = [];
  const tiers = [];
  const settled = lifecycle != null && lifecycle.state != null && lifecycle.state !== 'OPEN';
  const spread = meanSpread(rawInputs);

  if (spread == null) {
    if (!settled) { tiers.push('medium'); reasons.push('no live book (price-only)'); }
  } else if (spread < SPREAD_HIGH) {
    tiers.push('high');
  } else if (spread <= SPREAD_MEDIUM) {
    tiers.push('medium');
    reasons.push(`wide bid-ask spread (${(spread * 100).toFixed(1)}%) — moderate liquidity`);
  } else {
    tiers.push('low');
    reasons.push(`wide bid-ask spread (${(spread * 100).toFixed(1)}%) — illiquid`);
  }

  // Windowed (recent) volume when present (Increment 1); all-time is the fallback.
  const winVol = windowedVolumeSignal(windowedVolume);
  if (winVol) {
    tiers.push(winVol.tier);
    if (winVol.reason) reasons.push(winVol.reason);
  } else if (totalVolume != null) {
    const v = `$${Math.round(totalVolume).toLocaleString('en-US')}`;
    if (totalVolume >= VOL_HIGH) tiers.push('high');
    else if (totalVolume >= VOL_MEDIUM) { tiers.push('medium'); reasons.push(`moderate volume (${v})`); }
    else { tiers.push('low'); reasons.push(`thin volume (${v})`); }
  }

  if (midpointFallback) {
    if (midpointFallback.lastTradeCount > 0) {
      tiers.push('medium');
      reasons.push(`${midpointFallback.lastTradeCount} outcome(s) priced from last trade (no live book)`);
    }
    if (midpointFallback.skippedCount > 0) {
      tiers.push('low');
      reasons.push(`${midpointFallback.skippedCount} outcome(s) had no price`);
    }
  }

  const tier = tiers.reduce((a, b) => (TIER_RANK[b] < TIER_RANK[a] ? b : a), 'high');
  let score = spread != null ? Math.max(0, Math.min(1, 1 - spread / 0.1)) : 0.6;
  if (winVol) score = (score + (winVol.tier === 'high' ? 1 : winVol.tier === 'medium' ? 0.5 : 0.15)) / 2;
  else if (totalVolume != null) score = (score + Math.min(1, totalVolume / VOL_HIGH)) / 2;
  if (midpointFallback) {
    score -= 0.05 * Math.min(2, midpointFallback.lastTradeCount ?? 0);
    score -= 0.1 * Math.min(2, midpointFallback.skippedCount ?? 0);
  }
  score = Number(Math.max(0, Math.min(1, score)).toFixed(3));
  if (reasons.length === 0) reasons.push('tight spreads, deep books');
  return { tier, score, reasons };
}

/** Deterministic one-liner — only claims backed by the computed distribution. */
function buildCategoricalNarrative(dominant, entropy, confidence) {
  const pct = dominant ? `${Math.round(dominant.probability * 100)}%` : 'an unknown';
  const label = dominant?.label ?? 'the leading outcome';
  const conc = entropy < 0.5 ? 'a concentrated consensus' : entropy < 0.78 ? 'a moderately contested field' : 'a wide-open field';
  return `The market assigns ${pct} probability to "${label}" — ${conc} (entropy ${entropy.toFixed(2)}). Confidence is ${confidence.tier}.`;
}

/**
 * Build the full canonical categorical record from a fetchCategoricalSnapshot result.
 *   live: { fetched_at, endpoints, raw_inputs, raw_sha256, outcomes[{label,prob,volume,
 *           midpoint_source}], total_volume, title, end_date, status, midpoint_fallback }
 */
export function buildCategoricalRecord(live, methodologyVersion, config, lifecycle = null, freshnessThresholdHours = undefined) {
  if (!config) throw new Error('buildCategoricalRecord: a MarketConfig is required');

  const outcomes = parseCategoricalOutcomes(live.outcomes ?? []);
  const dominant = outcomes[0] ?? null;
  const entropy = shannonEntropy(outcomes.map((o) => o.probability));
  const dominantProb = dominant?.probability ?? 0;
  const confidence = scoreCategoricalConfidence({
    rawInputs: live.raw_inputs, totalVolume: live.total_volume,
    midpointFallback: live.midpoint_fallback ?? null, lifecycle,
    windowedVolume: live.liquidity ?? null, // Increment 1
  });

  const derived = {
    kind: 'categorical',
    outcomes,
    dominant_outcome: dominant?.label ?? null,
    dominant_prob: dominantProb,
    entropy,
    consensus_strength: consensusStrength(dominantProb),
    implied_winner: dominantProb > 0.5 ? (dominant?.label ?? null) : 'no consensus',
    total_volume: live.total_volume ?? 0,
    confidence,
    narrative: buildCategoricalNarrative(dominant, entropy, confidence),
    freshness: buildFreshness(live.fetched_at, null, freshnessThresholdHours, lifecycle),
  };
  if (live.liquidity) derived.liquidity = live.liquidity; // Increment 1: windowed volume, omit-when-absent

  const snapshot = {
    snapshot_id: live.fetched_at,
    fetched_at: live.fetched_at,
    source: { provider: 'Polymarket', endpoints: live.endpoints, raw_sha256: live.raw_sha256 },
    raw_inputs: live.raw_inputs,
    derived,
  };
  if (lifecycle) snapshot.lifecycle = lifecycle;

  return {
    schema_version: SCHEMA_VERSION,
    methodology_version: methodologyVersion,
    assumptions_version: null, // categorical carries no Tier-2 scenarios
    asset: { id: config.id, name: config.name, platform: config.platform, market_url: config.market_url, resolves: config.resolves },
    snapshot,
  };
}
