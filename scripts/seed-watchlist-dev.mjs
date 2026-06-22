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
const HEX64 = (c) => c.repeat(64); // placeholder raw_sha256 for synthetic fixtures

const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const daysFromNow = (d) => new Date(Date.now() + d * 86_400_000).toISOString();

/** Minimal-but-faithful core record carrying exactly the fields the rail reads
 *  (median / confidence / freshness columns + the velocity delta path). */
function synthRecord({ median, tier, staleAfter, fetchedAt, delta }) {
  return {
    schema_version: '1.2.1',
    methodology_version: '1.4.0',
    assumptions_version: '1.0.0',
    snapshot: {
      fetched_at: fetchedAt,
      source: { raw_sha256: HEX64(tier === 'low' ? 'b' : 'a') },
      derived: {
        implied_median: median,
        confidence: { tier },
        freshness: { stale_after: staleAfter },
        market: { analytics: { velocity: { change_24h: delta } } },
      },
    },
  };
}

async function seedSynthetic(id, name, rec) {
  // idempotent: drop any prior synthetic snapshot for this id, then write fresh.
  await svc.from('market_snapshots').delete().eq('market_id', id);
  await writeRecord(id, rec, { state: 'OPEN', resolved_outcome: null }, { name });
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

  // 2. Synthetic OPEN markets (real write path), one fresh + one stale.
  await seedSynthetic(OPEN_FRESH, 'DEV — Acme Corp IPO cap above', synthRecord({
    median: 1.85, tier: 'medium', staleAfter: daysFromNow(3650), fetchedAt: hoursAgo(1),
    delta: { abs: 0.05, dir: 'up', display: '+$0.05T' },
  }));
  await seedSynthetic(OPEN_STALE, 'DEV — Globex IPO cap above', synthRecord({
    median: 0.42, tier: 'low', staleAfter: hoursAgo(48), fetchedAt: hoursAgo(72),
    delta: { abs: -0.03, dir: 'down', display: '-$0.03T' },
  }));
  console.log(`  ✓ wrote synthetic OPEN markets: ${OPEN_FRESH} (fresh), ${OPEN_STALE} (stale)`);

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
