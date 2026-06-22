// lib/compute.mjs — run the verified core/ pipeline for one market, on demand.
//
// Why this exists: the serverless function must produce a record the SAME way the
// cron does (ARCHITECTURE governing principle) — isotonic → firewall → validate →
// hash, in core/ — just invoked per-request with a per-market config and written
// to the Supabase cache instead of the filesystem. No metric is computed here; this
// only orchestrates core/. Pure of any DB/HTTP-response concern (the handler owns those).

// Data is IMPORTED (bundled into the JS), not read from disk at runtime — so the
// serverless function never ENOENTs on an un-traced file (see core/markets/manifest.mjs).
import METHODOLOGY from '../core/methodology.json' with { type: 'json' };
import ASSUMPTIONS from '../core/assumptions.json' with { type: 'json' };

import {
  fetchLiveSnapshot, fetchEventStatus, countClosed,
  classifyMarketKind, fetchBinaryStatus, fetchBinarySnapshot,
} from '../core/fetch.js';
import { defaultConfigForLadder } from '../core/market-config.js';
import { classifyLifecycle, LIFECYCLE } from '../core/lifecycle.js';
import {
  buildSnapshotRecord, attachAnalytics, attachScenarios, attachNarrative,
} from '../core/snapshot.js';
import { buildBinaryRecord } from '../core/binary.js';
import { validateRecord } from '../core/validate.js';
import { buildFreshness } from '../core/freshness.js';
import { PINNED_CONFIGS } from '../core/markets/manifest.mjs';
import { CACHE_TTL_HOURS } from './decide-cache-action.mjs';

/** A pinned MarketConfig whose event_slug matches, or null (→ generic defaults).
 *  structuredClone hands out a fresh mutable copy per call (preserving the old
 *  JSON.parse(readFileSync) semantics) so a caller can't mutate the shared manifest. */
function pinnedConfigFor(eventSlug) {
  const match = PINNED_CONFIGS.find((c) => c.event_slug === eventSlug);
  return match ? structuredClone(match) : null;
}

/** Lifecycle (gamma-meta only, no CLOB) for a market — safe on resolved markets. */
export async function probeLifecycle(eventSlug) {
  const bootstrap = {
    event_slug: eventSlug,
    threshold: { parse_pattern: '\\$(\\d+\\.?\\d*)', unit_prefix: '$', unit_suffix: '' },
    narrative: { unit_prefix: '$', unit_suffix: '' },
  };
  const status = await fetchEventStatus(bootstrap);
  return { status, lifecycle: classifyLifecycle(status, new Date().toISOString()) };
}

/**
 * Freeze a prior record under a non-OPEN lifecycle (no live pull) — mirrors
 * scripts/snapshot.js:freezeRecord. Used when a market has resolved/closed.
 */
export function freezePriorRecord(prior, lifecycle) {
  const frozen = structuredClone(prior);
  frozen.methodology_version = METHODOLOGY.version;
  frozen.snapshot.lifecycle = lifecycle;
  frozen.snapshot.derived.freshness = buildFreshness(frozen.snapshot.fetched_at, null, undefined, lifecycle);
  validateRecord(frozen);
  return frozen;
}

/**
 * Compute (or freeze) the verified canonical record for a market on demand.
 *   { id, prior }  — prior = the last cached record (for the freeze path), or null.
 * Returns { record, lifecycle, config }. Throws { code } on a 404/409-class issue.
 * Never returns an unvalidated record (validateRecord runs before return).
 */
export async function computeMarketRecord({ id, prior = null }) {
  // Detect kind BEFORE any threshold parsing — fetchMarketMeta throws on a binary
  // question's missing $threshold, so probeLifecycle can't classify a binary market.
  if ((await classifyMarketKind(id)) === 'binary') {
    return computeBinaryRecord({ id, prior });
  }

  const { status, lifecycle } = await probeLifecycle(id);
  if (!status || status.length < 2) {
    const e = new Error(`"${id}" is not a usable threshold-ladder event`);
    e.code = 404;
    throw e;
  }

  // Non-OPEN: there are no live midpoints to pull — freeze the prior record.
  if (lifecycle.state !== LIFECYCLE.OPEN) {
    if (!prior) {
      const e = new Error(`"${id}" is ${lifecycle.state} with no prior record to freeze`);
      e.code = 409;
      throw e;
    }
    return { record: freezePriorRecord(prior, lifecycle), lifecycle, config: prior.snapshot?.lifecycleConfig ?? null };
  }

  // OPEN: full live pipeline.
  const config = pinnedConfigFor(id) ?? defaultConfigForLadder(
    status.map((s) => s.threshold),
    { id, event_slug: id, name: id, unit_prefix: '$', unit_suffix: '' }
  );
  const live = await fetchLiveSnapshot(config);
  const anomalies = { stale: false, closedCount: countClosed(live.status), liquidityDrop: null };
  const record = buildSnapshotRecord(
    live, METHODOLOGY.version, anomalies, config, lifecycle, CACHE_TTL_HOURS
  );
  attachAnalytics(record, { priors: {}, config }); // no history priors on-demand (2a)
  if (config.scenarios) attachScenarios(record, ASSUMPTIONS);
  else record.assumptions_version = null;
  attachNarrative(record, { config });
  validateRecord(record); // schema + invariants + firewall + lifecycle — never cache unvalidated
  return { record, lifecycle, config };
}

/** A MarketConfig for a binary market — name/resolves come from gamma; kind drives
 *  the cache (markets.kind='binary') and the rail/detail rendering branch. */
function defaultBinaryConfig(id, title = null, endDate = null) {
  return {
    id, event_slug: id, name: title || id, kind: 'binary',
    platform: 'polymarket', market_url: `https://polymarket.com/event/${id}`,
    resolves: endDate ? endDate.slice(0, 10) : null,
  };
}

/** Freeze a prior BINARY record under a non-OPEN lifecycle (no live pull), mirroring
 *  freezePriorRecord. Reconstructs a kind:'binary' config from the prior's asset. */
function freezeBinaryPriorRecord(prior, lifecycle, id) {
  const frozen = structuredClone(prior);
  frozen.methodology_version = METHODOLOGY.version;
  frozen.snapshot.lifecycle = lifecycle;
  frozen.snapshot.derived.freshness = buildFreshness(frozen.snapshot.fetched_at, null, undefined, lifecycle);
  validateRecord(frozen);
  const a = prior.asset ?? {};
  const config = { id: a.id ?? id, name: a.name ?? id, kind: 'binary', platform: a.platform ?? 'polymarket', market_url: a.market_url, resolves: a.resolves };
  return { record: frozen, lifecycle, config };
}

/** Compute (or freeze) a BINARY market record. Lifecycle is classified from gamma meta
 *  (no threshold parse); non-OPEN freezes the prior, OPEN runs fetchBinarySnapshot. */
async function computeBinaryRecord({ id, prior = null }) {
  const status = await fetchBinaryStatus({ event_slug: id });
  const lifecycle = classifyLifecycle(status, new Date().toISOString());

  if (lifecycle.state !== LIFECYCLE.OPEN) {
    if (!prior) {
      const e = new Error(`"${id}" is ${lifecycle.state} with no prior record to freeze`);
      e.code = 409;
      throw e;
    }
    return freezeBinaryPriorRecord(prior, lifecycle, id);
  }

  const live = await fetchBinarySnapshot({ event_slug: id });
  const config = defaultBinaryConfig(id, live.title, live.end_date);
  const record = buildBinaryRecord(live, METHODOLOGY.version, config, lifecycle, CACHE_TTL_HOURS);
  validateRecord(record); // schema (binary branch) + lifecycle — never cache unvalidated
  return { record, lifecycle, config };
}
