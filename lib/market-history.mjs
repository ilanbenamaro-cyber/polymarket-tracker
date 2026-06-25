// lib/market-history.mjs — the Phase 1 per-market history layer (SERVER-ONLY for I/O).
//
// Why this exists: the multi-market product computes on demand and caches ONE snapshot,
// so every trend/velocity/dispersion card was empty (the v1 SpaceX tracker showed all of
// them from a stored daily series). This module is the foundational unlock: a daily cron
// (app/api/snapshot) writes one row per watched market per UTC day into market_history;
// the detail view reads the series back and derives the analytics the cards display.
//
// Two halves:
//   • PURE derive functions (linregSlope, headlineValue, deriveVelocity/Dispersion/
//     Deltas/BiggestMoves) — no DB, unit-tested in test/market-history.test.js.
//   • SERVER-ONLY I/O (db, allWatchedMarketIds, writeHistory, readHistory) — uses the
//     SERVICE-ROLE key exactly like lib/cache.mjs / lib/market-scan.mjs and must NEVER be
//     imported into client code. market_history is RLS deny-all (migration 0006, mirroring
//     market_snapshots): the service role is the only reader, so readHistory is bounded to a
//     single caller-supplied market_id — the same per-market trust level as /api/market.
//
// THE RULE the UI relies on: a series shorter than the minimum returns an explicit
// { status:'collecting', days_have, days_needed } — never dashes, never a fabricated number.

import { createClient } from '@supabase/supabase-js';

export const MIN_VELOCITY_DAYS = 7;
export const MIN_DISPERSION_DAYS = 30;
const DAY_MS = 86_400_000;
const TREND_DEADBAND = 0.01; // <1% net move over the window reads as "steady" (1pp for binary)
const DISPERSION_DEADBAND = 0.01; // <1% IQR-width change reads as "stable"

// ── pure helpers ──────────────────────────────────────────────────────────────

/** Integer UTC day index for a 'YYYY-MM-DD' snapshot_date (stable, timezone-free). */
function dayIndex(snapshotDate) {
  return Math.round(Date.parse(`${snapshotDate}T00:00:00Z`) / DAY_MS);
}

/** Ordinary least-squares slope of y over x. null if <2 points or no horizontal span. */
export function linregSlope(points) {
  const pts = points ?? [];
  if (pts.length < 2) return null;
  const n = pts.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const { x, y } of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null; // all x identical
  return (n * sxy - sx * sy) / denom;
}

/** The headline scalar a market's velocity tracks, by kind:
 *  survival/bucket_pmf → implied_median; binary → YES probability;
 *  directional_touch → the implied-range midpoint (null if a bound is missing). */
export function headlineValue(row) {
  if (!row) return null;
  if (row.kind === 'binary') return row.probability ?? null;
  if (row.kind === 'categorical') return row.dominant_prob ?? null;
  if (row.kind === 'directional_touch') {
    const lo = row.touch_range_lo, hi = row.touch_range_hi;
    return lo == null || hi == null ? null : (lo + hi) / 2;
  }
  return row.implied_median ?? null; // survival | bucket_pmf
}

/** P(>threshold) at a stored ladder snapshot (the adjusted survival prob). null if absent. */
function ladderProbAt(record, threshold) {
  const ms = record?.snapshot?.derived?.markets ?? [];
  const m = ms.find((x) => x.threshold === threshold);
  return m && m.prob != null ? m.prob : null;
}

/** IQR width (p75 − p25) at a stored ladder snapshot. null if absent. */
function iqrWidth(record) {
  const iqr = record?.snapshot?.derived?.iqr;
  if (iqr == null) return null;
  if (typeof iqr === 'number') return iqr;
  if (iqr.p25 != null && iqr.p75 != null) return iqr.p75 - iqr.p25;
  return null;
}

/** Rows ascending by day, with a precomputed integer day index attached. */
function ordered(history) {
  return (history ?? [])
    .map((r) => ({ ...r, _x: dayIndex(r.snapshot_date) }))
    .sort((a, b) => a._x - b._x);
}

// ── derive functions (pure) ─────────────────────────────────────────────────

/**
 * Velocity of the headline value over the most recent MIN_VELOCITY_DAYS-day window.
 * Returns { status:'collecting', … } below the minimum; otherwise
 * { status:'ok', kind, slope (per day), trend:'rising'|'falling'|'steady',
 *   period, change (net over the window), days_have }.
 */
export function deriveVelocity(history) {
  const rows = ordered(history);
  const kind = rows.length ? rows[rows.length - 1].kind : null;
  const pts = rows.map((r) => ({ x: r._x, y: headlineValue(r) })).filter((p) => p.y != null);
  if (pts.length < MIN_VELOCITY_DAYS) {
    return { status: 'collecting', days_have: pts.length, days_needed: MIN_VELOCITY_DAYS };
  }
  const maxX = pts[pts.length - 1].x;
  const win = pts.filter((p) => p.x >= maxX - (MIN_VELOCITY_DAYS - 1));
  const slope = linregSlope(win);
  const yFirst = win[0].y, yLast = win[win.length - 1].y;
  const change = yLast - yFirst;
  const denom = kind === 'binary' ? 1 : Math.max(Math.abs(yFirst), 1e-9);
  const rel = change / denom;
  const trend = Math.abs(rel) < TREND_DEADBAND ? 'steady' : rel > 0 ? 'rising' : 'falling';
  return { status: 'ok', kind, slope, trend, period: `${MIN_VELOCITY_DAYS}d`, change, days_have: pts.length };
}

/**
 * Dispersion = how the 50% band (IQR width) has moved over ~30 days. Only meaningful for
 * survival/bucket_pmf (binary/touch have no settlement distribution → not_applicable).
 * Returns collecting below the minimum; otherwise { status:'ok', direction:'converging'
 * |'diverging'|'stable', current_width, width_30d_ago, change_pct, days_have }.
 */
export function deriveDispersion(history) {
  const rows = ordered(history);
  const kind = rows.length ? rows[rows.length - 1].kind : null;
  // Binary/touch/categorical have no settlement distribution → no IQR-based dispersion.
  if (kind === 'binary' || kind === 'directional_touch' || kind === 'categorical') return { status: 'not_applicable', kind };
  const pts = rows.map((r) => ({ x: r._x, w: iqrWidth(r.record) })).filter((p) => p.w != null);
  if (pts.length < MIN_DISPERSION_DAYS) {
    return { status: 'collecting', days_have: pts.length, days_needed: MIN_DISPERSION_DAYS };
  }
  const last = pts[pts.length - 1];
  const targetX = last.x - MIN_DISPERSION_DAYS;
  const baseline = pts.reduce((best, p) =>
    Math.abs(p.x - targetX) < Math.abs(best.x - targetX) ? p : best, pts[0]);
  const change_pct = baseline.w !== 0 ? (last.w - baseline.w) / baseline.w : 0;
  const direction = change_pct < -DISPERSION_DEADBAND ? 'converging'
    : change_pct > DISPERSION_DEADBAND ? 'diverging' : 'stable';
  return { status: 'ok', direction, current_width: last.w, width_30d_ago: baseline.w, change_pct, days_have: pts.length };
}

/**
 * Per-threshold P(>X) change at the 1d / 7d / 30d horizons (today vs the row exactly that
 * many days earlier). A horizon with no matching day is null — never fabricated. Returns
 * [{ threshold, d1, d7, d30 }] for the requested thresholds (ladder/bucket markets only).
 */
export function deriveDeltas(history, thresholds) {
  const rows = ordered(history);
  if (rows.length === 0) return (thresholds ?? []).map((t) => ({ threshold: t, d1: null, d7: null, d30: null }));
  const byDay = new Map(rows.map((r) => [r._x, r]));
  const today = rows[rows.length - 1];
  const todayX = today._x;
  const at = (row, t) => (row ? ladderProbAt(row.record, t) : null);
  const delta = (t, h) => {
    const now = at(today, t), then = at(byDay.get(todayX - h), t);
    return now != null && then != null ? now - then : null;
  };
  return (thresholds ?? []).map((t) => ({ threshold: t, d1: delta(t, 1), d7: delta(t, 7), d30: delta(t, 30) }));
}

/**
 * The biggest probability moves over the last `days`. For survival/bucket markets: the top-3
 * thresholds by |ΔP(>X)| → { kind:'ladder', movers:[{threshold,start,end,change,direction}] }.
 * For binary: the net YES-probability swing → { kind:'binary', start, end, change, direction }.
 * For touch: the range-midpoint shift. Categorical is filled in Phase 1b.
 */
export function deriveBiggestMoves(history, days = 30) {
  const rows = ordered(history);
  if (rows.length < 2) return { kind: rows[0]?.kind ?? null, movers: [], period: `${days}d` };
  const today = rows[rows.length - 1];
  const targetX = today._x - days;
  const start = rows.reduce((best, r) =>
    Math.abs(r._x - targetX) < Math.abs(best._x - targetX) ? r : best, rows[0]);
  const dir = (c) => (c > 0 ? 'up' : c < 0 ? 'down' : 'flat');

  if (today.kind === 'binary') {
    const s = start.probability ?? null, e = today.probability ?? null;
    const change = s != null && e != null ? e - s : null;
    return { kind: 'binary', start: s, end: e, change, direction: change == null ? 'flat' : dir(change), period: `${days}d` };
  }
  if (today.kind === 'directional_touch') {
    const s = headlineValue(start), e = headlineValue(today);
    const change = s != null && e != null ? e - s : null;
    return { kind: 'directional_touch', start: s, end: e, change, direction: change == null ? 'flat' : dir(change), period: `${days}d` };
  }

  const thresholds = (today.record?.snapshot?.derived?.markets ?? []).map((m) => m.threshold);
  const movers = thresholds.map((t) => {
    const s = ladderProbAt(start.record, t), e = ladderProbAt(today.record, t);
    const change = s != null && e != null ? e - s : null;
    return { threshold: t, start: s, end: e, change, direction: change == null ? 'flat' : dir(change) };
  }).filter((m) => m.change != null)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, 3);
  return { kind: 'ladder', movers, period: `${days}d` };
}

// ── server-only I/O ─────────────────────────────────────────────────────────

let _client = null;
function db() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY; // read/write; server-only
  if (!url || !key) throw new Error('market-history: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
  _client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _client;
}

/** The fine market shape stored on a history row, derived from the record's derived block.
 *  (markets.kind collapses survival+bucket to 'threshold_ladder'; history keeps them apart.) */
function fineKind(record) {
  const d = record?.snapshot?.derived ?? {};
  if (d.kind === 'binary') return 'binary';
  if (d.kind === 'categorical') return 'categorical';
  if (d.kind === 'directional_touch') return 'directional_touch';
  return d.market_shape ?? 'survival';
}

/** Every market_id on ANY user's watchlist (personal ∪ org), deduped. Service-role read
 *  of the base tables — this is the set the daily snapshot job covers. */
export async function allWatchedMarketIds() {
  const [pw, ow] = await Promise.all([
    db().from('personal_watchlist').select('market_id'),
    db().from('org_watchlist').select('market_id'),
  ]);
  if (pw.error) throw new Error(`market-history watched (personal): ${pw.error.message}`);
  if (ow.error) throw new Error(`market-history watched (org): ${ow.error.message}`);
  const ids = new Set([...(pw.data ?? []), ...(ow.data ?? [])].map((r) => r.market_id));
  return [...ids];
}

/** Upsert today's (UTC) history row for a market from a validated record. Idempotent on
 *  (market_id, snapshot_date) — a same-day retry overwrites rather than duplicating. */
export async function writeHistory(marketId, record, lifecycle = null) {
  const d = record?.snapshot?.derived ?? {};
  const row = {
    market_id: marketId,
    snapshot_date: new Date().toISOString().slice(0, 10),
    kind: fineKind(record),
    implied_median: d.implied_median ?? null,
    implied_mean: d.implied_mean ?? null,
    confidence_tier: d.confidence?.tier ?? null,
    confidence_score: d.confidence?.score ?? null,
    probability: d.probability ?? null,
    touch_range_lo: d.implied_range?.low ?? null,
    touch_range_hi: d.implied_range?.high ?? null,
    dominant_outcome: d.dominant_outcome ?? null, // Phase 1b (categorical)
    dominant_prob: d.dominant_prob ?? null,
    record,
    raw_sha256: record?.snapshot?.source?.raw_sha256 ?? null,
  };
  const { error } = await db().from('market_history')
    .upsert(row, { onConflict: 'market_id,snapshot_date' });
  if (error) throw new Error(`market-history write: ${error.message}`);
  return row;
}

/** Of `ids`, the market_ids that ALREADY have a history row on `date` ('YYYY-MM-DD').
 *  The cron's dedup guard: skip recomputing markets already snapshotted today. */
export async function marketsSnapshottedOn(date, ids) {
  if (!ids || ids.length === 0) return new Set();
  const { data, error } = await db().from('market_history')
    .select('market_id').eq('snapshot_date', date).in('market_id', ids);
  if (error) throw new Error(`market-history dedup: ${error.message}`);
  return new Set((data ?? []).map((r) => r.market_id));
}

/** Read the last `days` of history for ONE market, ascending by snapshot_date. Bounded to a
 *  single caller-supplied id (same per-market trust as /api/market; RLS is deny-all). */
export async function readHistory(marketId, days = 90) {
  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
  const { data, error } = await db().from('market_history')
    .select('snapshot_date, kind, implied_median, implied_mean, confidence_tier, confidence_score, probability, touch_range_lo, touch_range_hi, dominant_outcome, dominant_prob, record, raw_sha256')
    .eq('market_id', marketId)
    .gte('snapshot_date', cutoff)
    .order('snapshot_date', { ascending: true });
  if (error) throw new Error(`market-history read: ${error.message}`);
  return data ?? [];
}
