// scripts/seed-history-dev.mjs — DEV-ONLY: seed synthetic market_history so the Phase 3
// analytics (velocity / dispersion / per-threshold Δ columns / biggest movers / the
// historical trends chart) render WITHOUT waiting weeks for the real daily cron to accrue
// rows. The UI switches to real cron data automatically once it exists — this only stands up
// fixtures to prove the rendering today.
//
// Seeds four markets on the dev user's personal watchlist, chosen to exercise EVERY display
// state the analytics can be in:
//   • dev-hist-ladder-full   survival ladder, 31 daily rows → FULL: velocity ok, dispersion
//                             ok (converging), Δ at 24h/7d/30d, biggest movers over 30d.
//   • dev-hist-binary-full   binary (Yes/No),  31 daily rows → velocity ok, dispersion n/a,
//                             YES-probability trend chart.
//   • dev-hist-ladder-vel    survival ladder, 18 daily rows → VELOCITY-ONLY: velocity ok,
//                             dispersion still "collecting" (18/30); Δ 24h+7d present, 30d "—".
//   • dev-hist-ladder-coll   survival ladder,  4 daily rows → COLLECTING: velocity & dispersion
//                             both "collecting"; Δ 24h present, 7d/30d "—".
//
// SERVE PATH NOTE (why these are reliable): the detail view runs the live serveMarket(), which
// for an OPEN market normally PROBES or RECOMPUTES against Polymarket gamma — which 404s for a
// synthetic id. We keep the markets semantically OPEN (the real Phase 3 scenario) but set the
// snapshot's cached_at and the market's last_checked_at far in the FUTURE, so decideBeforeProbe
// returns SERVE_FRESH from cache every time, with ZERO network. (RESOLVED would also serve with
// no network, but a "resolved" market that's "collecting history" is self-contradictory.)
//
// The pure fixture generators (ladderDay / *HistoryRows) are exported and unit-tested in
// test/seed-history-fixture.test.js — the gate values the operator's Playwright run asserts are
// verified offline there. The DB writes below only run when this file is executed directly.
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/seed-history-dev.mjs
// (Falls back to reading .env.local for any unset key — dev ergonomics; values are never logged.)
// Exit: 0 seeded · 1 error · 2 not run (missing creds / dev user not found).

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { writeRecord } from '../lib/cache.mjs';
import { hashRawInputs } from '../core/fetch.js';

const DAY_MS = 86_400_000;
const FUTURE = new Date(Date.now() + 365 * DAY_MS).toISOString(); // serve-fresh anchor (see header)
const clamp = (p) => Math.max(0.005, Math.min(0.995, p));
const round4 = (x) => Math.round(x * 1e4) / 1e4;
/** UTC 'YYYY-MM-DD' for the i-th of N consecutive days ending today (i=0 oldest, i=N-1 today). */
const dayDate = (i, n) => new Date(Date.now() - (n - 1 - i) * DAY_MS).toISOString().slice(0, 10);

// ── ladder fixture shape (shared across the full / velocity / collecting markets) ──────────
// Linear interpolation of two monotone-non-increasing prob vectors stays monotone at every day,
// so the survival ladder is valid throughout and the Δ at each horizon is an exact slope·days.
export const THRESHOLDS = [1, 1.5, 2, 2.5, 3];                 // $T strikes
export const TODAY_P    = [0.960, 0.720, 0.700, 0.450, 0.200]; // P(>X) today
export const SLOPE      = [0.001, -0.004, 0.010, 0.008, 0.005]; // per-day drift (→ d30 = slope·30)
const TIER_SCORE = { high: 0.95, medium: 0.7, low: 0.4 };

/** The ladder's full market rows + iqr + headline median at day i of an N-day series. */
export function ladderDay(i, n) {
  const last = n - 1;
  const probs = THRESHOLDS.map((_, k) => clamp(round4(TODAY_P[k] - SLOPE[k] * (last - i))));
  const markets = THRESHOLDS.map((t, k) => {
    const prob = probs[k], next = probs[k + 1] ?? 0;
    const volume = Math.round(2_000_000 / (k + 1));
    return { label: `>$${t}T`, threshold: t, raw_prob: prob, adjusted_prob: prob, prob,
      bucket_prob: Math.max(0, round4(prob - next)), volume, volume_tier: k === 0 ? 'high' : k < 3 ? 'med' : 'low' };
  });
  const median = round4(1.70 + 0.01 * i);            // rises → velocity 'rising'
  const width = Math.max(0.05, round4(0.50 - (0.198 / Math.max(1, last)) * i)); // narrows → 'converging'
  const iqr = { p25: round4(median - width / 2), p75: round4(median + width / 2) };
  return { markets, iqr, median };
}

/** YES probability at day i of the binary series: rises 0.30 → 0.60 over 30 days. */
export function binaryProbAtDay(i) { return clamp(round4(0.30 + 0.01 * i)); }

/** N consecutive daily history rows for a ladder market (kind 'survival'). Pure — the exact
 *  rows seedLadderHistory upserts, fed to the derive functions in the fixture test. */
export function ladderHistoryRows(id, n) {
  return Array.from({ length: n }, (_, i) => {
    const { markets, iqr, median } = ladderDay(i, n);
    return {
      market_id: id, snapshot_date: dayDate(i, n), kind: 'survival',
      implied_median: median, implied_mean: round4(median + 0.02),
      confidence_tier: 'high', confidence_score: TIER_SCORE.high, probability: null,
      record: { snapshot: { derived: { markets, iqr } } }, raw_sha256: null,
    };
  });
}

/** N consecutive daily history rows for a binary market (kind 'binary'). Pure. */
export function binaryHistoryRows(id, n) {
  return Array.from({ length: n }, (_, i) => {
    const prob = binaryProbAtDay(i);
    return {
      market_id: id, snapshot_date: dayDate(i, n), kind: 'binary',
      implied_median: null, implied_mean: null, confidence_tier: 'medium', confidence_score: TIER_SCORE.medium,
      probability: prob, record: { snapshot: { derived: { probability: prob } } }, raw_sha256: null,
    };
  });
}

/** A structurally complete CURRENT served record for a ladder market (today = day N-1). Real
 *  raw_sha256 so the in-browser hash-verify passes; numbers are dev fixtures, not validated. */
function ladderRecord({ marketId, name, n, tier, resolves }) {
  const { markets, iqr, median } = ladderDay(n - 1, n);
  const total_volume = markets.reduce((s, m) => s + m.volume, 0);
  const raw_inputs = markets.map((m) => ({
    token_id: `dev-token-${m.threshold}`, threshold: m.threshold, midpoint: String(m.prob),
    best_bid: String(clamp(m.prob - 0.005)), best_ask: String(clamp(m.prob + 0.005)), volume: m.volume,
  }));
  const fetchedAt = new Date(Date.now() - 3_600_000).toISOString();
  return {
    schema_version: '1.2.1', methodology_version: '1.4.0', assumptions_version: '1.0.0',
    asset: { id: marketId, name, platform: 'polymarket', market_url: `https://polymarket.com/event/${marketId}`, resolves },
    snapshot: {
      snapshot_id: `${marketId}-${Date.parse(fetchedAt)}`, fetched_at: fetchedAt,
      source: { raw_sha256: hashRawInputs(raw_inputs) }, raw_inputs,
      lifecycle: { state: 'OPEN', resolved_outcome: null },
      derived: {
        kind: 'threshold_ladder', market_shape: 'survival',
        implied_median: median, implied_mean: round4(median + 0.02),
        median: { central: median, low: round4(median - 0.03), high: round4(median + 0.03) },
        mean: { central: round4(median + 0.02), low: round4(median - 0.01), high: round4(median + 0.05), tail_insensitive: false },
        iqr, total_volume, adjustment: { monotonicity_violations: 0, max_adjustment: 0 },
        confidence: { tier, score: TIER_SCORE[tier], reasons: [tier === 'low' ? 'thin liquidity in tail' : 'full threshold set, tight spreads, deep books'] },
        markets,
        market: { analytics: {
          shape: { skew_bowley: 0.05, entropy: 0.6, fat_tail: 1.0, dominant_bucket: { label: markets[2].label } },
          dispersion: { trend: 'converging', iqr_width: round4(iqr.p75 - iqr.p25) },
          velocity: { acceleration: 'rising', drift_30d_annualized: 0.12 },
          descriptor: 'Synthetic dev fixture — Phase 3 history-analytics gate (not methodology-validated).',
        } },
        freshness: { as_of: fetchedAt, stale_after: FUTURE, staleness_threshold_hours: 17, final: false, lifecycle_state: 'OPEN' },
        narrative: `Synthetic ${name}: the market implies a median of $${median.toFixed(2)}T. Dev fixture exercising the Phase 3 trend, Δ-column and biggest-mover analytics.`,
      },
    },
  };
}

/** A binary (Yes/No) market's CURRENT served record at today's YES probability. */
function binaryRecord({ marketId, name, prob, tier, resolves }) {
  const probNo = round4(1 - prob);
  const raw_inputs = [
    { token_id: 'dev-token-yes', threshold: 1, midpoint: String(prob), best_bid: String(clamp(prob - 0.01)), best_ask: String(clamp(prob + 0.01)), volume: 1_500_000 },
    { token_id: 'dev-token-no', threshold: 0, midpoint: String(probNo), best_bid: String(clamp(probNo - 0.01)), best_ask: String(clamp(probNo + 0.01)), volume: 1_500_000 },
  ];
  const fetchedAt = new Date(Date.now() - 3_600_000).toISOString();
  return {
    schema_version: '1.2.1', methodology_version: '1.4.0', assumptions_version: '1.0.0',
    asset: { id: marketId, name, platform: 'polymarket', market_url: `https://polymarket.com/event/${marketId}`, resolves },
    snapshot: {
      snapshot_id: `${marketId}-${Date.parse(fetchedAt)}`, fetched_at: fetchedAt,
      source: { raw_sha256: hashRawInputs(raw_inputs) }, raw_inputs,
      lifecycle: { state: 'OPEN', resolved_outcome: null },
      derived: {
        kind: 'binary', probability: prob, probability_no: probNo, total_volume: 3_000_000,
        confidence: { tier, score: TIER_SCORE[tier], reasons: ['tight YES/NO spread, deep two-sided book'] },
        freshness: { as_of: fetchedAt, stale_after: FUTURE, staleness_threshold_hours: 17, final: false, lifecycle_state: 'OPEN' },
        narrative: `Synthetic ${name}: the market implies a ${Math.round(prob * 100)}% YES probability. Dev fixture for the Phase 3 binary trend chart.`,
      },
    },
  };
}

// ── DB writes (only when executed directly) ────────────────────────────────────────────────

/** Write the current served snapshot, then anchor cached_at / last_checked_at in the future so
 *  serveMarket SERVE_FRESHes from cache with no network (synthetic ids have no live gamma). */
async function seedCurrent(svc, id, rec, kind) {
  await svc.from('market_history').delete().eq('market_id', id);
  await svc.from('market_snapshots').delete().eq('market_id', id);
  await writeRecord(id, rec, { state: 'OPEN', resolved_outcome: null }, { name: rec.asset.name, kind });
  const a = await svc.from('market_snapshots').update({ cached_at: FUTURE }).eq('market_id', id);
  if (a.error) throw new Error(`anchor cached_at ${id}: ${a.error.message}`);
  const b = await svc.from('markets').update({ last_checked_at: FUTURE }).eq('id', id);
  if (b.error) throw new Error(`anchor last_checked_at ${id}: ${b.error.message}`);
}

async function seedHistory(svc, rows) {
  const { error } = await svc.from('market_history').upsert(rows, { onConflict: 'market_id,snapshot_date' });
  if (error) throw new Error(`history upsert ${rows[0]?.market_id}: ${error.message}`);
  return rows.length;
}

// dev-only: backfill process.env from .env.local for keys not already exported. Values stay in
// this process (same as Next.js auto-loading .env.local); nothing is printed.
function loadDotenvLocal() {
  let text;
  try { text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}

const FULL = 'dev-hist-ladder-full', BIN = 'dev-hist-binary-full',
      VEL = 'dev-hist-ladder-vel', COLL = 'dev-hist-ladder-coll';
const RESOLVES = '2027-12-31';

async function main() {
  loadDotenvLocal();
  const URL = process.env.SUPABASE_URL;
  const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const EMAIL = process.env.DEV_LOGIN_EMAIL || 'ilanbenamaro@gmail.com';
  if (!URL || !SERVICE) {
    console.error('Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (dev project), or put them in .env.local.');
    process.exit(2);
  }
  const svc = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  console.log(`\nPhase 3 history seed → ${URL}  (user ${EMAIL})\n`);

  const prof = await svc.from('profiles').select('id').eq('email', EMAIL).maybeSingle();
  if (prof.error) throw new Error(`profiles lookup: ${prof.error.message}`);
  const uid = prof.data?.id;
  if (!uid) { console.error(`✗ no profile for ${EMAIL} — sign that user in first (no UI signup yet).`); process.exit(2); }

  // Full ladder (31 rows → velocity ok, dispersion ok, Δ 24h/7d/30d, movers).
  await seedCurrent(svc, FULL, ladderRecord({ marketId: FULL, name: 'DEV — Full history ladder (cap above)', n: 31, tier: 'high', resolves: RESOLVES }), 'threshold_ladder');
  console.log(`  ✓ ${FULL}: ${await seedHistory(svc, ladderHistoryRows(FULL, 31))} daily rows (FULL analytics)`);

  // Binary (31 rows → velocity ok, dispersion n/a, YES trend chart).
  await seedCurrent(svc, BIN, binaryRecord({ marketId: BIN, name: 'DEV — Full history binary (Yes/No)', prob: binaryProbAtDay(30), tier: 'medium', resolves: RESOLVES }), 'binary');
  console.log(`  ✓ ${BIN}: ${await seedHistory(svc, binaryHistoryRows(BIN, 31))} daily rows (binary, velocity ok)`);

  // Velocity-only ladder (18 rows → velocity ok, dispersion collecting; Δ 30d = "—").
  await seedCurrent(svc, VEL, ladderRecord({ marketId: VEL, name: 'DEV — Velocity-only ladder (18d)', n: 18, tier: 'medium', resolves: RESOLVES }), 'threshold_ladder');
  console.log(`  ✓ ${VEL}: ${await seedHistory(svc, ladderHistoryRows(VEL, 18))} daily rows (VELOCITY-ONLY)`);

  // Collecting ladder (4 rows → velocity & dispersion both collecting; Δ 7d/30d = "—").
  await seedCurrent(svc, COLL, ladderRecord({ marketId: COLL, name: 'DEV — Collecting ladder (4d)', n: 4, tier: 'low', resolves: RESOLVES }), 'threshold_ladder');
  console.log(`  ✓ ${COLL}: ${await seedHistory(svc, ladderHistoryRows(COLL, 4))} daily rows (COLLECTING)`);

  // Personal watchlist: all four, idempotent.
  const ids = [FULL, BIN, VEL, COLL];
  const pw = await svc.from('personal_watchlist')
    .upsert(ids.map((market_id) => ({ user_id: uid, market_id })), { onConflict: 'user_id,market_id', ignoreDuplicates: true });
  if (pw.error) throw new Error(`personal_watchlist seed: ${pw.error.message}`);

  console.log(`\n✓ seeded — ${ids.length} markets on ${EMAIL}'s watchlist. The UI swaps to real cron data automatically as it accrues.\n`);
}

// Run the DB seed only when executed directly; importing the module (the fixture test) is pure.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`\n✗ seed failed: ${err.message}\n`); process.exit(1); });
}
