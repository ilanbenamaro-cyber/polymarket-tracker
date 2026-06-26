// app/api/backfill/route.ts — the per-market history backfill (backfill I4).
//
// When a user adds a market, addMarket fire-and-forgets a call here; this rebuilds
// market_history from Polymarket's CLOB prices-history (lib/backfill.backfillMarket) so the
// velocity/dispersion/Δ/movers/chart populate immediately instead of waiting weeks for the
// daily cron. The dedicated route gives the (potentially minutes-long) rebuild its OWN function
// budget — the add stays instant.
//
// SECURITY: identical posture to /api/snapshot — a write-capable, service-role job that must
// NOT be publicly callable. Authorized by a TIMING-SAFE CRON_SECRET Bearer; FAILS CLOSED when
// the secret is unset. (middleware.ts excludes this path from session auth — its own bearer is
// the gate — same as /api/market and /api/snapshot.)
//
// Modes: default = async — ACK 202 immediately and run the backfill in after() (so the caller's
// fetch returns fast and THIS invocation owns the work). `?wait=1` = synchronous — await the
// backfill and return its summary (used by the operator live gate + a future cron retry).

import { timingSafeEqual } from 'node:crypto';
import { after } from 'next/server';
import { backfillMarket, DEPS_BACKFILL } from '@/lib/backfill.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A multi-hundred-day rebuild + per-leg history fetches needs room; raise toward the plan limit
// as needed (Hobby caps at 60s — this assumes a Pro deployment for large markets).
export const maxDuration = 300;

const NO_STORE = { 'cache-control': 'no-store' } as const;

/** Timing-safe `Authorization: Bearer <CRON_SECRET>`; fails CLOSED when the secret is unset. */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const got = Buffer.from(req.headers.get('authorization') ?? '');
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

async function handle(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }
  const url = new URL(req.url);
  const id = (url.searchParams.get('id') ?? '').trim();
  if (!id) {
    return Response.json({ error: 'missing ?id=<event_slug>' }, { status: 400, headers: NO_STORE });
  }
  const wait = url.searchParams.get('wait') === '1';

  if (wait) {
    const summary = await backfillMarket({ slug: id, deps: DEPS_BACKFILL });
    console.log('[backfill]', JSON.stringify({ id, ...summary }));
    return Response.json({ ok: true, id, ...summary }, { status: 200, headers: NO_STORE });
  }

  // Async: ACK now, do the work in this invocation's after() (its own budget; caller unblocked).
  after(async () => {
    try {
      const summary = await backfillMarket({ slug: id, deps: DEPS_BACKFILL });
      console.log('[backfill]', JSON.stringify({ id, ...summary }));
    } catch (e) {
      console.error('[backfill]', JSON.stringify({ id, error: (e as Error).message }));
    }
  });
  return Response.json({ ok: true, id, accepted: true }, { status: 202, headers: NO_STORE });
}

// Accept GET (cron/live-gate convenience) and POST (the addMarket trigger).
export const GET = handle;
export const POST = handle;
