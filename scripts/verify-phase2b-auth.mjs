// scripts/verify-phase2b-auth.mjs — Phase 2b.2 GATE: invite-only must FAIL CLOSED.
//
// Proves, against a DEV Supabase with 0003 applied AND the Before-User-Created
// hook ENABLED:
//   NEGATIVE (the P0): an unlisted, valid-format email signUp is REJECTED and
//     leaves NO auth.users row (and no orphan profile). This also catches a
//     forgotten hook-enable — an unlisted signup SUCCEEDING fails this gate loudly.
//   POSITIVE (end to end): an allowlisted email → account + profiles row +
//     org_membership auto-provisioned + allowed_emails.consumed_at stamped + login.
//
// Uses the PUBLIC signUp flow via the anon key (admin.createUser would bypass the
// hook). Seeds its own throwaway org/emails, cleans up in finally.
//
//   SUPABASE_URL=…  SUPABASE_ANON_KEY=…  SUPABASE_SERVICE_ROLE_KEY=… \
//   node scripts/verify-phase2b-auth.mjs
// Exit: 0 pass · 1 a check failed (incl. fail-OPEN) · 2 not run (missing creds).

import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !ANON || !SERVICE) {
  console.error('Set SUPABASE_URL + SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY (dev project).');
  process.exit(2);
}

const RUN = Date.now().toString(36);
const PW = 'Test-Passw0rd!';
// Supabase's signup email validation REJECTS reserved TLDs (.test/.dev) and, with
// extended validation on, domains without MX — BEFORE the hook runs. Use a domain
// the project accepts (default example.com; override if your project rejects it).
// admin.createUser bypasses this validation, which is why the isolation gate's
// .test emails worked there but the public signUp positive path did not.
const DOMAIN = process.env.TEST_EMAIL_DOMAIN || 'example.com';
const svc = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = () => createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗ FAIL:'} ${m}`); if (!c) failures++; };

async function findUser(email) {
  const { data, error } = await svc.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error) throw new Error(`listUsers: ${error.message}`);
  return data.users.find((u) => (u.email || '').toLowerCase() === email.toLowerCase()) || null;
}

const created = { userIds: [], orgIds: [], emails: [] };

async function run() {
  console.log(`\nPhase 2b.2 auth gate → ${URL}  (run ${RUN}, domain @${DOMAIN})\n`);

  // ── NEGATIVE (P0): a VALID-FORMAT but UNLISTED email must be rejected by OUR
  //    allowlist hook (not by email-format validation) and leave NO auth.users row. ──
  console.log('NEGATIVE — valid-format but UNLISTED email rejected by OUR hook, no account:');
  const unlisted = `unlisted_${RUN}@${DOMAIN}`;
  created.emails.push(unlisted.toLowerCase());
  const neg = await anon().auth.signUp({ email: unlisted, password: PW });
  ok(!!neg.error, `signUp rejected (got: ${neg.error?.status ?? ''} "${neg.error?.message ?? 'NO ERROR — hook DISABLED or FAILING OPEN!'}")`);
  // CRITICAL: prove the ALLOWLIST rejected it, not email-format validation. Our hook
  // returns http_code 403 + the "invite-only" message; a format rejection is a
  // different code/message ("Email address is invalid") and must NOT pass here.
  const ours = neg.error?.status === 403 || /invite-only/i.test(neg.error?.message || '');
  ok(ours, `rejection came from OUR allowlist hook (403 / "invite-only"), not format validation`
    + (neg.error && !ours ? ` — got "${neg.error.message}"; looks like a format rejection: set TEST_EMAIL_DOMAIN to a domain your project accepts.` : ''));
  ok(!neg.data?.user, `no user object returned`);
  const ghost = await findUser(unlisted);
  if (ghost) created.userIds.push(ghost.id); // fail-open created a ghost → clean it up
  ok(!ghost, `NO auth.users row exists for the unlisted email (fail-CLOSED)`);
  const orphan = (await svc.from('profiles').select('id').eq('email', unlisted.toLowerCase())).data ?? [];
  ok(orphan.length === 0, `no orphan profiles row for the unlisted email`);

  // ── POSITIVE: allowlisted email → account + auto-provision + login ──
  console.log('\nPOSITIVE — allowlisted email: account + provisioning + login:');
  const org = await svc.from('organizations').insert({ name: `auth_${RUN}` }).select('id').single();
  if (org.error) throw new Error(`seed org: ${org.error.message}`);
  created.orgIds.push(org.data.id);
  const listed = `listed_${RUN}@${DOMAIN}`;
  created.emails.push(listed.toLowerCase());
  const ae = await svc.from('allowed_emails').insert({ email: listed.toLowerCase(), org_id: org.data.id, role: 'member' });
  if (ae.error) throw new Error(`seed allowlist: ${ae.error.message}`);

  const pos = await anon().auth.signUp({ email: listed, password: PW });
  ok(!pos.error, `allowlisted signUp accepted`
    + (pos.error ? ` — got "${pos.error.message}". If "invalid", the project rejects @${DOMAIN} at email-deliverability validation (runs AFTER the hook): set TEST_EMAIL_DOMAIN to a domain it accepts and disable "Confirm email" on the dev project.` : ''));
  const uid = pos.data?.user?.id;
  ok(!!uid, `auth.users row created`);
  if (uid) created.userIds.push(uid);

  // provisioning (handle_new_user fires at insert, even before email confirmation)
  const prof = uid ? (await svc.from('profiles').select('id,email').eq('id', uid).maybeSingle()).data : null;
  ok(!!prof && prof.email === listed.toLowerCase(), `profiles row auto-created`);
  const mem = uid ? ((await svc.from('org_membership').select('org_id,role').eq('user_id', uid)).data ?? []) : [];
  ok(mem.length === 1 && mem[0].org_id === org.data.id && mem[0].role === 'member',
     `org_membership auto-provisioned (correct org + role)`);
  const cons = (await svc.from('allowed_emails').select('consumed_at').eq('email', listed.toLowerCase()).maybeSingle()).data;
  ok(!!cons?.consumed_at, `allowed_emails.consumed_at stamped`);

  // login (admin-confirm fallback if the dev project requires email confirmation)
  if (uid) { try { await svc.auth.admin.updateUserById(uid, { email_confirm: true }); } catch { /* may already be confirmed */ } }
  const login = await anon().auth.signInWithPassword({ email: listed, password: PW });
  ok(!login.error && !!login.data?.session, `login (signInWithPassword) works`);
}

let exitCode = 1;
try {
  await run();
  exitCode = failures === 0 ? 0 : 1;
  console.log(`\n${failures === 0 ? '✓ AUTH GATE PASSED — invite-only fails CLOSED; provisioning + login work' : `✗ ${failures} auth check(s) FAILED — DO NOT proceed`}\n`);
} catch (err) {
  console.error(`\n✗ gate errored before completing: ${err.message}\n`);
  exitCode = 1;
} finally {
  for (const id of created.userIds) { try { await svc.auth.admin.deleteUser(id); } catch { /* best effort */ } }
  if (created.orgIds.length) await svc.from('organizations').delete().in('id', created.orgIds);
  if (created.emails.length) await svc.from('allowed_emails').delete().in('email', created.emails);
}
process.exit(exitCode);
