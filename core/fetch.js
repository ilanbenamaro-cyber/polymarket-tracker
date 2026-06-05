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

/** Gamma event → [{ threshold, label, token_id, volume }] ascending. */
async function fetchMarketMeta() {
  const events = await fetchJson(ENDPOINTS.gamma);
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('Gamma API returned no events');
  }
  const markets = events[0].markets;
  if (!Array.isArray(markets) || markets.length === 0) {
    throw new Error('Gamma event contained no markets');
  }
  return markets
    .map((m) => {
      const match = m.question.match(THRESHOLD_RE);
      if (!match) throw new Error(`Cannot parse threshold: ${m.question}`);
      const ids =
        typeof m.clobTokenIds === 'string'
          ? JSON.parse(m.clobTokenIds)
          : m.clobTokenIds;
      return {
        threshold: parseFloat(match[1]),
        label: `>$${parseFloat(match[1])}T`,
        token_id: ids[0], // YES
        volume: m.volume != null ? Number(m.volume) : null,
        // Status flags for anomaly detection — NOT part of raw_inputs / the hash.
        closed: m.closed === true,
        active: m.active !== false,
        accepting_orders: m.acceptingOrders !== false,
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
export async function fetchLiveSnapshot() {
  const fetchedAt = new Date().toISOString();
  const meta = await fetchMarketMeta();
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

  // Side channel for anomaly detection (closed / inactive / not accepting orders).
  // Deliberately excluded from raw_inputs so the provenance hash recipe is stable.
  const status = meta.map((m) => ({
    threshold: m.threshold,
    closed: m.closed,
    active: m.active,
    accepting_orders: m.accepting_orders,
  }));

  return {
    fetched_at: fetchedAt,
    endpoints: [ENDPOINTS.gamma, ENDPOINTS.midpoints, ENDPOINTS.prices],
    raw_inputs,
    raw_sha256: hashRawInputs(raw_inputs),
    markets,
    status,
  };
}

/** Count markets that are closed, inactive, or not accepting orders. */
export function countClosed(status) {
  if (!status) return 0;
  return status.filter((s) => s.closed || !s.active || !s.accepting_orders).length;
}
