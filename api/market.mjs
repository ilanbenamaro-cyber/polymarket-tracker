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
  if (status === 200) res.setHeader('cache-control', 'public, max-age=30'); // CDN may hold a served record briefly
  res.end(JSON.stringify(body));
}
