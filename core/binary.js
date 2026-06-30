// core/binary.js — build the canonical record for a BINARY (single Yes/No) market.
//
// Peer to snapshot.js's ladder builder, sharing nothing of the ladder math (no CDF,
// no isotonic, no median/IQR). A binary market has ONE number — the YES probability —
// so the derived block is `{ kind:'binary', probability, confidence, total_volume,
// narrative, freshness }`, discriminated by `kind` against the ladder shape (the
// schema's if/then keys off it). Provenance is the SAME hash recipe as the ladder
// (canonicalizeRawInputs over raw_inputs); only the content differs (YES/NO sides).

import { buildFreshness } from './freshness.js';
import { SCHEMA_VERSION } from './snapshot.js';
import { windowedVolumeSignal, bookDepthSignal, spreadToleranceMultiplier, expiryNote, daysUntil, worstTier } from './confidence.js';

const SPREAD_HIGH = 0.04; // mirror the ladder's spread thresholds (4pp / 8pp)
const SPREAD_MEDIUM = 0.08;
const VOL_HIGH = 100_000;
const VOL_MEDIUM = 10_000;
const TIER_SCORE = { high: 1, medium: 0.5, low: 0.15 };
// Increment B: a DECISIVE probability (very close to 0 or 1) is itself a reliability signal — the
// binary analogue of categorical low entropy. It LIFTS a spread-driven 'medium' to 'high', but ONLY
// when the spread is a minority of the smaller tail (rel ≤ 0.5) — a spread that eats the tail means
// the extreme price is NOT well-determined, so it must not lift.
const DECISIVE_LOW = 0.02;
const DECISIVE_HIGH = 0.98;
const REL_SPREAD_DOMINATES = 0.5;

/**
 * Score a binary snapshot into the two independent dimensions:
 *   RELIABILITY — spread (well-defined price), spread-vs-prob, last-trade fallback, missing sides, AND
 *                 (Increment B) a decisive probability lifts a spread-driven 'medium' to 'high'.
 *   LIQUIDITY   — windowed (recent) volume, with all-time volume as the fallback.
 * No ladder concepts (threshold count, monotonicity) apply.
 * Returns { reliability:{tier,score,reasons}, liquidity:{tier,score,reasons} }.
 */
export function scoreBinaryConfidence({ probability, bestBid, bestAsk, totalVolume, midpointFallback = null, lifecycle = null, windowedVolume = null, daysToExpiry = null }) {
  const relTiers = [], relReasons = [];
  const liqTiers = [], liqReasons = [];
  const settled = lifecycle != null && lifecycle.state != null && lifecycle.state !== 'OPEN';

  // ════ RELIABILITY ════
  // R1) Spread at the touch (live only). Tolerance widens near expiry (Increment 3). Computed into a
  //     local so Increment B's decisive-probability lift can upgrade it.
  const spread = bestBid != null && bestAsk != null ? Number(bestAsk) - Number(bestBid) : null;
  const spreadMult = spreadToleranceMultiplier(daysToExpiry);
  const note = expiryNote(daysToExpiry);
  // Spread relative to the smaller tail — a 5pp spread means much more on a 10% line than a 50% one.
  const relSpread = spread != null && probability != null && probability > 0 && probability < 1
    ? spread / Math.min(probability, 1 - probability) : null;
  let spreadTier = null, spreadReason = null;
  if (spread == null) {
    if (!settled) { spreadTier = 'medium'; spreadReason = 'no live book (price-only)'; }
  } else if (spread < SPREAD_HIGH * spreadMult) {
    spreadTier = 'high';
  } else if (spread <= SPREAD_MEDIUM * spreadMult) {
    spreadTier = 'medium';
    spreadReason = `spread ${(spread * 100).toFixed(1)}pp (${spreadMult > 1 ? `expected near expiry${note}` : 'moderate liquidity'})`;
  } else {
    spreadTier = 'low';
    spreadReason = `spread ${(spread * 100).toFixed(1)}pp (illiquid${note})`;
  }
  if (spreadTier) { relTiers.push(spreadTier); if (spreadReason) relReasons.push(spreadReason); }
  // A DECISIVE line (very close to 0/1) whose spread is a MINORITY of the smaller tail is
  // well-determined — a positive reliability basis (the binary analogue of strong consensus). NOTE
  // there is no medium→high tier LIFT for binary: a binary has a SINGLE book, so unlike a multi-leg
  // categorical (where averaging across wide tail legs understates a tight leader) a tight book is
  // already HIGH and a medium-band spread on an extreme line ALWAYS dominates the tiny tail — there is
  // no legitimate lift to make. When the spread instead dominates the tail, the caveat below fires.
  const decisive = probability != null && (probability <= DECISIVE_LOW || probability >= DECISIVE_HIGH);
  if (decisive && relSpread != null && relSpread <= REL_SPREAD_DOMINATES) {
    relReasons.push(`decisive probability (${Math.round(probability * 100)}%) — price well-determined`);
  }
  if (relSpread != null && relSpread > REL_SPREAD_DOMINATES) {
    relReasons.push(`spread is ${Math.round(relSpread * 100)}% of the implied probability`);
  }

  // R2) Midpoint fallback (Phase 1) — a side priced off the last trade, or with no price.
  if (midpointFallback) {
    if (midpointFallback.lastTradeCount > 0) {
      relTiers.push('medium');
      relReasons.push(`${midpointFallback.lastTradeCount} side(s) priced from last trade (no live book)`);
    }
    if (midpointFallback.skippedCount > 0) {
      relTiers.push('low');
      relReasons.push(`${midpointFallback.skippedCount} side(s) had no price`);
    }
  }

  // ════ LIQUIDITY ════
  // L1) Volume — a thin binary is easy to push around. Prefer WINDOWED (recent) volume when present
  //    (Increment 1); the all-time tier is the fallback when windowed data is unavailable.
  const winVol = windowedVolumeSignal(windowedVolume);
  if (winVol) {
    liqTiers.push(winVol.tier);
    if (winVol.reason) liqReasons.push(winVol.reason);
  } else if (totalVolume != null) {
    const v = `$${Math.round(totalVolume).toLocaleString('en-US')}`;
    if (totalVolume >= VOL_HIGH) liqTiers.push('high');
    else if (totalVolume >= VOL_MEDIUM) { liqTiers.push('medium'); liqReasons.push(`moderate volume (${v})`); }
    else { liqTiers.push('low'); liqReasons.push(`thin volume (${v})`); }
  }
  // L2) Book depth (Increment C) — can you transact at SIZE, worst-of with volume. Null → no-op.
  const depth = bookDepthSignal(windowedVolume);
  if (depth) {
    liqTiers.push(depth.tier);
    if (depth.reason) liqReasons.push(depth.reason);
  }

  // ── reliability score ──
  let relScore = spread != null ? Math.max(0, Math.min(1, 1 - spread / 0.1)) : 0.6;
  if (midpointFallback) {
    relScore -= 0.05 * Math.min(2, midpointFallback.lastTradeCount ?? 0);
    relScore -= 0.1 * Math.min(2, midpointFallback.skippedCount ?? 0);
  }
  relScore = Number(Math.max(0, Math.min(1, relScore)).toFixed(3));

  // ── liquidity score ──
  let liqScore = winVol ? TIER_SCORE[winVol.tier]
    : totalVolume != null ? Math.min(1, totalVolume / VOL_HIGH) : 0.6;
  if (depth) liqScore = Math.min(liqScore, TIER_SCORE[depth.tier]); // worst-of: a thin book caps it
  liqScore = Number(Math.max(0, Math.min(1, liqScore)).toFixed(3));

  if (relReasons.length === 0) relReasons.push('tight spread');
  if (liqReasons.length === 0) liqReasons.push('deep book');

  return {
    reliability: { tier: worstTier(relTiers), score: relScore, reasons: relReasons },
    liquidity: { tier: worstTier(liqTiers), score: liqScore, reasons: liqReasons },
  };
}

/** Deterministic one-liner — only claims backed by the computed numbers. */
function buildBinaryNarrative(name, probability, confidence) {
  const pct = probability != null ? `${Math.round(probability * 100)}%` : 'an unknown';
  return `The market implies a ${pct} chance that "${name}" resolves YES. Reliability is ${confidence.reliability.tier}; liquidity is ${confidence.liquidity.tier}.`;
}

/**
 * Build the full canonical binary record from a fetchBinarySnapshot result.
 *   live: { fetched_at, endpoints, raw_inputs, raw_sha256, probability, probability_no,
 *           total_volume, yes_best_bid, yes_best_ask, midpoint_fallback }
 */
export function buildBinaryRecord(live, methodologyVersion, config, lifecycle = null, freshnessThresholdHours = undefined) {
  if (!config) throw new Error('buildBinaryRecord: a MarketConfig is required');

  const confidence = scoreBinaryConfidence({
    probability: live.probability,
    bestBid: live.yes_best_bid,
    bestAsk: live.yes_best_ask,
    totalVolume: live.total_volume,
    midpointFallback: live.midpoint_fallback ?? null,
    lifecycle,
    windowedVolume: live.liquidity ?? null, // Increment 1
    daysToExpiry: daysUntil(config.resolves, live.fetched_at), // Increment 3
  });

  const derived = {
    kind: 'binary',
    probability: live.probability,
    probability_no: live.probability_no ?? null,
    total_volume: live.total_volume ?? 0,
    confidence,
    narrative: buildBinaryNarrative(config.name, live.probability, confidence),
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
    assumptions_version: null, // binary carries no Tier-2 scenarios
    asset: { id: config.id, name: config.name, platform: config.platform, market_url: config.market_url, resolves: config.resolves },
    snapshot,
  };
}
