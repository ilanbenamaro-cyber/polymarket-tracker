// lib/compute.mjs — run the verified core/ pipeline for one market, on demand.
//
// Why this exists: the serverless function must produce a record the SAME way the
// cron does (ARCHITECTURE governing principle) — isotonic → firewall → validate →
// hash, in core/ — just invoked per-request with a per-market config and written
// to the Supabase cache instead of the filesystem. No metric is computed here; this
// only orchestrates core/. Pure of any DB/HTTP-response concern (the handler owns those).

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { fetchLiveSnapshot, fetchEventStatus, countClosed } from '../core/fetch.js';
import { defaultConfigForLadder } from '../core/market-config.js';
import { classifyLifecycle, LIFECYCLE } from '../core/lifecycle.js';
import {
  buildSnapshotRecord, attachAnalytics, attachScenarios, attachNarrative,
} from '../core/snapshot.js';
import { validateRecord } from '../core/validate.js';
import { buildFreshness } from '../core/freshness.js';
import { CACHE_TTL_HOURS } from './decide-cache-action.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MARKETS_DIR = join(__dirname, '../core/markets');
const METHODOLOGY = JSON.parse(readFileSync(join(__dirname, '../core/methodology.json'), 'utf8'));
const ASSUMPTIONS = JSON.parse(readFileSync(join(__dirname, '../core/assumptions.json'), 'utf8'));

/** A pinned MarketConfig whose event_slug matches, or null (→ generic defaults). */
function pinnedConfigFor(eventSlug) {
  try {
    for (const f of readdirSync(MARKETS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const cfg = JSON.parse(readFileSync(join(MARKETS_DIR, f), 'utf8'));
      if (cfg.event_slug === eventSlug) return cfg;
    }
  } catch { /* bundling/dir issues → fall back to generic default below */ }
  return null;
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
