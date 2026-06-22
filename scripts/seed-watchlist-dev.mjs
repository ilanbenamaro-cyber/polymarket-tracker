// scripts/seed-watchlist-dev.mjs — DEV-ONLY: stand up a representative watchlist for
// the dev login so the 2c.2 rail can be eyeballed / Playwright-checked.
//
// Seeds, for the dev user (DEV_LOGIN_EMAIL, default ilanbenamaro@gmail.com):
//   • PERSONAL: the real frozen SpaceX market (RESOLVED → exercises the resolved dot +
//     "final" freshness, real computed record), plus a synthetic OPEN/fresh market
//     (medium confidence, +delta) — both via the user's personal_watchlist.
//   • ORG: a synthetic OPEN/STALE market (low confidence, −delta, stale_after in the
//     past → exercises the stale pill + ORG chip) on the user's first org's shared list.
// The two synthetic markets are written through the REAL lib/cache.writeRecord path
// (same write the verified pipeline uses), namespaced `dev-rail-*` and re-seeded
// idempotently. NOT for production — synthetic rows are dev fixtures.
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/seed-watchlist-dev.mjs
// Exit: 0 seeded · 1 error · 2 not run (missing creds / dev user not found).

import { createClient } from '@supabase/supabase-js';
import { writeRecord } from '../lib/cache.mjs';
import { hashRawInputs } from '../core/fetch.js';

const URL = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL = process.env.DEV_LOGIN_EMAIL || 'ilanbenamaro@gmail.com';
if (!URL || !SERVICE) {
  console.error('Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (dev project).');
  process.exit(2);
}
const svc = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const SPACEX_ID = 'spacex-ipo-closing-market-cap-above'; // real seeded RESOLVED market
const OPEN_FRESH = 'dev-rail-open-fresh';
const OPEN_STALE = 'dev-rail-open-stale';

const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const daysFromNow = (d) => new Date(Date.now() + d * 86_400_000).toISOString();

/** Build a monotonic ladder + matching raw_inputs from thresholds + a P(>X) curve. */
function ladderFrom(thresholds, probs) {
  const markets = thresholds.map((t, i) => {
    const prob = probs[i], next = probs[i + 1] ?? 0;
    const volume = Math.round(2_000_000 / (i + 1));
    return { label: `>$${t}T`, threshold: t, raw_prob: prob, adjusted_prob: prob, prob,
      bucket_prob: Math.max(0, prob - next), volume, volume_tier: i === 0 ? 'high' : i < 3 ? 'med' : 'low' };
  });
  const raw_inputs = thresholds.map((t, i) => ({
    token_id: `dev-token-${t}`, threshold: t, midpoint: String(probs[i]),
    best_bid: String(Math.max(0, probs[i] - 0.005)), best_ask: String(Math.min(1, probs[i] + 0.005)),
    volume: markets[i].volume,
  }));
  return { markets, raw_inputs };
}

/** A STRUCTURALLY COMPLETE synthetic core record (full ladder + analytics + asset +
 *  raw_inputs with a REAL raw_sha256 via hashRawInputs) so the 2c.3 detail renders
 *  in full AND the in-browser hash-verify passes on the synthetic record (not only
 *  SpaceX). Numbers are plausible dev fixtures, not methodology-validated. */
function fullRecord({ marketId, name, median, tier, staleAfter, fetchedAt, delta, thresholds, probs, resolves }) {
  const { markets, raw_inputs } = ladderFrom(thresholds, probs);
  const total_volume = markets.reduce((s, m) => s + m.volume, 0);
  return {
    schema_version: '1.2.1', methodology_version: '1.4.0', assumptions_version: '1.0.0',
    asset: { id: marketId, name, platform: 'polymarket', market_url: `https://polymarket.com/event/${marketId}`, resolves },
    snapshot: {
      snapshot_id: `${marketId}-${Date.parse(fetchedAt)}`,
      fetched_at: fetchedAt,
      source: { raw_sha256: hashRawInputs(raw_inputs) }, // real hash → verify passes
      raw_inputs,
      derived: {
        implied_median: median,
        implied_mean: median + 0.02,
        median: { central: median, low: median - 0.03, high: median + 0.03 },
        mean: { central: median + 0.02, low: median - 0.01, high: median + 0.05, tail_insensitive: false },
        iqr: { p25: median - 0.15, p75: median + 0.15 },
        total_volume,
        adjustment: { monotonicity_violations: 0, max_adjustment: 0 },
        confidence: {
          tier, score: tier === 'high' ? 0.95 : tier === 'medium' ? 0.7 : 0.4,
          reasons: [tier === 'low' ? 'thin liquidity in tail' : 'full threshold set, tight spreads, deep books'],
        },
        markets,
        market: { analytics: {
          shape: { skew_bowley: 0.05, entropy: 0.6, fat_tail: 1.0, dominant_bucket: { label: markets[Math.floor(markets.length / 2)].label } },
          dispersion: { trend: 'stable', iqr_width: 0.3, width_7d: 0.32, width_30d: 0.35 },
          velocity: { change_24h: delta, change_7d: null, change_30d: null, drift_30d_annualized: 0.1, acceleration: 'steady' },
          calibration: null,
          descriptor: 'Synthetic dev fixture — structurally complete record for the 2c.3 detail gate.',
        } },
        freshness: { as_of: fetchedAt, stale_after: staleAfter, staleness_threshold_hours: 17, final: false, lifecycle_state: 'OPEN' },
        narrative: `Synthetic ${name}: the market implies a median of $${median.toFixed(2)}T. Dev fixture for the Zone 2 detail view.`,
      },
    },
  };
}

async function seedSynthetic(id, rec) {
  // idempotent: drop any prior synthetic snapshot for this id, then write fresh.
  await svc.from('market_snapshots').delete().eq('market_id', id);
  await writeRecord(id, rec, { state: 'OPEN', resolved_outcome: null }, { name: rec.asset.name });
}

async function run() {
  console.log(`\n2c.2 dev watchlist seed → ${URL}  (user ${EMAIL})\n`);

  // 1. Resolve the dev user + their first org.
  const prof = await svc.from('profiles').select('id').eq('email', EMAIL).maybeSingle();
  if (prof.error) throw new Error(`profiles lookup: ${prof.error.message}`);
  const uid = prof.data?.id;
  if (!uid) { console.error(`✗ no profile for ${EMAIL} — sign that user in first (no UI signup yet).`); process.exit(2); }
  const mem = await svc.from('org_membership').select('org_id').eq('user_id', uid).limit(1).maybeSingle();
  if (mem.error) throw new Error(`org_membership lookup: ${mem.error.message}`);
  const orgId = mem.data?.org_id ?? null;
  console.log(`  user_id ${uid}  ·  org_id ${orgId ?? '(none — org row skipped)'}`);

  // 2. Synthetic OPEN markets — FULL records (real write path), one fresh + one stale.
  await seedSynthetic(OPEN_FRESH, fullRecord({
    marketId: OPEN_FRESH, name: 'DEV — Acme Corp IPO cap above', median: 1.85, tier: 'medium',
    staleAfter: daysFromNow(3650), fetchedAt: hoursAgo(1), delta: { abs: 0.05, dir: 'up', display: '+$0.05T' },
    thresholds: [1, 1.5, 2, 2.5, 3], probs: [0.95, 0.82, 0.55, 0.28, 0.10], resolves: '2027-12-31',
  }));
  await seedSynthetic(OPEN_STALE, fullRecord({
    marketId: OPEN_STALE, name: 'DEV — Globex IPO cap above', median: 0.42, tier: 'low',
    staleAfter: hoursAgo(48), fetchedAt: hoursAgo(72), delta: { abs: -0.03, dir: 'down', display: '-$0.03T' },
    thresholds: [0.2, 0.4, 0.6, 0.8, 1.0], probs: [0.90, 0.60, 0.35, 0.18, 0.08], resolves: '2027-12-31',
  }));
  console.log(`  ✓ wrote synthetic OPEN FULL records: ${OPEN_FRESH} (fresh), ${OPEN_STALE} (stale)`);

  // 3. Is SpaceX present on this dev project? (real RESOLVED row — best to include it.)
  const sx = await svc.from('markets').select('id').eq('id', SPACEX_ID).maybeSingle();
  const haveSpacex = !sx.error && !!sx.data;
  if (!haveSpacex) console.log(`  ⚠ SpaceX not seeded on this project (run scripts/seed-spacex.mjs) — skipping it`);

  // 4. Personal watchlist: SpaceX (if present) + the fresh OPEN market.
  const personalIds = [haveSpacex ? SPACEX_ID : null, OPEN_FRESH].filter(Boolean);
  const pw = await svc.from('personal_watchlist')
    .upsert(personalIds.map((market_id) => ({ user_id: uid, market_id })),
      { onConflict: 'user_id,market_id', ignoreDuplicates: true });
  if (pw.error) throw new Error(`personal_watchlist seed: ${pw.error.message}`);
  console.log(`  ✓ personal_watchlist: ${personalIds.join(', ')}`);

  // 5. Org watchlist: the stale OPEN market (drives the ORG chip).
  if (orgId) {
    const ow = await svc.from('org_watchlist')
      .upsert({ org_id: orgId, market_id: OPEN_STALE, added_by: uid },
        { onConflict: 'org_id,market_id', ignoreDuplicates: true });
    if (ow.error) throw new Error(`org_watchlist seed: ${ow.error.message}`);
    console.log(`  ✓ org_watchlist (${orgId}): ${OPEN_STALE}`);
  }

  console.log(`\n✓ seeded — rail should show ${personalIds.length + (orgId ? 1 : 0)} rows for ${EMAIL}\n`);
}

run().catch((err) => { console.error(`\n✗ seed failed: ${err.message}\n`); process.exit(1); });
