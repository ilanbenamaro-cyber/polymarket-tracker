// scripts/verify-phase2b-watchlist.mjs — Phase 2b.3 GATE: watchlist CRUD ops.
//
// Exercises lib/watchlist.mjs through a REAL signed-in user (authenticated role,
// RLS enforces) against a DEV Supabase with 0001+0002+0003 applied. Proves the
// happy paths, idempotency, org attribution, and the two typed-error edges —
// without service-role for the user ops. Then re-run verify-phase2b-isolation.mjs
// separately to confirm the CRUD layer didn't loosen the RLS firewall.
//
//   TEST_EMAIL_DOMAIN=<accepted> SUPABASE_URL=… SUPABASE_ANON_KEY=… \
//   SUPABASE_SERVICE_ROLE_KEY=… node scripts/verify-phase2b-watchlist.mjs
// Exit: 0 pass · 1 a check failed · 2 not run (missing creds).

import { createClient } from '@supabase/supabase-js';
import {
  addPersonal, removePersonal, addOrg, removeOrg, listVisible,
  MarketNotInCatalogError, NotPermittedError,
} from '../lib/watchlist.mjs';

const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !ANON || !SERVICE) {
  console.error('Set SUPABASE_URL + SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY (dev project).');
  process.exit(2);
}

const RUN = Date.now().toString(36);
const PW = 'Test-Passw0rd!';
const D = process.env.TEST_EMAIL_DOMAIN || 'example.com'; // Supabase rejects .test/.dev at validation
const svc = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗ FAIL:'} ${m}`); if (!c) failures++; };
const visHas = (rows, scope, marketId) => rows.some((r) => r.scope === scope && r.market_id === marketId);

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
const expectThrow = async (fn, Type, label) => {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  ok(err instanceof Type, `${label} (got ${err ? err.name : 'NO THROW'})`);
  return err;
};

const created = { users: [], orgs: [], markets: [] };

async function seed() {
  const M = (n) => `zzz-2b3-${RUN}-${n}`;
  const m = { m1: M('m1'), m2: M('m2'), mPerm: M('mPerm'), unknown: M('unknown-never-seeded') };
  created.markets = [m.m1, m.m2, m.mPerm]; // NOTE: m.unknown is intentionally NOT inserted
  const mi = await svc.from('markets').insert(created.markets.map((id) => ({ id, title: id, config: {} })));
  if (mi.error) throw new Error(`seed markets: ${mi.error.message}`);

  const X = (await svc.from('organizations').insert({ name: `X_${RUN}` }).select('id').single()).data.id;
  const Y = (await svc.from('organizations').insert({ name: `Y_${RUN}` }).select('id').single()).data.id;
  created.orgs = [X, Y];

  const emailA = `wa_${RUN}@${D}`, emailB = `wb_${RUN}@${D}`;
  const al = await svc.from('allowed_emails').insert([
    { email: emailA, org_id: X, role: 'member' }, { email: emailB, org_id: Y, role: 'member' },
  ]);
  if (al.error) throw new Error(`seed allowlist: ${al.error.message}`);
  const aId = await mkUser(emailA), bId = await mkUser(emailB);
  created.users = [aId, bId];
  // coexist with handle_new_user (may have auto-provisioned): upsert/ignore-conflict
  await svc.from('profiles').upsert([{ id: aId, email: emailA }, { id: bId, email: emailB }],
    { onConflict: 'id', ignoreDuplicates: true });
  await svc.from('org_membership').upsert([
    { org_id: X, user_id: aId, role: 'member' }, { org_id: Y, user_id: bId, role: 'member' },
  ], { onConflict: 'org_id,user_id', ignoreDuplicates: true });

  return { m, X, Y, emailA, emailB, aId };
}

async function cleanup() {
  for (const id of created.users) { try { await svc.auth.admin.deleteUser(id); } catch { /* best effort */ } }
  if (created.orgs.length) await svc.from('organizations').delete().in('id', created.orgs);
  if (created.markets.length) await svc.from('markets').delete().in('id', created.markets);
}

async function run() {
  console.log(`\nPhase 2b.3 watchlist gate → ${URL}  (run ${RUN}, domain @${D})\n`);
  const { m, X, Y, emailA, aId } = await seed();
  const A = await signedIn(emailA); // member of org X

  // ── personal CRUD + idempotency ──
  console.log('PERSONAL — add / list / idempotent add / remove:');
  await addPersonal(A, m.m1);
  ok(visHas(await listVisible(A), 'personal', m.m1), `addPersonal → listVisible shows {personal, m1}`);
  await addPersonal(A, m.m1); // duplicate
  const pcount = (await svc.from('personal_watchlist').select('market_id').eq('user_id', aId).eq('market_id', m.m1)).data ?? [];
  ok(pcount.length === 1, `duplicate addPersonal is idempotent (exactly one row)`);
  ok((await removePersonal(A, m.m1)).removed === 1, `removePersonal returns { removed: 1 }`);
  ok(!visHas(await listVisible(A), 'personal', m.m1), `after remove, not visible`);
  ok((await removePersonal(A, m.m1)).removed === 0, `removing again returns { removed: 0 } (idempotent)`);

  // ── org CRUD + attribution + idempotency ──
  console.log('\nORG — add (attribution) / list / idempotent / remove:');
  await addOrg(A, X, m.m2);
  ok(visHas(await listVisible(A), 'org', m.m2), `addOrg → listVisible shows {org, m2}`);
  const attr = (await svc.from('org_watchlist').select('added_by').eq('org_id', X).eq('market_id', m.m2).maybeSingle()).data;
  ok(attr?.added_by === aId, `org entry attributes added_by = self`);
  await addOrg(A, X, m.m2); // duplicate
  const ocount = (await svc.from('org_watchlist').select('market_id').eq('org_id', X).eq('market_id', m.m2)).data ?? [];
  ok(ocount.length === 1, `duplicate addOrg is idempotent (exactly one row)`);
  ok((await removeOrg(A, X, m.m2)).removed === 1, `removeOrg returns { removed: 1 }`);
  ok(!visHas(await listVisible(A), 'org', m.m2), `after remove, not visible`);

  // ── typed-error edges (RLS/FK surfaced, never pre-checked) ──
  console.log('\nEDGES — typed errors from the DB, not app pre-checks:');
  await expectThrow(() => addPersonal(A, m.unknown), MarketNotInCatalogError,
    `addPersonal(market not in catalog) → MarketNotInCatalogError (FK 23503)`);
  // A is a member of X, NOT Y: writing org Y's list (a market not already there) → RLS 42501
  await expectThrow(() => addOrg(A, Y, m.mPerm), NotPermittedError,
    `addOrg(other org) → NotPermittedError (RLS 42501)`);
  const leak = (await svc.from('org_watchlist').select('*').eq('org_id', Y).eq('market_id', m.mPerm)).data ?? [];
  ok(leak.length === 0, `no row landed in org Y's list from the rejected addOrg`);
}

let exitCode = 1;
try {
  await run();
  exitCode = failures === 0 ? 0 : 1;
  console.log(`\n${failures === 0 ? '✓ WATCHLIST GATE PASSED — CRUD ops correct; RLS surfaced as typed errors' : `✗ ${failures} watchlist check(s) FAILED`}\n`);
} catch (err) {
  console.error(`\n✗ gate errored before completing: ${err.message}\n`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);
