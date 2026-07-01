-- 0011_market_latest_view_refresh_down.sql — restore market_latest to its PRE-split column set
-- (the 14 columns frozen before 0010 added reliability_/liquidity_), so that a subsequent 0010_down
-- can drop those columns without the view depending on them. RUN THIS BEFORE 0010_down.
--
-- CREATE OR REPLACE VIEW cannot REMOVE columns (it may only append), so restoring the narrower
-- column set requires DROP + CREATE — which RESETS grants, hence the explicit re-grant below to the
-- Supabase default roles (RLS + security_invoker still gate actual row access; anon reads 0 rows).

drop view if exists public.market_latest;

create view public.market_latest
  with (security_invoker = on) as
  select distinct on (market_id)
    id, market_id, fetched_at, cached_at, raw_sha256, schema_version, methodology_version,
    assumptions_version, lifecycle_state, is_final, confidence_tier, implied_median, stale_after, record
  from public.market_snapshots
  order by market_id, cached_at desc;

grant select on public.market_latest to anon, authenticated, service_role;

notify pgrst, 'reload schema';
