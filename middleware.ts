// middleware.ts — the auth GATE that replaces the Vercel deployment-protection
// wall. Runs on every matched request: refreshes the Supabase session cookie AND
// blocks unauthenticated access to the app.
//
// NEGATIVE guarantee (the security-critical half — see scripts/verify-2c1-authgate.mjs):
//   no session + a protected route  → 307 redirect to /login (renders no dashboard).
//   session + /login                → redirect to /  (already in).
// Non-session API exceptions (the middleware must NOT redirect these to /login —
// each governs its own auth): /api/market (public verified data, no-store) and
// /api/snapshot (the daily cron, authenticated by its CRON_SECRET bearer, not a
// session cookie — see app/api/snapshot/route.ts).
// Uses the ANON key only; never the service-role key.
//
// RUNTIME: Node.js (not Edge). Edge middleware did not materialize NEXT_PUBLIC_*
// at runtime (the build-time inlining gap); the Node runtime reads the real
// process.env, so the env resolves deterministically. Stable since Next 15.5.0.
import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient, type SetAllCookies } from '@supabase/ssr';

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error(
      'middleware: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY missing at runtime — the auth gate cannot initialize',
    );
  }

  const supabase = createServerClient(
    url,
    anon,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: Parameters<SetAllCookies>[0]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  // IMPORTANT: getUser() validates the JWT with the auth server (don't trust a
  // local getSession() for an authorization decision).
  const { data: { user } } = await supabase.auth.getUser();
  const { pathname } = request.nextUrl;
  const isAuthRoute = pathname === '/login' || pathname.startsWith('/login/')
    || pathname === '/signup' || pathname.startsWith('/signup/'); // invite-acceptance (Enh 6)
  // Routes whose OWN auth governs them (not the session cookie) — never session-redirect:
  //   /api/market   = public verified market data (no-store);
  //   /api/snapshot = the cron job, gated by CRON_SECRET bearer in the route handler.
  const isNonSessionApi = pathname.startsWith('/api/market') || pathname.startsWith('/api/snapshot');

  if (!user && !isAuthRoute && !isNonSessionApi) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    return NextResponse.redirect(loginUrl);
  }
  if (user && isAuthRoute) {
    const homeUrl = request.nextUrl.clone();
    homeUrl.pathname = '/';
    return NextResponse.redirect(homeUrl);
  }
  return response;
}

export const config = {
  // Node.js runtime (stable since Next 15.5.0): real process.env access, so
  // NEXT_PUBLIC_* resolves at runtime (Edge did not materialize it). Gate logic
  // is unchanged — only the runtime + env-reading mechanism.
  runtime: 'nodejs',
  // Run on everything except Next internals + static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|favicon.svg|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
