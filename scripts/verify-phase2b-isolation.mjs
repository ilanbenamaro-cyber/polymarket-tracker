// scripts/verify-phase2b-isolation.mjs — Phase 2b.1 BLOCKING GATE.
//
// Proves, through REAL Supabase-Auth JWTs (not service-role, not simulated
// claims), that the RLS firewall isolates tenants: a user can read/write ONLY
// their own personal list + their own org's shared list, and the union view
// returns exactly personal ∪ org. A leak here is the 2b P0 — 2b does not
// proceed until this exits 0. This is the 2b analogue of the byte-identical
// hash gate.
//
// Run AFTER applying supabase/migrations/0002_phase2b.sql to a DEV/branch
// Supabase (NOT prod), with creds in env:
//   SUPABASE_URL=…  SUPABASE_ANON_KEY=…  SUPABASE_SERVICE_ROLE_KEY=… \
//   node scripts/verify-phase2b-isolation.mjs
//
// It seeds its OWN throwaway orgs/users/markets (unique per run), exercises RLS
// as two+ signed-in users, and cleans everything up in a finally block.
// Exit: 0 all isolation checks pass · 1 a check failed (LEAK or unexpected) · 2 not run (missing creds).

import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !ANON || !SERVICE) {
  console.error('Set SUPABASE_URL + SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY (dev project).');
  process.exit(2);
}

const RUN = Date.now().toString(36);
const svc = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✓' : '  ✗ LEAK/UNEXPECTED:'} ${msg}`); if (!cond) failures++; };
const ids = (rows) => (rows ?? []).map((r) => r.market_id).sort();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A signed-in client carrying a real user JWT (RLS applies as that user).
async function signedInClient(email, password) {
  const c = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error || !data?.session) throw new Error(`sign-in failed for ${email}: ${error?.message}`);
  return c;
}

const PW = 'Test-Passw0rd!';
const mkUser = async (tag) => {
  const email = `${tag}_${RUN}@dev.test`;
  const { data, error } = await svc.auth.admin.createUser({ email, password: PW, email_confirm: true });
  if (error) throw new Error(`createUser ${email}: ${error.message}`);
  const id = data.user.id;
  const up = await svc.from('profiles').insert({ id, email });
  if (up.error) throw new Error(`profile ${email}: ${up.error.message}`);
  return { id, email };
};

const created = { users: [], orgs: [], markets: [] };

async function seed() {
  // markets m1..m4 + mX (FK targets; minimal valid 2a rows). mX is used for the
  // BLOCKED-write attempts so the ONLY possible rejection reason is RLS, not FK.
  const M = (n) => `zzz-2b-${RUN}-${n}`;
  const m = { m1: M('m1'), m2: M('m2'), m3: M('m3'), m4: M('m4'), mX: M('mX') };
  created.markets = Object.values(m);
  const mi = await svc.from('markets').insert(created.markets.map((id) => ({ id, title: id, config: {} })));
  if (mi.error) throw new Error(`seed markets: ${mi.error.message}`);

  // orgs X, Y
  const oX = (await svc.from('organizations').insert({ name: `X_${RUN}` }).select('id').single());
  const oY = (await svc.from('organizations').insert({ name: `Y_${RUN}` }).select('id').single());
  if (oX.error || oY.error) throw new Error(`seed orgs: ${oX.error?.message || oY.error?.message}`);
  const X = oX.data.id, Y = oY.data.id;
  created.orgs = [X, Y];

  // users: A & C in org X, B in org Y
  const A = await mkUser('a'), B = await mkUser('b'), C = await mkUser('c');
  created.users = [A.id, B.id, C.id];
  const mem = await svc.from('org_membership').insert([
    { org_id: X, user_id: A.id, role: 'admin' },
    { org_id: X, user_id: C.id, role: 'member' },
    { org_id: Y, user_id: B.id, role: 'member' },
  ]);
  if (mem.error) throw new Error(`seed membership: ${mem.error.message}`);

  // personal lists: A→m1, B→m4 ; org lists: X→m2 (by A), Y→m3 (by B)
  const pw = await svc.from('personal_watchlist').insert([
    { user_id: A.id, market_id: m.m1 }, { user_id: B.id, market_id: m.m4 },
  ]);
  const ow = await svc.from('org_watchlist').insert([
    { org_id: X, market_id: m.m2, added_by: A.id }, { org_id: Y, market_id: m.m3, added_by: B.id },
  ]);
  if (pw.error || ow.error) throw new Error(`seed watchlists: ${pw.error?.message || ow.error?.message}`);

  return { m, X, Y, A, B, C };
}

async function cleanup() {
  // delete users → cascades profiles → cascades their personal_watchlist + membership.
  for (const id of created.users) { try { await svc.auth.admin.deleteUser(id); } catch { /* best effort */ } }
  // delete orgs → cascades membership + org_watchlist + allowed_emails.
  if (created.orgs.length) await svc.from('organizations').delete().in('id', created.orgs);
  if (created.markets.length) await svc.from('markets').delete().in('id', created.markets);
}

async function run() {
  console.log(`\nPhase 2b.1 isolation gate → ${URL}  (run ${RUN})\n`);
  const { m, X, Y, A, B, C } = await seed();
  const ca = await signedInClient(A.email, PW); // A: org X (admin)
  const cb = await signedInClient(B.email, PW); // B: org Y

  // ── A sees ONLY its own personal + its org's shared list ──
  console.log('A (org X) read scoping:');
  ok(eq(ids((await ca.from('personal_watchlist').select('market_id')).data), [m.m1]),
     `personal = [m1] only (not B's m4)`);
  ok(eq(ids((await ca.from('org_watchlist').select('market_id')).data), [m.m2]),
     `org_watchlist = [m2] only (not org Y's m3)`);
  const view = (await ca.from('my_visible_watchlist').select('scope, market_id')).data ?? [];
  ok(view.length === 2
     && view.some((r) => r.scope === 'personal' && r.market_id === m.m1)
     && view.some((r) => r.scope === 'org' && r.market_id === m.m2),
     `my_visible_watchlist = {personal:m1, org:m2} exactly (security_invoker inherits RLS)`);

  // ── A cannot SEE another org's metadata ──
  console.log('A cross-tenant read denial:');
  ok(eq((await ca.from('organizations').select('id')).data?.map((r) => r.id).sort(), [X]),
     `organizations = [X] only (not Y)`);
  const memRows = (await ca.from('org_membership').select('org_id, user_id')).data ?? [];
  ok(memRows.length > 0 && memRows.every((r) => r.org_id === X),
     `org_membership = org X rows only (no org Y / user B membership visible)`);
  const profRows = (await ca.from('profiles').select('id')).data?.map((r) => r.id) ?? [];
  ok(profRows.includes(A.id) && profRows.includes(C.id) && !profRows.includes(B.id),
     `profiles = self + co-org C, NOT cross-org B (shares_org enforced)`);

  // ── A cannot WRITE into B's personal list or org Y's list (use mX so only RLS can reject) ──
  console.log('A cross-tenant write denial:');
  const insB = await ca.from('personal_watchlist').insert({ user_id: B.id, market_id: m.mX });
  ok(!!insB.error, `insert into B's personal list REJECTED (${insB.error?.code ?? 'no error!'})`);
  const insY = await ca.from('org_watchlist').insert({ org_id: Y, market_id: m.mX, added_by: A.id });
  ok(!!insY.error, `insert into org Y's list REJECTED (${insY.error?.code ?? 'no error!'})`);
  // confirm via service-role that nothing was actually written
  const leakB = (await svc.from('personal_watchlist').select('*').eq('user_id', B.id).eq('market_id', m.mX)).data ?? [];
  const leakY = (await svc.from('org_watchlist').select('*').eq('org_id', Y).eq('market_id', m.mX)).data ?? [];
  ok(leakB.length === 0, `no phantom row landed in B's personal list`);
  ok(leakY.length === 0, `no phantom row landed in org Y's list`);

  // ── A's DELETE cannot touch B's / org Y's rows (RLS filters → 0 rows; targets survive) ──
  console.log('A cross-tenant delete denial:');
  const delB = await ca.from('personal_watchlist').delete().eq('user_id', B.id).eq('market_id', m.m4).select();
  ok((delB.data ?? []).length === 0, `delete of B's personal row affected 0 rows`);
  const delY = await ca.from('org_watchlist').delete().eq('org_id', Y).eq('market_id', m.m3).select();
  ok((delY.data ?? []).length === 0, `delete of org Y's row affected 0 rows`);
  const survB = (await svc.from('personal_watchlist').select('*').eq('user_id', B.id).eq('market_id', m.m4)).data ?? [];
  const survY = (await svc.from('org_watchlist').select('*').eq('org_id', Y).eq('market_id', m.m3)).data ?? [];
  ok(survB.length === 1, `B's personal row survived A's delete attempt`);
  ok(survY.length === 1, `org Y's row survived A's delete attempt`);

  // ── symmetric spot-check: B sees only its own ──
  console.log('B (org Y) read scoping (symmetry):');
  ok(eq(ids((await cb.from('personal_watchlist').select('market_id')).data), [m.m4]),
     `B personal = [m4] only (not A's m1)`);
  ok(eq(ids((await cb.from('org_watchlist').select('market_id')).data), [m.m3]),
     `B org_watchlist = [m3] only (not org X's m2)`);

  // ── positive: A (member of X) CAN curate org X's shared list (added_by = self) ──
  console.log('A positive: can curate own org X list:');
  const okInsX = await ca.from('org_watchlist').insert({ org_id: X, market_id: m.mX, added_by: A.id });
  ok(!okInsX.error, `A inserts into org X's list (member, added_by self) ALLOWED`);
}

let exitCode = 1;
try {
  await run();
  exitCode = failures === 0 ? 0 : 1;
  console.log(`\n${failures === 0 ? '✓ ISOLATION GATE PASSED — RLS firewall holds' : `✗ ${failures} isolation check(s) FAILED — DO NOT proceed to 2b.2`}\n`);
} catch (err) {
  console.error(`\n✗ gate errored before completing: ${err.message}\n`);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);
