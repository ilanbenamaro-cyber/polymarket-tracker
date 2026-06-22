// app/api/market/route.ts — Next.js Route Handler: serve ONE verified market.
//
// PORTED from api/market.mjs (2a). Behavior is INTENTIONALLY IDENTICAL: it injects
// the SAME deps into the SAME serveMarket() orchestration and sets the SAME
// `Cache-Control: no-store`. The verified pipeline (lib/compute → core/), the
// resolution probe, and the no-store correctness boundary are UNCHANGED — they live
// in lib/ + core/, untouched by 2c. Re-running scripts/verify-phase2a.mjs against
// this deploy (12/12) is the proof the relocation changed nothing.
//
// Route handlers are server-only by nature (never client-bundled), so importing the
// service-role-backed lib/cache.mjs + lib/compute.mjs here is safe.
import { readCache, writeRecord, touchProbe } from '@/lib/cache.mjs';
import { computeMarketRecord, probeLifecycle } from '@/lib/compute.mjs';
import { serveMarket } from '@/lib/serve-market.mjs';

// Node runtime (NOT edge): core/ uses readFileSync + Node APIs, and lib/cache.mjs
// uses @supabase/supabase-js with the service-role key. The "process.version not
// supported in Edge" warning is about edge bundling; pinning nodejs keeps the
// verified pipeline on Node where it belongs.
export const runtime = 'nodejs';
// Never statically optimize: every request must run (resolution probe is per-call).
export const dynamic = 'force-dynamic';

const DEPS = { readCache, writeRecord, touchProbe, computeMarketRecord, probeLifecycle };

export async function GET(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get('id') ?? '';
  const { status, body } = await serveMarket({ id, deps: DEPS });
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // LOAD-BEARING (decisions.md "/api/market is never HTTP-cached"): no-store so
      // every request reaches the function and runs the resolution probe. Do not relax.
      'cache-control': 'no-store',
    },
  });
}
