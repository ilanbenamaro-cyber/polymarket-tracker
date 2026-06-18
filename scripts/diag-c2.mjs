// scripts/diag-c2.mjs — READ-ONLY diagnostic for the C2 cache-miss (Phase 2a).
//
// Triggers the live function for an OPEN market, then inspects the live Supabase
// tables to see WHERE the write/read cycle breaks. Writes NOTHING itself (the
// function does its own writes); it only observes. Run with the same env you run
// scripts/verify-phase2a.mjs with:
//   BASE_URL=https://your.vercel.app \
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
//   [OPEN_MARKET=kraken-ipo-closing-market-cap-above] \
//   node scripts/diag-c2.mjs

import { createClient } from '@supabase/supabase-js';

const BASE = process.env.BASE_URL;
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPEN_MARKET = process.env.OPEN_MARKET || 'kraken-ipo-closing-market-cap-above';
if (!BASE || !URL || !KEY) {
  console.error('Set BASE_URL + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
  process.exit(2);
}
const db = createClient(URL, KEY, { auth: { persistSession: false } });

const getFn = async () => {
  const res = await fetch(`${BASE}/api/market?id=${encodeURIComponent(OPEN_MARKET)}`);
  const body = await res.json();
  return { status: res.status, cached: body.cached, lifecycle: body.lifecycle_state,
           fetched_at: body.record?.snapshot?.fetched_at, error: body.error,
           // Edge-cache fingerprint: a HIT here means the function did NOT run and
           // Vercel replayed a prior response (the C2 root-cause suspect).
           x_vercel_cache: res.headers.get('x-vercel-cache'),
           age: res.headers.get('age'),
           cache_control: res.headers.get('cache-control') };
};

const inspect = async (label) => {
  const snaps = await db.from('market_snapshots')
    .select('id, market_id, fetched_at, cached_at, lifecycle_state, is_final, stale_after')
    .eq('market_id', OPEN_MARKET).order('cached_at', { ascending: false });
  const mkt = await db.from('markets')
    .select('id, resolution_status, last_checked_at, updated_at').eq('id', OPEN_MARKET).maybeSingle();
  const latest = await db.from('market_latest')
    .select('market_id, fetched_at, cached_at, lifecycle_state').eq('market_id', OPEN_MARKET).maybeSingle();
  console.log(`\n── ${label} ──`);
  console.log('market_snapshots rows :', snaps.error ? `ERROR ${snaps.error.message}` : snaps.data.length);
  if (snaps.data?.length) console.table(snaps.data);
  console.log('markets row           :', mkt.error ? `ERROR ${mkt.error.message}` : JSON.stringify(mkt.data));
  console.log('market_latest (view)  :', latest.error ? `ERROR ${latest.error.message}` : JSON.stringify(latest.data));
};

console.log(`\nC2 diagnostic → ${BASE}  market=${OPEN_MARKET}\n`);
await inspect('BEFORE any call');
console.log('\ncall #1 →', JSON.stringify(await getFn()));
await inspect('AFTER call #1 (function should have written an OPEN snapshot row)');
console.log('\ncall #2 →', JSON.stringify(await getFn()));
await inspect('AFTER call #2');
console.log('\nIf "market_snapshots rows" stays 0 after call #1 → writeRecord is not persisting.');
console.log('If rows ≥1 but call #2 cached:false → read/decide path misses a present row.\n');
