// api/market.mjs — Vercel serverless function: serve ONE verified market record.
//
// GET /api/market?id=<polymarket-event-slug>
//   → 200 { market_id, cached, age_seconds, lifecycle_state, record }
// Thin HTTP shell: it injects the real cache + Polymarket + compute implementations
// into serveMarket() (lib/serve-market.mjs), which owns the orchestration. The
// verified pipeline runs on the backend (lib/compute → core/); the client never
// fetches Polymarket and never bypasses core/. Only a core/-validated record is
// ever returned or cached.

import { readCache, writeRecord, touchProbe } from '../lib/cache.mjs';
import { computeMarketRecord, probeLifecycle } from '../lib/compute.mjs';
import { serveMarket } from '../lib/serve-market.mjs';

const DEPS = { readCache, writeRecord, touchProbe, computeMarketRecord, probeLifecycle };

export default async function handler(req, res) {
  const id =
    (req.query && req.query.id) ||
    new URL(req.url, 'http://localhost').searchParams.get('id');
  const { status, body } = await serveMarket({ id, deps: DEPS });

  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  // NEVER cache this response (edge, proxy, or browser). Every request MUST reach
  // the function so the per-call resolution probe runs (decideBeforeProbe → PROBE):
  // a `public, max-age` response is replayed by Vercel's Edge (x-vercel-cache: HIT)
  // WITHOUT executing the function, so a market that resolved after caching could be
  // served as OPEN for the cache window — the exact stale-live gap C4 prevents.
  // The Supabase cache (not HTTP caching) is the cost layer: a hit serves cached:true
  // with zero Polymarket calls. See _knowledge/gotchas.md "Vercel edge-caches …".
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}
