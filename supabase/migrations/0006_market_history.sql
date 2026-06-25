-- 0006_market_history.sql — per-market daily history (the Phase 1 analytics unlock).
--
-- The product computes on demand and caches ONE snapshot per market, so every
-- velocity/dispersion/trend card was empty. This table stores ONE row per watched
-- market per UTC day (written by the daily cron at app/api/snapshot), from which the
-- detail view derives velocity (≥7d), dispersion (≥30d), per-threshold deltas, and the
-- historical trends chart. Purely ADDITIVE: it touches no existing table and no compute
-- path (history is written AFTER the verified record is produced by the same serveMarket
-- pipeline /api/market uses). Reversible via 0006_market_history_down.sql.
--
-- RLS MODEL — deliberately MIRRORS market_snapshots (0001): RLS enabled, NO policies =
-- deny-all to anon/authenticated. The ONLY reader is the SERVICE ROLE (lib/market-history),
-- bounded to a single market_id per read — the same per-market trust level as the public
-- /api/market serve. We do NOT add an authenticated-SELECT policy: no other cache table has
-- one, and adding a client-readable path here would be a new, untested RLS surface. (Decision
-- recorded with the operator before applying.)

create table if not exists public.market_history (
  id                bigint generated always as identity primary key,
  market_id         text not null references public.markets(id) on delete cascade,
  snapshot_date     date not null,                 -- UTC date of the snapshot
  kind              text not null,                 -- fine shape: survival|bucket_pmf|
                                                   -- directional_touch|binary|categorical
  -- survival + bucket_pmf headline fields (null for other kinds)
  implied_median    numeric,
  implied_mean      numeric,
  confidence_tier   text,
  confidence_score  numeric,
  -- binary headline field
  probability       numeric,                       -- YES probability (0..1)
  -- directional_touch headline fields
  touch_range_lo    numeric,
  touch_range_hi    numeric,
  -- categorical headline fields (Phase 1b)
  dominant_outcome  text,
  dominant_prob     numeric,
  -- full derived record + provenance for detailed/historical queries
  record            jsonb not null,
  raw_sha256        text,
  created_at        timestamptz not null default now(),
  unique (market_id, snapshot_date)               -- one row per market per UTC day (upsert)
);

-- Series reads are always "this market, recent days ascending".
create index if not exists market_history_market_date_idx
  on public.market_history (market_id, snapshot_date desc);

-- Lock down: RLS on, NO policies → anon/authenticated denied; service_role bypasses RLS
-- (same posture as public.market_snapshots).
alter table public.market_history enable row level security;
