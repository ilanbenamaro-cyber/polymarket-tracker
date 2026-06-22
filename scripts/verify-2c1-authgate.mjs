// scripts/verify-2c1-authgate.mjs — Phase 2c.1 auth-gate NEGATIVE proof.
//
// The gate that replaces the Vercel wall must keep people OUT, not just let you in.
// Against a running dev/preview deploy, this asserts (no auth, no cookies):
//   1. a protected route (/) REDIRECTS to /login and serves NO dashboard markup;
//   2. the public verified-data route (/api/market) is NOT gated (no login redirect).
//
// The POSITIVE half (login → dashboard) and LOGOUT → re-protect are a real-cookie
// browser flow — verify them with Playwright or by hand (recipe in the handoff);
// this script proves the security-critical NEGATIVE that can't be eyeballed reliably.
//
//   BASE_URL=https://your-preview.vercel.app  node scripts/verify-2c1-authgate.mjs
// Exit: 0 pass · 1 a check failed (gate leaks) · 2 not run (missing BASE_URL).

const BASE = process.env.BASE_URL;
if (!BASE) { console.error('Set BASE_URL=https://your-dev-deploy'); process.exit(2); }
const PROTECTED = process.env.PROTECTED_PATH || '/';
// Optional Vercel deployment-protection bypass for automation: gets past the
// Vercel SSO wall WITHOUT disabling it, so the APP middleware still runs (the
// unauth→/login proof stays valid). No-op when the secret is absent.
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const BYPASS_HEADER = BYPASS ? { 'x-vercel-protection-bypass': BYPASS } : {};

let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗ FAIL:'} ${m}`); if (!c) failures++; };
const isRedirect = (s) => [301, 302, 303, 307, 308].includes(s);

console.log(`\nPhase 2c.1 auth-gate NEGATIVE proof → ${BASE}\n`);

// 1. unauthenticated → protected route must redirect to /login, leak no dashboard.
{
  const res = await fetch(`${BASE}${PROTECTED}`, { redirect: 'manual', headers: { cookie: '', ...BYPASS_HEADER } });
  const loc = res.headers.get('location') || '';
  ok(isRedirect(res.status) && /\/login/.test(loc),
     `unauth GET ${PROTECTED} → redirect to /login (got ${res.status} → "${loc || '(none)'}")`);
  // belt-and-braces: even if a body came back, it must NOT contain the dashboard shell
  const body = res.status < 300 ? await res.text() : '';
  ok(!/data-zone="(rail|detail|search)"/.test(body),
     `no dashboard markup leaked on the unauth response`);
}

// 2. the public market route is NOT behind the login gate (it's public + no-store).
{
  const res = await fetch(`${BASE}/api/market?id=__authgate_probe__`, { redirect: 'manual', headers: { ...BYPASS_HEADER } });
  const loc = res.headers.get('location') || '';
  const gatedToLogin = isRedirect(res.status) && /\/login/.test(loc);
  ok(!gatedToLogin, `/api/market is NOT gated to /login (got ${res.status}${loc ? ` → ${loc}` : ''})`);
}

console.log(`\n${failures === 0 ? '✓ AUTH-GATE NEGATIVE PROOF PASSED — unauth is blocked; public route open' : `✗ ${failures} check(s) FAILED — the gate leaks`}\n`);
process.exit(failures === 0 ? 0 : 1);
