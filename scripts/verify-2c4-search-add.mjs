// scripts/verify-2c4-search-add.mjs — Phase 2c.4 GATE (data layer): search +
// compute-then-add + remove, the load-bearing flow Zone 3 wires.
//
// Proves headless, against a real DEV Supabase + the public gamma API, through a REAL
// signed-in throwaway user (authenticated role, RLS enforced):
//   (1) SEARCH: gamma public-search returns events with a `slug` (the compute id).
//   (2) GUARD: addPersonal WITHOUT compute → MarketNotInCatalogError (FK 23503). This is
//       why the ordering is load-bearing — add-before-compute is rejected by the DB.
//   (3) COMPUTE-THEN-ADD: serveMarket() populates the catalog (a market_snapshots row
//       EXISTS for the slug — the compute side-effect, not just the add), then the add
//       succeeds and listVisible shows it, then remove drops it.
// SpaceX (RESOLVED, served cache-final → deterministic, no live Polymarket) is the add
// target. The Playwright gate covers the live fresh-add (a NEW market's snapshot row
// appears) + the dual-scope remove UI.
//
//   TEST_EMAIL_DOMAIN=<accepted> SUPABASE_URL=… SUPABASE_ANON_KEY=… \
//   SUPABASE_SERVICE_ROLE_KEY=… node scripts/verify-2c4-search-add.mjs
// Exit: 0 pass · 1 a check failed · 2 not run (missing creds).

import { createClient } from '@supabase/supabase-js';
import { addPersonal, removePersonal, listVisible, MarketNotInCatalogError } from '../lib/watchlist.mjs';
import { serveMarket } from '../lib/serve-market.mjs';
import { DEPS } from '../lib/market-deps.mjs';

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
const SPACEX = process.env.SPACEX_ID || 'spacex-ipo-closing-market-cap-above';
const GAMMA_SEARCH = 'https://gamma-api.polymarket.com/public-search';
const svc = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗ FAIL:'} ${m}`); if (!c) failures++; };
const created = { users: [], orgs: [] };

async function signedIn(email) {
  const c = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password: PW });
  if (error || !data?.session) throw new Error(`sign-in ${email}: ${error?.message}`);
  return c;
}
async function seedUser() {
  const email = `s4_${RUN}@${D}`;
  const X = (await svc.from('organizations').insert({ name: `S4_${RUN}` }).select('id').single()).data.id;
  created.orgs = [X];
  await svc.from('allowed_emails').insert({ email, org_id: X, role: 'member' });
  const { data, error } = await svc.auth.admin.createUser({ email, password: PW, email_confirm: true });
  if (error) throw new Error(`createUser: ${error.message}`);
  created.users = [data.user.id];
  await svc.from('profiles').upsert({ id: data.user.id, email }, { onConflict: 'id', ignoreDuplicates: true });
  await svc.from('org_membership').upsert({ org_id: X, user_id: data.user.id, role: 'member' }, { onConflict: 'org_id,user_id', ignoreDuplicates: true });
  return email;
}
async function cleanup() {
  // remove the watchlist row we may have added, then the throwaway user/org
  for (const uid of created.users) { try { await svc.from('personal_watchlist').delete().eq('user_id', uid); await svc.auth.admin.deleteUser(uid); } catch { /* best effort */ } }
  if (created.orgs.length) await svc.from('organizations').delete().in('id', created.orgs);
}

async function run() {
  console.log(`\nPhase 2c.4 search + compute-then-add gate → ${URL}  (run ${RUN}, domain @${D})\n`);

  // ── 1. SEARCH (public gamma) returns a usable slug ──
  console.log('SEARCH — gamma public-search returns events with a slug:');
  let firstSlug = null;
  try {
    const res = await fetch(`${GAMMA_SEARCH}?q=spacex&limit_per_type=5`, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    const events = Array.isArray(data?.events) ? data.events : [];
    firstSlug = events.find((e) => e.slug)?.slug ?? null;
    ok(events.length > 0 && !!firstSlug, `public-search?q=spacex → ${events.length} events, slug e.g. "${firstSlug}"`);
  } catch (e) {
    ok(false, `gamma search reachable (${e.message})`);
  }

  const email = await seedUser();
  const A = await signedIn(email);

  // ── 2. GUARD: add before compute is rejected by the FK ──
  console.log('\nGUARD — add-before-compute throws MarketNotInCatalogError (ordering is load-bearing):');
  let guardErr = null;
  try { await addPersonal(A, `zzz-2c4-${RUN}-never-computed`); } catch (e) { guardErr = e; }
  ok(guardErr instanceof MarketNotInCatalogError, `addPersonal(uncomputed) → MarketNotInCatalogError (got ${guardErr ? guardErr.name : 'NO THROW'})`);

  // ── 3. COMPUTE-THEN-ADD then REMOVE ──
  console.log('\nCOMPUTE-THEN-ADD — serveMarket populates the catalog, then add/list/remove:');
  const { status } = await serveMarket({ id: SPACEX, deps: DEPS });
  ok(status === 200, `serveMarket(SpaceX) → 200 (got ${status}) — SpaceX must be seeded on dev`);
  if (status !== 200) return;

  const snaps = (await svc.from('market_snapshots').select('market_id').eq('market_id', SPACEX)).data ?? [];
  ok(snaps.length >= 1, `market_snapshots has a row for the slug (compute side-effect ran, not just the add)`);

  await addPersonal(A, SPACEX);
  ok((await listVisible(A)).some((r) => r.market_id === SPACEX && r.scope === 'personal'), `after compute, addPersonal succeeds → listVisible shows it`);
  ok((await removePersonal(A, SPACEX)).removed === 1, `removePersonal removes it (removed: 1)`);
  ok(!(await listVisible(A)).some((r) => r.market_id === SPACEX), `after remove, not visible`);
}

let exitCode = 1;
try {
  await run();
  exitCode = failures === 0 ? 0 : 1;
  console.log(`\n${failures === 0 ? '✓ SEARCH+ADD GATE PASSED — search ok, FK guard fires, compute-then-add + remove correct' : `✗ ${failures} check(s) FAILED`}\n`);
} catch (err) {
  console.error(`\n✗ gate errored before completing: ${err.message}\n`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);
