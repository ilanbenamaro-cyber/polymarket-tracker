// api/market.mjs — Vercel serverless function: serve ONE verified market record.
//
// GET /api/market?id=<polymarket-event-slug>
//   → 200 { market_id, cached, age_seconds, lifecycle_state, record }
// The verified pipeline runs on the backend (lib/compute → core/); the client never
// fetches Polymarket and never bypasses core/. Reads from the Supabase cache when
// fresh; resolution is authoritative over the cache (lib/decide-cache-action).
// Only ever returns a core/-validated record, or an error.

import { readCache, writeRecord, touchProbe } from '../lib/cache.mjs';
import { computeMarketRecord, probeLifecycle } from '../lib/compute.mjs';
import { decideBeforeProbe, decideAfterProbe } from '../lib/decide-cache-action.mjs';

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  // Cache is the throttle; let CDNs hold a served record briefly (not errors).
  if (code === 200) res.setHeader('cache-control', 'public, max-age=30');
  res.end(JSON.stringify(body));
}

function serve(res, { marketId, cached, snapshotRow = null, record = null, lifecycleState }) {
  const rec = record ?? snapshotRow.record;
  const asOf = Date.parse(rec.snapshot.fetched_at);
  return json(res, 200, {
    market_id: marketId,
    cached,
    age_seconds: Math.max(0, Math.round((Date.now() - asOf) / 1000)),
    lifecycle_state: lifecycleState,
    record: rec,
  });
}

/** Map an internal error to an HTTP status (never leak unvalidated data). */
function statusFor(err) {
  if (Number.isInteger(err.code)) return err.code; // 404 / 409 from compute
  if (/^Record invalid/.test(err.message)) return 422; // failed validateRecord — never cached
  if (/→ \d{3}\b|Gamma API|CLOB/.test(err.message)) return 502; // Polymarket upstream
  return 500;
}

export default async function handler(req, res) {
  try {
    const id =
      (req.query && req.query.id) ||
      new URL(req.url, 'http://localhost').searchParams.get('id');
    if (!id || typeof id !== 'string') return json(res, 400, { error: 'missing ?id=<event_slug>' });
    const marketId = id.trim();

    const { snapshot, market } = await readCache(marketId);
    let decision = decideBeforeProbe({
      lifecycleState: snapshot?.lifecycle_state ?? null,
      cachedAtMs: snapshot ? Date.parse(snapshot.cached_at) : null,
      lastCheckedAtMs: market?.last_checked_at ? Date.parse(market.last_checked_at) : null,
      nowMs: Date.now(),
    });

    // A within-TTL OPEN/CLOSED_PENDING record: confirm it hasn't resolved before
    // serving (resolution authoritative over the cache).
    if (decision === 'PROBE') {
      const { lifecycle } = await probeLifecycle(marketId);
      await touchProbe(marketId, lifecycle.state, lifecycle.resolved_outcome);
      decision = decideAfterProbe(lifecycle.state); // SERVE_FRESH | RECOMPUTE
    }

    if (decision === 'SERVE_FINAL' || decision === 'SERVE_FRESH') {
      return serve(res, { marketId, cached: true, snapshotRow: snapshot, lifecycleState: snapshot.lifecycle_state });
    }

    // COMPUTE (miss) or RECOMPUTE (TTL-expired, or probe found it left OPEN).
    const prior = snapshot?.record ?? null;
    const { record, lifecycle, config } = await computeMarketRecord({ id: marketId, prior });
    await writeRecord(marketId, record, lifecycle, config);
    return serve(res, { marketId, cached: false, record, lifecycleState: lifecycle.state });
  } catch (err) {
    return json(res, statusFor(err), { error: err.message });
  }
}
