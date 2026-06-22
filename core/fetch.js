// core/fetch.js — the product's provenance-aware fetcher.
//
// Why this exists: the canonical record must carry exactly what Polymarket
// returned, so consumers can verify the derived numbers against unaltered
// inputs. This fetches three public, auth-free endpoints and distils them into
// `raw_inputs` (one row per threshold, values kept as the API's literal strings)
// plus a reproducible sha256 over the canonical serialization of those inputs.
//
// (api.js stays the lighter fetcher for the local CLI; this is the richer one
// that also pulls best bid/ask for the liquidity/confidence signal.)

import { createHash } from 'node:crypto';
import { thresholdRegExp, labelGt } from './market-config.js';

const EVENT_SLUG = 'spacex-ipo-closing-market-cap-above';
export const ENDPOINTS = {
  gamma: `https://gamma-api.polymarket.com/events?slug=${EVENT_SLUG}`,
  midpoints: 'https://clob.polymarket.com/midpoints',
  prices: 'https://clob.polymarket.com/prices',
  lastTrade: 'https://clob.polymarket.com/last-trade-price',
};
const lastTradeUrl = (token) => `${ENDPOINTS.lastTrade}?token_id=${token}`;
const THRESHOLD_RE = /\$(\d+\.?\d*)/;

export const ASSET = {
  id: 'spacex-ipo-market-cap',
  name: 'SpaceX IPO closing market cap',
  platform: 'polymarket',
  market_url: 'https://polymarket.com/event/spacex-ipo-closing-market-cap-above',
  resolves: '2027-12-31',
};

/**
 * Canonical JSON serialization of raw_inputs: fixed key order, ascending by
 * threshold. Both the build (node) and the dashboard (browser) reproduce this
 * exact string, so the sha256 verifies anywhere. Keep this in sync with the
 * browser-side verifier in docs/index.html.
 */
export function canonicalizeRawInputs(rawInputs) {
  const ordered = [...rawInputs]
    .sort((a, b) => a.threshold - b.threshold)
    .map((r) => ({
      token_id: r.token_id,
      threshold: r.threshold,
      midpoint: r.midpoint,
      best_bid: r.best_bid,
      best_ask: r.best_ask,
      volume: r.volume,
    }));
  return JSON.stringify(ordered);
}

export function hashRawInputs(rawInputs) {
  return createHash('sha256').update(canonicalizeRawInputs(rawInputs)).digest('hex');
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
  return res.json();
}

const gammaUrl = (slug) => `https://gamma-api.polymarket.com/events?slug=${slug}`;

/**
 * Gamma event → ascending rung metadata. `config` (a MarketConfig) supplies the
 * event slug + threshold parser + label; omitted ⇒ legacy SpaceX behavior.
 * Captures resolution signals (closed / umaResolutionStatus / outcomes /
 * outcomePrices) in the side channel for the lifecycle classifier — NEVER in
 * raw_inputs, so the frozen hash recipe is untouched.
 */
async function fetchMarketMeta(config = null) {
  const url = config ? gammaUrl(config.event_slug) : ENDPOINTS.gamma;
  const re = config ? thresholdRegExp(config) : THRESHOLD_RE;
  const labelOf = config ? (t) => labelGt(config, t) : (t) => `>$${t}T`;
  const events = await fetchJson(url);
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('Gamma API returned no events');
  }
  const markets = events[0].markets;
  if (!Array.isArray(markets) || markets.length === 0) {
    throw new Error('Gamma event contained no markets');
  }
  return markets
    .map((m) => {
      const match = m.question.match(re);
      if (!match) throw new Error(`Cannot parse threshold: ${m.question}`);
      const threshold = parseFloat(match[1]);
      const ids =
        typeof m.clobTokenIds === 'string'
          ? JSON.parse(m.clobTokenIds)
          : m.clobTokenIds;
      return {
        threshold,
        label: labelOf(threshold),
        token_id: ids[0], // YES
        volume: m.volume != null ? Number(m.volume) : null,
        // Status + resolution signals — NOT part of raw_inputs / the hash.
        closed: m.closed === true,
        active: m.active !== false,
        accepting_orders: m.acceptingOrders !== false,
        uma_resolution_status: m.umaResolutionStatus ?? null,
        outcomes: m.outcomes ?? null,
        outcome_prices: m.outcomePrices ?? null,
      };
    })
    .sort((a, b) => a.threshold - b.threshold);
}

/**
 * Fetch a live snapshot with full provenance. Returns:
 *   { fetched_at, endpoints[], raw_inputs[], raw_sha256, markets[] }
 * where markets = [{ label, threshold, prob, volume }] (prob = midpoint) and
 * raw_inputs keeps the API's literal string values for midpoint/bid/ask.
 */
export async function fetchLiveSnapshot(config = null) {
  const fetchedAt = new Date().toISOString();
  const meta = await fetchMarketMeta(config);
  const tokenIds = meta.map((m) => m.token_id);

  // Batch midpoints (POST [{token_id}] → { id: "0.x" }).
  const midRaw = await fetchJson(ENDPOINTS.midpoints, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokenIds.map((t) => ({ token_id: t }))),
  });
  if (midRaw && midRaw.error) throw new Error(`CLOB midpoints: ${midRaw.error}`);

  // Batch best bid/ask (POST [{token_id,side}] → { id: {BUY, SELL} }).
  const priceBody = tokenIds.flatMap((t) => [
    { token_id: t, side: 'BUY' },
    { token_id: t, side: 'SELL' },
  ]);
  const priceRaw = await fetchJson(ENDPOINTS.prices, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(priceBody),
  });

  // Resolve a midpoint per rung with a documented fallback chain — an illiquid /
  // near-settled rung often has NO live midpoint AND an empty book (no bid/ask),
  // leaving only a last trade. Priority: clob_midpoint → bid_ask_mean → single side
  // → last_trade → skip (no usable price). raw_inputs records the RESOLVED midpoint
  // plus its `midpoint_source` (and `last_trade_price` when used) for honest
  // provenance; those extra fields are deliberately NOT in canonicalizeRawInputs, so
  // the hash recipe — and the frozen SpaceX hash — are untouched (the resolved
  // midpoint VALUE is what's hashed). Skipped rungs are excluded from raw_inputs AND
  // the ladder, and surfaced via midpoint_fallback → confidence. See gotchas.md.
  const resolved = meta.map((m) => {
    const book = priceRaw[m.token_id] || {};
    const best_bid = book.BUY != null ? String(book.BUY) : null;
    const best_ask = book.SELL != null ? String(book.SELL) : null;
    const mid = midRaw[m.token_id];
    if (mid != null) return { m, best_bid, best_ask, midpoint: String(mid), midpoint_source: 'clob_midpoint' };
    if (best_bid != null && best_ask != null) {
      return { m, best_bid, best_ask, midpoint: String((Number(best_bid) + Number(best_ask)) / 2), midpoint_source: 'bid_ask_mean' };
    }
    if (best_bid != null) return { m, best_bid, best_ask, midpoint: best_bid, midpoint_source: 'best_bid' };
    if (best_ask != null) return { m, best_bid, best_ask, midpoint: best_ask, midpoint_source: 'best_ask' };
    return { m, best_bid, best_ask, needsLastTrade: true }; // no midpoint, no book
  });

  // Fetch last-trade ONLY for the no-book rungs (small N) — never on the normal path.
  const needers = resolved.filter((r) => r.needsLastTrade);
  const lastTrades = await Promise.all(
    needers.map(async (r) => {
      try {
        const lt = await fetchJson(lastTradeUrl(r.m.token_id));
        return [r.m.token_id, lt && lt.price != null ? String(lt.price) : null];
      } catch {
        return [r.m.token_id, null];
      }
    })
  );
  const lastTradeBy = new Map(lastTrades);

  const skippedThresholds = [];
  const lastTradeThresholds = [];
  const raw_inputs = [];
  for (const r of resolved) {
    if (r.needsLastTrade) {
      const price = lastTradeBy.get(r.m.token_id);
      if (price == null) { skippedThresholds.push(r.m.threshold); continue; } // truly no price → skip rung
      lastTradeThresholds.push(r.m.threshold);
      raw_inputs.push({
        token_id: r.m.token_id, threshold: r.m.threshold, midpoint: price,
        best_bid: null, best_ask: null, volume: r.m.volume,
        midpoint_source: 'last_trade', last_trade_price: price,
      });
    } else {
      raw_inputs.push({
        token_id: r.m.token_id, threshold: r.m.threshold, midpoint: r.midpoint,
        best_bid: r.best_bid, best_ask: r.best_ask, volume: r.m.volume,
        midpoint_source: r.midpoint_source,
      });
    }
  }

  if (raw_inputs.length === 0) {
    throw new Error(`No usable price for any rung of ${config ? config.event_slug : EVENT_SLUG}`);
  }

  const labelByToken = new Map(meta.map((m) => [m.token_id, m.label]));
  const markets = raw_inputs.map((r) => ({
    label: labelByToken.get(r.token_id),
    threshold: r.threshold,
    prob: parseFloat(r.midpoint),
    volume: r.volume,
  }));

  // Fallback signal for confidence (empty/zero on the normal path → no effect, so
  // SpaceX's frozen confidence is unchanged).
  const midpoint_fallback = {
    lastTradeCount: lastTradeThresholds.length,
    lastTradeThresholds,
    skippedCount: skippedThresholds.length,
    skippedThresholds,
  };

  // Side channel for anomaly detection + lifecycle classification (closed /
  // inactive / not accepting orders / UMA resolution / settled outcome).
  // Deliberately excluded from raw_inputs so the provenance hash recipe is stable.
  const status = meta.map((m) => ({
    threshold: m.threshold,
    closed: m.closed,
    active: m.active,
    accepting_orders: m.accepting_orders,
    umaResolutionStatus: m.uma_resolution_status,
    outcomes: m.outcomes,
    outcomePrices: m.outcome_prices,
  }));

  return {
    fetched_at: fetchedAt,
    endpoints: [config ? gammaUrl(config.event_slug) : ENDPOINTS.gamma, ENDPOINTS.midpoints, ENDPOINTS.prices],
    raw_inputs,
    raw_sha256: hashRawInputs(raw_inputs),
    markets,
    status,
    midpoint_fallback,
  };
}

/**
 * Gamma-only per-rung lifecycle signals (no CLOB). Safe to call on a RESOLVED
 * market, which returns no midpoints — so classification must happen from THIS,
 * before any price fetch (ARCHITECTURE §5). Returns the camelCase shape the
 * lifecycle classifier consumes.
 */
export async function fetchEventStatus(config = null) {
  const meta = await fetchMarketMeta(config);
  return meta.map((m) => ({
    threshold: m.threshold,
    closed: m.closed,
    active: m.active,
    accepting_orders: m.accepting_orders,
    umaResolutionStatus: m.uma_resolution_status,
    outcomes: m.outcomes,
    outcomePrices: m.outcome_prices,
  }));
}

/** Count markets that are closed, inactive, or not accepting orders. */
export function countClosed(status) {
  if (!status) return 0;
  return status.filter((s) => s.closed || !s.active || !s.accepting_orders).length;
}
