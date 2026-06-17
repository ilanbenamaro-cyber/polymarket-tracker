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
};
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

  const raw_inputs = meta.map((m) => {
    const mid = midRaw[m.token_id];
    if (mid == null) throw new Error(`No midpoint for token ${m.token_id}`);
    const book = priceRaw[m.token_id] || {};
    return {
      token_id: m.token_id,
      threshold: m.threshold,
      midpoint: String(mid), // keep API's literal string for provenance
      best_bid: book.BUY != null ? String(book.BUY) : null,
      best_ask: book.SELL != null ? String(book.SELL) : null,
      volume: m.volume,
    };
  });

  const markets = meta.map((m) => {
    const r = raw_inputs.find((x) => x.token_id === m.token_id);
    return {
      label: m.label,
      threshold: m.threshold,
      prob: parseFloat(r.midpoint),
      volume: m.volume,
    };
  });

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
