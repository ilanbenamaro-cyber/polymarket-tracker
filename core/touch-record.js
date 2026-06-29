// core/touch-record.js — build the canonical record for a DIRECTIONAL-TOUCH market.
//
// Peer to binary.js/snapshot.js's builders. A touch market has no settlement distribution
// (no CDF, no median); its derived block is { kind:'directional_touch', implied_range,
// high_series, low_series, confidence, narrative, freshness }. Provenance reuses the SAME
// hash recipe as every other kind (canonicalizeRawInputs over raw_inputs). Confidence is
// scored from spread + volume + fallback (no ladder concepts). Kept OUT of core/touch.js so
// fetch.js can import the pure parser/range without pulling snapshot.js (import-cycle safe).

import { buildFreshness } from './freshness.js';
import { SCHEMA_VERSION } from './snapshot.js';
import { nearSettlement, windowedVolumeSignal, spreadToleranceMultiplier, expiryNote } from './confidence.js';

/** Whole days from `fromIso` to a `YYYY-MM-DD` resolution date, or null if unknown. */
function daysUntil(resolves, fromIso) {
  if (!resolves) return null;
  const end = Date.parse(resolves), from = Date.parse(fromIso);
  if (!Number.isFinite(end) || !Number.isFinite(from)) return null;
  return (end - from) / 86_400_000;
}

const TIER_RANK = { low: 0, medium: 1, high: 2 };
const SPREAD_HIGH = 0.04; // mirror the ladder/binary spread thresholds (4pp / 8pp)
const SPREAD_MEDIUM = 0.08;
const VOL_HIGH = 100_000;
const VOL_MEDIUM = 10_000;

/** Mean bid/ask spread across the priced touch legs, or null if no book data. */
function meanSpread(rawInputs) {
  const spreads = (rawInputs ?? [])
    .filter((r) => r.best_bid != null && r.best_ask != null)
    .map((r) => Number(r.best_ask) - Number(r.best_bid));
  return spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null;
}

/**
 * Score a touch snapshot — worst of spread, volume, midpoint-fallback, lifecycle. The spread
 * reason carries the MEASURED value (Bug 3 language). Returns { tier, score(0..1), reasons[] }.
 */
export function scoreTouchConfidence({ rawInputs, totalVolume, midpointFallback = null, lifecycle = null, nearSettled = false, windowedVolume = null, daysToExpiry = null }) {
  const reasons = [];
  const tiers = [];
  const settled = lifecycle != null && lifecycle.state != null && lifecycle.state !== 'OPEN';
  const spread = meanSpread(rawInputs);
  // Increment 3: spread tolerance widens near expiry.
  const spreadMult = spreadToleranceMultiplier(daysToExpiry);
  const note = expiryNote(daysToExpiry);

  if (spread == null) {
    if (!settled) { tiers.push('medium'); reasons.push('no live book (price-only)'); }
  } else if (spread < SPREAD_HIGH * spreadMult) {
    tiers.push('high');
  } else if (spread <= SPREAD_MEDIUM * spreadMult) {
    tiers.push('medium');
    reasons.push(`wide bid-ask spread (${(spread * 100).toFixed(1)}%) — ${spreadMult > 1 ? `expected near expiry${note}` : 'moderate liquidity'}`);
  } else {
    tiers.push('low');
    reasons.push(`wide bid-ask spread (${(spread * 100).toFixed(1)}%) — illiquid${note}`);
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
      // A leg off the live book is EXPECTED for a settled/near-settled market (the book is
      // winding down), not a data-quality red flag — so say "settled", don't read as illiquid.
      const expected = settled || nearSettled;
      tiers.push('medium');
      reasons.push(expected
        ? `${midpointFallback.lastTradeCount} settled leg(s) (priced from last trade)`
        : `${midpointFallback.lastTradeCount} leg(s) priced from last trade (no live book)`);
    }
    if (midpointFallback.skippedCount > 0) { tiers.push('low'); reasons.push(`${midpointFallback.skippedCount} leg(s) had no price`); }
  }

  const tier = tiers.reduce((a, b) => (TIER_RANK[b] < TIER_RANK[a] ? b : a), 'high');
  let score = spread != null ? Math.max(0, Math.min(1, 1 - spread / 0.1)) : 0.6;
  if (winVol) score = (score + (winVol.tier === 'high' ? 1 : winVol.tier === 'medium' ? 0.5 : 0.15)) / 2;
  else if (totalVolume != null) score = (score + Math.min(1, totalVolume / VOL_HIGH)) / 2;
  score = Number(Math.max(0, Math.min(1, score)).toFixed(3));
  if (reasons.length === 0) reasons.push('tight spreads, deep books');
  return { tier, score, reasons };
}

/** Display string for a range bound, including the honest "outside the strike ladder" cases
 *  when the 50% crossover falls beyond the quoted levels (Bug 5 ethos — never a bare null). */
function boundLabel(value, series, kind, unit) {
  if (value != null) return `$${value.toFixed(2)}${unit}`;
  if (!series.length) return 'n/a';
  const levels = series.map((s) => s.level);
  const min = Math.min(...levels), max = Math.max(...levels);
  const allAbove = series.every((s) => s.prob >= 0.5);
  // upper bound (HIGH series, decreasing): all≥0.5 → above the top strike; else → below the bottom
  if (kind === 'high') return allAbove ? `> $${max.toFixed(2)}${unit}` : `< $${min.toFixed(2)}${unit}`;
  // lower bound (LOW series, increasing): all≥0.5 → below the bottom strike; else → above the top
  return allAbove ? `< $${min.toFixed(2)}${unit}` : `> $${max.toFixed(2)}${unit}`;
}

function buildTouchNarrative(name, rangeLabelLow, rangeLabelHigh, confidence) {
  return `Touch market: the implied 50% trading range for "${name}" is ${rangeLabelLow} to ${rangeLabelHigh} before expiry. This prices the probability of touching price levels, not a settlement value. Confidence is ${confidence.tier}.`;
}

/** Build the full canonical directional-touch record from a fetchTouchSnapshot result. */
export function buildTouchRecord(live, methodologyVersion, config, lifecycle = null, freshnessThresholdHours = undefined) {
  if (!config) throw new Error('buildTouchRecord: a MarketConfig is required');
  const unit = live.unit ?? '';
  const daysToExpiry = daysUntil(config.resolves, live.fetched_at);
  const near_settlement = nearSettlement([...(live.high_series ?? []), ...(live.low_series ?? [])], daysToExpiry);
  const confidence = scoreTouchConfidence({
    rawInputs: live.raw_inputs, totalVolume: live.total_volume,
    midpointFallback: live.midpoint_fallback ?? null, lifecycle, nearSettled: near_settlement,
    windowedVolume: live.liquidity ?? null, // Increment 1
    daysToExpiry, // Increment 3 (already computed above for near_settlement)
  });

  const r = live.implied_range ?? { low: null, high: null, confidence: 0.5 };
  const low_label = boundLabel(r.low, live.low_series ?? [], 'low', unit);
  const high_label = boundLabel(r.high, live.high_series ?? [], 'high', unit);

  const derived = {
    kind: 'directional_touch',
    near_settlement,
    implied_range: { low: r.low ?? null, high: r.high ?? null, confidence: r.confidence ?? 0.5, low_label, high_label, unit },
    high_series: live.high_series ?? [],
    low_series: live.low_series ?? [],
    unit,
    total_volume: live.total_volume ?? 0,
    confidence,
    narrative: buildTouchNarrative(config.name, low_label, high_label, confidence),
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
    assumptions_version: null,
    asset: { id: config.id, name: config.name, platform: config.platform, market_url: config.market_url, resolves: config.resolves },
    snapshot,
  };
}
