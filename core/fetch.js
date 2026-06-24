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
import { parseBucketLeg, buildPmfLadder } from './bucket.js';
import { deriveUnit } from './money.js';

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

// ── shared midpoint resolution (Phase 1) — used by BOTH the ladder and binary
// fetchers so the fallback chain lives in one place. Pure of I/O except
// fetchLastTradePrice. resolveFromBook covers everything up to the last-trade tier;
// callers fetch last-trade only for the rungs/sides it marks `needsLastTrade`.
function resolveFromBook(mid, book) {
  const best_bid = book.BUY != null ? String(book.BUY) : null;
  const best_ask = book.SELL != null ? String(book.SELL) : null;
  if (mid != null) return { best_bid, best_ask, midpoint: String(mid), midpoint_source: 'clob_midpoint' };
  if (best_bid != null && best_ask != null) {
    return { best_bid, best_ask, midpoint: String((Number(best_bid) + Number(best_ask)) / 2), midpoint_source: 'bid_ask_mean' };
  }
  if (best_bid != null) return { best_bid, best_ask, midpoint: best_bid, midpoint_source: 'best_bid' };
  if (best_ask != null) return { best_bid, best_ask, midpoint: best_ask, midpoint_source: 'best_ask' };
  return { best_bid, best_ask, needsLastTrade: true }; // no midpoint, no book
}
async function fetchLastTradePrice(token) {
  try {
    const lt = await fetchJson(lastTradeUrl(token));
    return lt && lt.price != null ? String(lt.price) : null;
  } catch {
    return null;
  }
}

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
  const resolved = meta.map((m) => ({ m, ...resolveFromBook(midRaw[m.token_id], priceRaw[m.token_id] || {}) }));

  // Fetch last-trade ONLY for the no-book rungs (small N) — never on the normal path.
  const needers = resolved.filter((r) => r.needsLastTrade);
  const lastTrades = await Promise.all(
    needers.map(async (r) => [r.m.token_id, await fetchLastTradePrice(r.m.token_id)])
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

// ── BINARY (single Yes/No) market support (Phase 2) ──────────────────────────
// A binary EVENT has exactly ONE market with outcomes ["Yes","No"]; a ladder event
// has many threshold legs. Detection MUST happen before any threshold parsing,
// because fetchMarketMeta throws "Cannot parse threshold" on a non-`$` leg question
// — so classifyMarketKind never parses; it classifies from the event shape only.

/** Pure classifier from an event's markets[]:
 *   'binary'      — one Yes/No leg;
 *   'ladder'      — multi-leg AND the first leg's question carries a numeric $threshold;
 *   'categorical' — multi-leg with non-numeric outcomes (Fed cuts, next Chancellor, …)
 *                   the threshold pipeline can't process. Returning this (instead of
 *                   letting fetchMarketMeta throw "Cannot parse threshold") keeps the raw
 *                   parser error off the UI — computeMarketRecord turns it into a friendly
 *                   "not supported" message. Binary detection (length === 1) is unaffected. */
export function kindFromMarkets(markets) {
  if (!Array.isArray(markets) || markets.length === 0) throw new Error('Gamma event contained no markets');
  if (markets.length === 1) return 'binary';
  return THRESHOLD_RE.test(markets[0]?.question ?? '') ? 'ladder' : 'categorical';
}

// A "(LOW)"/"(HIGH)" qualifier marks a directional TOUCH leg (P(price touches a level
// before expiry), not a settlement value). A "between X and Y" leg marks a bucket PMF
// (disjoint intervals). Neither is a survival curve, so both must route away from the
// ladder math (see MARKET-TYPES-PLAN.md).
const TOUCH_RE = /\((?:LOW|HIGH)\)/;
const BUCKET_RE = /\bbetween\b/i;

/** Finer shape of a MULTI-LEG event, classified from question text only (no CLOB):
 *   'directional_touch' — any leg is a "(LOW)/(HIGH) hit $X" touch market (WTI, Silver);
 *   'bucket_pmf'        — any leg is a "between $X and $Y" interval bucket (Bitcoin,
 *                         Anthropic IPO) — a PMF, possibly with one categorical leg;
 *   'survival'          — nested "above $X" legs that ARE a P(>X) curve (SpaceX);
 *   'categorical'       — multi-leg with no numeric $ threshold at all.
 * Detection order matters: touch and bucket are checked before survival because their
 * legs also contain a `$`. */
export function ladderShapeFromMarkets(markets) {
  if (!Array.isArray(markets) || markets.length === 0) throw new Error('Gamma event contained no markets');
  const questions = markets.map((m) => m?.question ?? '');
  if (questions.some((qn) => TOUCH_RE.test(qn))) return 'directional_touch';
  if (questions.some((qn) => BUCKET_RE.test(qn))) return 'bucket_pmf';
  if (questions.some((qn) => THRESHOLD_RE.test(qn))) return 'survival';
  return 'categorical';
}

/** 'binary' | 'ladder' | 'categorical'. One gamma GET, no threshold parsing. */
export async function classifyMarketKind(slug) {
  const events = await fetchJson(gammaUrl(slug));
  if (!Array.isArray(events) || events.length === 0) throw new Error('Gamma API returned no events');
  return kindFromMarkets(events[0].markets);
}

/** The FINE market shape used for compute routing (computeMarketRecord):
 *   'binary' | 'survival' | 'bucket_pmf' | 'directional_touch' | 'categorical'.
 *  kindFromMarkets/classifyMarketKind keep the coarse binary|ladder|categorical contract
 *  (binary gate + existing tests); this refines the 'ladder' bucket into the three real
 *  multi-leg structures so each routes to its own pipeline. */
export function marketShapeFromMarkets(markets) {
  if (!Array.isArray(markets) || markets.length === 0) throw new Error('Gamma event contained no markets');
  if (markets.length === 1) return 'binary';
  return ladderShapeFromMarkets(markets);
}

/** Fine shape from a slug. One gamma GET, no threshold parsing. */
export async function classifyMarketShape(slug) {
  const events = await fetchJson(gammaUrl(slug));
  if (!Array.isArray(events) || events.length === 0) throw new Error('Gamma API returned no events');
  return marketShapeFromMarkets(events[0].markets);
}

/** The single Yes/No market's metadata — NO threshold parsing (the binary question
 *  has none). Returns the YES/NO token ids + resolution signals + display fields. */
async function fetchBinaryMeta(config = null) {
  const url = config ? gammaUrl(config.event_slug) : ENDPOINTS.gamma;
  const events = await fetchJson(url);
  if (!Array.isArray(events) || events.length === 0) throw new Error('Gamma API returned no events');
  const ev = events[0];
  const m = (ev.markets || [])[0];
  if (!m) throw new Error('Gamma binary event contained no market');
  const ids = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
  return {
    title: ev.title ?? m.question ?? config?.event_slug,
    question: m.question,
    end_date: ev.endDate ?? null,
    yes_token: ids[0], // YES
    no_token: ids[1], // NO
    volume: m.volume != null ? Number(m.volume) : null,
    closed: m.closed === true,
    active: m.active !== false,
    accepting_orders: m.acceptingOrders !== false,
    uma_resolution_status: m.umaResolutionStatus ?? null,
    outcomes: m.outcomes ?? null,
    outcome_prices: m.outcomePrices ?? null,
  };
}

/** Gamma-only lifecycle signal for a binary market (no CLOB; threshold 1 = the single
 *  Yes/No leg). Mirrors fetchEventStatus's shape so classifyLifecycle is reusable. */
export async function fetchBinaryStatus(config = null) {
  const meta = await fetchBinaryMeta(config);
  return [{
    threshold: 1,
    closed: meta.closed,
    active: meta.active,
    accepting_orders: meta.accepting_orders,
    umaResolutionStatus: meta.uma_resolution_status,
    outcomes: meta.outcomes,
    outcomePrices: meta.outcome_prices,
  }];
}

/**
 * Live binary snapshot. probability = the RESOLVED YES midpoint (Phase-1 fallback
 * chain applies per token, incl. last_trade). raw_inputs carries BOTH sides using a
 * SYNTHETIC threshold as the canonical sort key (1=YES, 0=NO) so canonicalizeRawInputs
 * — and the hash recipe — are reused UNCHANGED (same recipe, binary content).
 */
export async function fetchBinarySnapshot(config = null) {
  const fetchedAt = new Date().toISOString();
  const meta = await fetchBinaryMeta(config);
  const tokens = [meta.yes_token, meta.no_token];

  const midRaw = await fetchJson(ENDPOINTS.midpoints, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokens.map((t) => ({ token_id: t }))),
  });
  if (midRaw && midRaw.error) throw new Error(`CLOB midpoints: ${midRaw.error}`);
  const priceRaw = await fetchJson(ENDPOINTS.prices, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokens.flatMap((t) => [{ token_id: t, side: 'BUY' }, { token_id: t, side: 'SELL' }])),
  });

  // threshold 1 = YES, 0 = NO — synthetic, only a stable canonical sort key.
  const sides = [
    { token: meta.yes_token, threshold: 1 },
    { token: meta.no_token, threshold: 0 },
  ].map((s) => ({ ...s, ...resolveFromBook(midRaw[s.token], priceRaw[s.token] || {}) }));

  const lastTradeThresholds = [];
  const skippedThresholds = [];
  const raw_inputs = [];
  for (const s of sides) {
    let { midpoint, midpoint_source, best_bid, best_ask } = s;
    let last_trade_price;
    if (s.needsLastTrade) {
      midpoint = await fetchLastTradePrice(s.token);
      if (midpoint == null) { skippedThresholds.push(s.threshold); continue; }
      midpoint_source = 'last_trade';
      last_trade_price = midpoint;
      lastTradeThresholds.push(s.threshold);
    }
    raw_inputs.push({
      token_id: s.token, threshold: s.threshold, midpoint,
      best_bid: best_bid ?? null, best_ask: best_ask ?? null, volume: meta.volume,
      midpoint_source, ...(last_trade_price != null ? { last_trade_price } : {}),
    });
  }

  const yes = raw_inputs.find((r) => r.threshold === 1);
  if (!yes) throw new Error(`No usable YES price for binary market ${config ? config.event_slug : meta.question}`);
  const no = raw_inputs.find((r) => r.threshold === 0);

  return {
    fetched_at: fetchedAt,
    endpoints: [config ? gammaUrl(config.event_slug) : ENDPOINTS.gamma, ENDPOINTS.midpoints, ENDPOINTS.prices],
    raw_inputs,
    raw_sha256: hashRawInputs(raw_inputs),
    probability: parseFloat(yes.midpoint),
    probability_no: no ? parseFloat(no.midpoint) : null,
    total_volume: meta.volume ?? 0,
    title: meta.title,
    end_date: meta.end_date,
    yes_best_bid: yes.best_bid,
    yes_best_ask: yes.best_ask,
    status: [{
      threshold: 1, closed: meta.closed, active: meta.active, accepting_orders: meta.accepting_orders,
      umaResolutionStatus: meta.uma_resolution_status, outcomes: meta.outcomes, outcomePrices: meta.outcome_prices,
    }],
    midpoint_fallback: {
      lastTradeCount: lastTradeThresholds.length, lastTradeThresholds,
      skippedCount: skippedThresholds.length, skippedThresholds,
    },
  };
}

// ── BUCKET-PMF (interval) market support ─────────────────────────────────────
// A bucket event prices DISJOINT value intervals ("between $X and $Y", "less than $X",
// "$Y or greater") whose YES prices form a PMF — NOT a survival ladder. We parse each leg
// to an interval (core/bucket.parseBucketLeg, dropping any non-$ categorical leg such as
// "Will X not IPO …"), de-vig the PMF to sum to 1, then DERIVE the survival curve P(>X) so
// the existing ladder math/record/detail all apply. Thresholds are stored as mantissas in
// the ladder's own derived unit (core/money.deriveUnit), exactly like SpaceX stores "1.8"
// for $1.8T — so labels/median/mean read in the market's denomination, fixing Bugs 1/2/4.

/** Gamma event → { title, end_date, unit, legs[] } where each leg is a parseable bucket
 *  (lo/hi absolute $, YES token, volume, resolution signals). Non-$ legs are excluded. */
async function fetchBucketMeta(config) {
  const events = await fetchJson(gammaUrl(config.event_slug));
  if (!Array.isArray(events) || events.length === 0) throw new Error('Gamma API returned no events');
  const ev = events[0];
  const all = Array.isArray(ev.markets) ? ev.markets : [];
  const legs = all.map((m) => {
    const interval = parseBucketLeg(m.question);
    if (!interval) return null; // categorical leg (no $ amount) — excluded from the PMF
    const ids = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
    return {
      lo: interval.lo, hi: interval.hi, token_id: ids[0],
      volume: m.volume != null ? Number(m.volume) : null,
      closed: m.closed === true, active: m.active !== false, accepting_orders: m.acceptingOrders !== false,
      uma_resolution_status: m.umaResolutionStatus ?? null, outcomes: m.outcomes ?? null, outcome_prices: m.outcomePrices ?? null,
    };
  }).filter(Boolean).sort((a, b) => a.lo - b.lo);
  if (legs.length < 2) throw new Error(`Bucket event ${config.event_slug} has <2 parseable buckets`);
  const absVals = legs.flatMap((l) => [l.lo, l.hi]).filter((v) => Number.isFinite(v) && v > 0);
  return { title: ev.title ?? config.event_slug, end_date: ev.endDate ?? null, unitInfo: deriveUnit(absVals), excludedCount: all.length - legs.length, legs };
}

/** Gamma-only lifecycle signal for a bucket market (no CLOB; threshold = bucket index). */
export async function fetchBucketStatus(config) {
  const meta = await fetchBucketMeta(config);
  return meta.legs.map((l, i) => ({
    threshold: i, closed: l.closed, active: l.active, accepting_orders: l.accepting_orders,
    umaResolutionStatus: l.uma_resolution_status, outcomes: l.outcomes, outcomePrices: l.outcome_prices,
  }));
}

/**
 * Live bucket-PMF snapshot. Resolves each bucket's YES midpoint (Phase-1 fallback chain),
 * de-vigs the PMF, derives the survival ladder + PMF mean. raw_inputs carry the OBSERVED
 * per-bucket midpoint (threshold = bucket lower bound in mantissa units) — same hash recipe
 * (canonicalizeRawInputs unchanged); only the content differs. Returns a fetchLiveSnapshot-
 * shaped object (markets = derived survival rungs) plus { unit, pmf_mean, total_volume, … }.
 */
export async function fetchBucketPmfSnapshot(config) {
  const fetchedAt = new Date().toISOString();
  const meta = await fetchBucketMeta(config);
  const { divisor, unit } = meta.unitInfo;
  const tokens = meta.legs.map((l) => l.token_id);

  const midRaw = await fetchJson(ENDPOINTS.midpoints, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokens.map((t) => ({ token_id: t }))),
  });
  if (midRaw && midRaw.error) throw new Error(`CLOB midpoints: ${midRaw.error}`);
  const priceRaw = await fetchJson(ENDPOINTS.prices, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokens.flatMap((t) => [{ token_id: t, side: 'BUY' }, { token_id: t, side: 'SELL' }])),
  });

  // Resolve each bucket's YES price with the shared fallback chain (last-trade for a dead book).
  const resolved = meta.legs.map((l) => ({ l, ...resolveFromBook(midRaw[l.token_id], priceRaw[l.token_id] || {}) }));
  const needers = resolved.filter((r) => r.needsLastTrade);
  const lastTradeBy = new Map(await Promise.all(needers.map(async (r) => [r.l.token_id, await fetchLastTradePrice(r.l.token_id)])));

  const lastTradeThresholds = [];
  const skippedThresholds = [];
  const priced = []; // { l, prob (number), midpoint (string), best_bid, best_ask }
  for (const r of resolved) {
    let midpoint = r.midpoint, source = r.midpoint_source, best_bid = r.best_bid ?? null, best_ask = r.best_ask ?? null;
    if (r.needsLastTrade) {
      midpoint = lastTradeBy.get(r.l.token_id);
      if (midpoint == null) { skippedThresholds.push(r.l.lo / divisor); continue; }
      source = 'last_trade'; lastTradeThresholds.push(r.l.lo / divisor);
    }
    priced.push({ l: r.l, prob: parseFloat(midpoint), midpoint, source, best_bid, best_ask });
  }
  if (priced.length < 2) throw new Error(`No usable prices for bucket event ${config.event_slug}`);

  // De-vig: normalize the observed PMF mass to sum to 1 (overround removed). The OBSERVED
  // midpoint stays in raw_inputs (provenance); the normalized prob feeds the derived curve.
  const probSum = priced.reduce((s, p) => s + (Number.isFinite(p.prob) ? p.prob : 0), 0);
  const norm = probSum > 0 ? probSum : 1;

  const raw_inputs = priced.map((p) => ({
    token_id: p.l.token_id, threshold: p.l.lo / divisor, midpoint: p.midpoint,
    best_bid: p.best_bid, best_ask: p.best_ask, volume: p.l.volume,
    ...(p.source === 'last_trade' ? { midpoint_source: 'last_trade', last_trade_price: p.midpoint } : { midpoint_source: p.source }),
  }));

  // PMF in mantissa units → derived survival ladder + PMF mean.
  const pmfLegs = priced.map((p) => ({ lo: p.l.lo / divisor, hi: Number.isFinite(p.l.hi) ? p.l.hi / divisor : Infinity, prob: p.prob / norm }));
  const { markets: survival, mean: pmfMean } = buildPmfLadder(pmfLegs);

  // Per-boundary volume = the bucket starting at that boundary (for the liquidity signal).
  const volByLo = new Map(priced.map((p) => [p.l.lo / divisor, p.l.volume ?? 0]));
  const markets = survival.map((m) => ({
    label: `>$${m.threshold}${unit}`, threshold: m.threshold, prob: m.prob, volume: volByLo.get(m.threshold) ?? 0,
  }));

  const status = meta.legs.map((l, i) => ({
    threshold: i, closed: l.closed, active: l.active, accepting_orders: l.accepting_orders,
    umaResolutionStatus: l.uma_resolution_status, outcomes: l.outcomes, outcomePrices: l.outcome_prices,
  }));

  return {
    fetched_at: fetchedAt,
    endpoints: [gammaUrl(config.event_slug), ENDPOINTS.midpoints, ENDPOINTS.prices],
    raw_inputs, raw_sha256: hashRawInputs(raw_inputs), markets, status,
    midpoint_fallback: { lastTradeCount: lastTradeThresholds.length, lastTradeThresholds, skippedCount: skippedThresholds.length, skippedThresholds },
    unit, pmf_mean: pmfMean, total_volume: priced.reduce((s, p) => s + (p.l.volume ?? 0), 0),
    title: meta.title, end_date: meta.end_date, excluded_count: meta.excludedCount,
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
