// scripts/verify-2c2-rail.mjs — Phase 2c.2 GATE (data layer): the watchlist rail's
// scan reader (lib/market-scan.readScan) is correct AND tenant-safe.
//
// This proves the security-critical + correctness properties that don't need a browser,
// against a real DEV Supabase (0001+0002+0003 applied), through REAL signed-in users
// (authenticated role, RLS enforced). The UI half (rows render, pills, selection marks
// the row, empty/skeleton, and the architecture-falsification "no /api/market calls on
// rail load") is a Playwright flow — recipe in the 2c.2 handoff; run it against a dev
// deploy. Split mirrors 2c.1 (verify-2c1-authgate proves the headless NEGATIVE; the
// positive browser flow is Playwright).
//
// THE FIREWALL (the reason this gate exists): readScan uses the service-role key and
// could physically read ANY market's scan data. The ONLY thing keeping it tenant-safe
// is that its ids come exclusively from listVisible() (the RLS-scoped union view). So
// we prove: a market in ANOTHER user's watchlist — which service-role CAN read — is
// absent from listVisible(A) AND therefore absent from readScan(listVisible(A)).
//
//   TEST_EMAIL_DOMAIN=<accepted> SUPABASE_URL=… SUPABASE_ANON_KEY=… \
//   SUPABASE_SERVICE_ROLE_KEY=… node scripts/verify-2c2-rail.mjs
// Exit: 0 pass · 1 a check failed · 2 not run (missing creds).

import { createClient } from '@supabase/supabase-js';
import { addPersonal, addOrg, listVisible } from '../lib/watchlist.mjs';
import { readScan } from '../lib/market-scan.mjs';
import { fmtT } from '../core/format.js';

const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !ANON || !SERVICE) {
  console.error('Set SUPABASE_URL + SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY (dev project).');
  process.exit(2);
}

const RUN = Date.now().toString(36);
const PW = 'Test-Passw0rd!';
const D = process.env.TEST_EMAIL_DOMAIN || 'example.com';
const svc = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗ FAIL:'} ${m}`); if (!c) failures++; };
const HEX64 = (c) => c.repeat(64);
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const daysFromNow = (d) => new Date(Date.now() + d * 86_400_000).toISOString();

// Minimal core record carrying exactly the fields readScan consumes.
function rec({ median, tier, staleAfter, fetchedAt, delta }) {
  return {
    schema_version: '1.2.1', methodology_version: '1.4.0', assumptions_version: '1.0.0',
    snapshot: {
      fetched_at: fetchedAt, source: { raw_sha256: HEX64('a') },
      derived: {
        implied_median: median, confidence: { tier },
        freshness: { stale_after: staleAfter },
        market: { analytics: { velocity: { change_24h: delta } } },
      },
    },
  };
}

const created = { users: [], orgs: [], markets: [] };
const writeMarket = async (id, name, body) => {
  created.markets.push(id);
  // imported here to avoid pulling the service-role cache client unless the gate runs
  const { writeRecord } = await import('../lib/cache.mjs');
  await writeRecord(id, body, { state: 'OPEN', resolved_outcome: null }, { name });
};

async function signedIn(email) {
  const c = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error || !data?.session) throw new Error(`sign-in ${email}: ${error?.message}`);
  return c;
}
const mkUser = async (email) => {
  const { data, error } = await svc.auth.admin.createUser({ email, password: PW, email_confirm: true });
  if (error) throw new Error(`createUser ${email}: ${error.message}`);
  return data.user.id;
};

async function seed() {
  const M = (n) => `zzz-2c2-${RUN}-${n}`;
  const m = { mPersonal: M('personal'), mShared: M('shared'), mStale: M('stale'), mForeign: M('foreign') };

  await writeMarket(m.mPersonal, 'A personal — Acme', rec({ median: 1.85, tier: 'medium', staleAfter: daysFromNow(3650), fetchedAt: hoursAgo(1), delta: { abs: 0.05, dir: 'up', display: '+$0.05T' } }));
  await writeMarket(m.mShared, 'A shared+personal — Globex', rec({ median: 2.4, tier: 'high', staleAfter: daysFromNow(3650), fetchedAt: hoursAgo(2), delta: { abs: -0.02, dir: 'flat', display: 'flat' } }));
  await writeMarket(m.mStale, 'A org stale — Initech', rec({ median: 0.42, tier: 'low', staleAfter: hoursAgo(48), fetchedAt: hoursAgo(72), delta: { abs: -0.03, dir: 'down', display: '-$0.03T' } }));
  await writeMarket(m.mForeign, 'B private — Hooli', rec({ median: 9.9, tier: 'high', staleAfter: daysFromNow(3650), fetchedAt: hoursAgo(1), delta: { abs: 0.1, dir: 'up', display: '+$0.10T' } }));

  const X = (await svc.from('organizations').insert({ name: `X_${RUN}` }).select('id').single()).data.id;
  const Y = (await svc.from('organizations').insert({ name: `Y_${RUN}` }).select('id').single()).data.id;
  created.orgs = [X, Y];

  const emailA = `ra_${RUN}@${D}`, emailB = `rb_${RUN}@${D}`;
  const al = await svc.from('allowed_emails').insert([
    { email: emailA, org_id: X, role: 'member' }, { email: emailB, org_id: Y, role: 'member' },
  ]);
  if (al.error) throw new Error(`seed allowlist: ${al.error.message}`);
  const aId = await mkUser(emailA), bId = await mkUser(emailB);
  created.users = [aId, bId];
  await svc.from('profiles').upsert([{ id: aId, email: emailA }, { id: bId, email: emailB }], { onConflict: 'id', ignoreDuplicates: true });
  await svc.from('org_membership').upsert([
    { org_id: X, user_id: aId, role: 'member' }, { org_id: Y, user_id: bId, role: 'member' },
  ], { onConflict: 'org_id,user_id', ignoreDuplicates: true });

  return { m, X, Y, emailA, emailB };
}

async function cleanup() {
  for (const id of created.users) { try { await svc.auth.admin.deleteUser(id); } catch { /* best effort */ } }
  if (created.orgs.length) await svc.from('organizations').delete().in('id', created.orgs);
  if (created.markets.length) await svc.from('market_snapshots').delete().in('market_id', created.markets);
  if (created.markets.length) await svc.from('markets').delete().in('id', created.markets);
}

async function run() {
  console.log(`\nPhase 2c.2 rail-scan gate → ${URL}  (run ${RUN}, domain @${D})\n`);
  const { m, X, Y, emailA, emailB } = await seed();
  const A = await signedIn(emailA); // org X
  const B = await signedIn(emailB); // org Y

  // A curates: personal {mPersonal, mShared}, org X {mShared (dual-scope), mStale}.
  await addPersonal(A, m.mPersonal);
  await addPersonal(A, m.mShared);
  await addOrg(A, X, m.mShared);
  await addOrg(A, X, m.mStale);
  // B curates a market A must never see.
  await addPersonal(B, m.mForeign);

  const visA = await listVisible(A);
  const scanA = await readScan(visA);
  const byId = new Map(scanA.map((r) => [r.market_id, r]));

  // ── 1. THE FIREWALL: B's market is service-role-readable but never reaches A's rail ──
  console.log('FIREWALL — cross-tenant scan data cannot leak into the rail:');
  const svcSeesForeign = (await svc.from('market_latest').select('market_id').eq('market_id', m.mForeign).maybeSingle()).data;
  ok(!!svcSeesForeign, `control: service-role CAN read B's market scan row (so exclusion is the firewall, not missing data)`);
  ok(!visA.some((r) => r.market_id === m.mForeign), `listVisible(A) excludes B's market (RLS-scoped union view)`);
  ok(!byId.has(m.mForeign), `readScan(listVisible(A)) excludes B's market — the rail cannot show a row A can't see`);

  // ── 2. The rail shows EXACTLY A's visible set ──
  console.log('\nVISIBILITY — rail set equals listVisible:');
  ok(byId.has(m.mPersonal) && byId.has(m.mShared) && byId.has(m.mStale),
    `readScan includes A's personal + org markets (mPersonal, mShared, mStale)`);
  ok(scanA.length === 3, `exactly 3 rows (mShared dedup-merged across scopes, not double-counted) — got ${scanA.length}`);

  // ── 3. DEDUP: a market in BOTH personal and org is ONE merged row, both scopes ──
  console.log('\nDEDUP — dual-scope market merges to one consistent row:');
  const shared = byId.get(m.mShared);
  ok(shared && shared.scopes.includes('personal') && shared.scopes.includes('org'),
    `mShared is one row carrying BOTH scopes ${shared ? JSON.stringify(shared.scopes) : '(missing)'}`);
  ok(shared?.personal === true, `merged dual-scope row sorts as personal-first`);

  // ── 4. NO RECOMPUTE DRIFT: every scan field equals the underlying market_latest row ──
  console.log('\nFIDELITY — scan fields match market_latest (cache read, no recompute):');
  for (const id of [m.mPersonal, m.mShared, m.mStale]) {
    const row = byId.get(id);
    const ml = (await svc.from('market_latest').select('implied_median, confidence_tier, lifecycle_state, is_final, stale_after, fetched_at, record').eq('market_id', id).maybeSingle()).data;
    const fieldsMatch = row.implied_median === ml.implied_median
      && row.confidence_tier === ml.confidence_tier
      && row.lifecycle_state === ml.lifecycle_state
      && row.is_final === ml.is_final
      && row.stale_after === ml.stale_after
      && row.fetched_at === ml.fetched_at;
    ok(fieldsMatch, `${id}: median/confidence/lifecycle/is_final/stale_after/fetched_at all equal market_latest`);
    ok(row.median_display === fmtT(ml.implied_median),
      `${id}: median_display "${row.median_display}" === fmtT(market_latest) (same formatter as detail view)`);
    const expectDelta = ml.record?.snapshot?.derived?.market?.analytics?.velocity?.change_24h?.display ?? null;
    ok(row.delta_display === expectDelta, `${id}: delta_display "${row.delta_display}" === stored velocity.change_24h.display`);
  }

  // ── 5. FRESHNESS inputs are passed through so the client can compute staleness ──
  console.log('\nFRESHNESS — stale market carries a PAST stale_after for the client pill:');
  const stale = byId.get(m.mStale);
  ok(stale.stale_after != null && Date.parse(stale.stale_after) < Date.now(),
    `mStale.stale_after is in the past → the client renders the STALE pill`);
  ok(byId.get(m.mPersonal).stale_after != null && Date.parse(byId.get(m.mPersonal).stale_after) > Date.now(),
    `mPersonal.stale_after is in the future → NOT stale`);

  // touch B to avoid an unused lint and assert B's own rail is independent
  const scanB = await readScan(await listVisible(B));
  ok(scanB.some((r) => r.market_id === m.mForeign) && !scanB.some((r) => r.market_id === m.mPersonal),
    `symmetry: B's rail shows B's market and none of A's`);
}

let exitCode = 1;
try {
  await run();
  exitCode = failures === 0 ? 0 : 1;
  console.log(`\n${failures === 0 ? '✓ RAIL-SCAN GATE PASSED — tenant-safe, no drift, dedup correct' : `✗ ${failures} check(s) FAILED`}\n`);
} catch (err) {
  console.error(`\n✗ gate errored before completing: ${err.message}\n`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);
