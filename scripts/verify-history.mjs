// scripts/verify-history.mjs — live verification of the Phase 1 history system.
//
// Run against a running server (local dev or a deploy) with the cron secret + the dev
// Supabase creds in env:
//   BASE_URL=http://localhost:3001 \
//   CRON_SECRET=… \
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… NEXT_PUBLIC_SUPABASE_ANON_KEY=… \
//   node scripts/verify-history.mjs
//
// Proves, against the real cron route + market_history table:
//   NEG  /api/snapshot returns 401 with no / wrong CRON_SECRET (fails closed);
//   POS  /api/snapshot with the right Bearer runs the batch and returns a summary;
//   DB   rows land in market_history for the watched markets, provenance re-hashes;
//   RLS  the ANON key reads 0 rows from market_history (deny-all, mirrors snapshots);
//   UI   readHistory + deriveVelocity yield the explicit "collecting" state (<7 days).
// Exits non-zero on any failure.

import { createClient } from '@supabase/supabase-js';
import { hashRawInputs } from '../core/fetch.js';
import { allWatchedMarketIds, readHistory, deriveVelocity } from '../lib/market-history.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:3001';
const SECRET = process.env.CRON_SECRET;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
const URL = process.env.SUPABASE_URL;
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const baseHeaders = BYPASS ? { 'x-vercel-protection-bypass': BYPASS } : {};

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗'} ${m}`); if (!c) failures++; };
const snap = (auth) => fetch(`${BASE}/api/snapshot`, { headers: { ...baseHeaders, ...(auth ? { authorization: auth } : {}) } });

console.log(`\nPhase 1 history verification → ${BASE}\n`);
if (!SECRET) { console.error('Set CRON_SECRET (must match the server env).'); process.exit(2); }

// ── NEG: the cron route fails closed ──
console.log('NEG: /api/snapshot rejects missing / wrong auth');
{
  ok((await snap(null)).status === 401, 'no Authorization header → 401');
  ok((await snap('Bearer wrong-secret')).status === 401, 'wrong bearer → 401');
}

// ── POS: authorized run returns a batch summary ──
console.log('\nPOS: authorized /api/snapshot runs the batch');
let summary = null;
{
  const res = await snap(`Bearer ${SECRET}`);
  ok(res.status === 200, `correct bearer → 200 (got ${res.status})`);
  if (res.status === 200) {
    summary = await res.json();
    ok(summary.ok === true, 'summary.ok === true');
    ok(typeof summary.total === 'number', `enumerated ${summary.total} watched market(s)`);
    ok('success' in summary && 'failed' in summary && 'skipped_resolved' in summary,
      `counts present (success=${summary.success}, failed=${summary.failed}, resolved=${summary.skipped_resolved}, already=${summary.skipped_already})`);
    ok(summary.failed === 0, summary.failed === 0 ? 'no per-market failures' : `failures: ${JSON.stringify(summary.failures)}`);
  }
}

// ── DB + UI + RLS (creds-gated) ──
if (URL && SVC) {
  console.log('\nDB: history rows landed + provenance re-hashes');
  const ids = await allWatchedMarketIds();
  ok(ids.length > 0, `watchlist has ${ids.length} market(s) to snapshot`);
  let checkedDerive = false;
  for (const id of ids) {
    const hist = await readHistory(id, 90);
    if (hist.length === 0) continue;
    const last = hist[hist.length - 1];
    const rec = last.record;
    if (rec?.snapshot?.raw_inputs && rec?.snapshot?.source?.raw_sha256) {
      ok(hashRawInputs(rec.snapshot.raw_inputs) === rec.snapshot.source.raw_sha256,
        `${id}: stored history record re-hashes (provenance intact)`);
    }
    if (!checkedDerive) {
      const v = deriveVelocity(hist);
      ok(v.status === 'collecting' || v.status === 'ok',
        `${id}: deriveVelocity returns an explicit state (${v.status}${v.status === 'collecting' ? ` ${v.days_have}/${v.days_needed}` : ''}) — never dashes`);
      checkedDerive = true;
    }
  }
  ok(checkedDerive, 'at least one watched market has a history row to derive from');

  if (ANON) {
    console.log('\nRLS: anon cannot read market_history (deny-all)');
    const anonClient = createClient(URL, ANON, { auth: { persistSession: false } });
    const { data, error } = await anonClient.from('market_history').select('market_id').limit(5);
    ok((data?.length ?? 0) === 0, `anon SELECT returns 0 rows${error ? ` (or denied: ${error.code})` : ''}`);
  } else {
    console.log('\nRLS: skipped (set NEXT_PUBLIC_SUPABASE_ANON_KEY to run the deny-all check)');
  }
} else {
  console.log('\nDB/RLS: skipped (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to run)');
}

console.log(failures === 0 ? '\n✅ history verification PASSED\n' : `\n❌ ${failures} check(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
