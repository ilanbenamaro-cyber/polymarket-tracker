// core/freshness.js — Tier-1 data-freshness policy.
//
// Why this exists: a silently stale number is a trust failure for this product. The
// feed must DISCLOSE how old its data is and when to consider it stale, under one
// documented policy that the dashboard, the API, and any downstream consumer apply
// identically. Pure: a function of the snapshot's own as-of timestamp plus one
// documented constant — no external input, so it stays Tier-1 (no assumption).

// Staleness threshold. The snapshot cron (.github/workflows/update.yml, `0 14 * * *`)
// runs DAILY including weekends, so the normal gap between snapshots is ~24h. 50h
// absorbs one fully-missed daily run (~48h) plus the usual Actions queue delay, so a
// single skipped cron does NOT cry wolf; two or more consecutive misses — a genuine
// pipeline failure — do trip it. (The weekday-only `1-5` crons are the EMAIL runs,
// not the snapshot, so weekends are still ~24h, not 72h.)
export const STALENESS_THRESHOLD_HOURS = 50;
export const EXPECTED_CADENCE = 'daily ~14:00 UTC (incl. weekends)';

const MS_PER_HOUR = 3_600_000;

/**
 * Freshness policy for a snapshot taken at `asOfISO`. Returns the as-of anchor, the
 * documented threshold, and an absolute `stale_after` instant (= as_of + threshold)
 * so any consumer judges staleness with a single timestamp comparison and no shared
 * formula to drift. The published record carries POLICY ONLY (no frozen age/flag —
 * age is inherently a read-time quantity; baking it at build time would be a lie
 * that goes wrong the moment the file sits unchanged). Pass `nowISO` (the live
 * clock, e.g. from the browser) to additionally evaluate `age_hours` + `stale`.
 */
export function buildFreshness(asOfISO, nowISO = null, thresholdHours = STALENESS_THRESHOLD_HOURS) {
  const asOfMs = Date.parse(asOfISO);
  if (Number.isNaN(asOfMs)) throw new Error(`buildFreshness: invalid as_of "${asOfISO}"`);
  const staleAfterMs = asOfMs + thresholdHours * MS_PER_HOUR;
  const out = {
    as_of: asOfISO,
    staleness_threshold_hours: thresholdHours,
    stale_after: new Date(staleAfterMs).toISOString(),
    expected_cadence: EXPECTED_CADENCE,
    policy: `Considered stale ${thresholdHours}h after as_of (daily cadence ~24h + margin for one missed run). Live age = now − as_of; stale = now > stale_after.`,
  };
  if (nowISO != null) {
    const nowMs = Date.parse(nowISO);
    if (Number.isNaN(nowMs)) throw new Error(`buildFreshness: invalid now "${nowISO}"`);
    out.age_hours = Number(((nowMs - asOfMs) / MS_PER_HOUR).toFixed(2));
    out.stale = nowMs > staleAfterMs;
  }
  return out;
}

/** Human "age" label from hours: "3h ago", "2d 4h ago", "just now". */
export function ageLabel(ageHours) {
  if (ageHours == null || !Number.isFinite(ageHours) || ageHours < 1) return 'just now';
  if (ageHours < 24) return `${Math.floor(ageHours)}h ago`;
  const days = Math.floor(ageHours / 24);
  const h = Math.floor(ageHours % 24);
  return h ? `${days}d ${h}h ago` : `${days}d ago`;
}
