-- 0011_market_latest_view_refresh.sql — refresh the market_latest view so the reliability_/
-- liquidity_ columns 0010 added to market_snapshots actually surface through it.
--
-- WHY THIS IS NEEDED (the trap 0010's own comment got wrong): a view defined with `select *` has
-- its `*` EXPANDED INTO AN EXPLICIT COLUMN LIST AT CREATE TIME and then FROZEN. Adding columns to
-- the base table LATER does NOT propagate to the view — it keeps returning only the columns that
-- existed when it was created. So 0010's `alter table market_snapshots add column reliability_*/
-- liquidity_*` left market_latest still returning the pre-split 14 columns, and any read of the new
-- columns THROUGH the view failed in prod with "Could not find the 'liquidity_score' column".
-- CREATE OR REPLACE VIEW re-runs the `select *`, re-expanding it to the current 18 columns.
--
-- security_invoker = on is MANDATORY (the 2a RLS gotcha): without it the view runs as its owner and
-- BYPASSES market_snapshots' RLS (anon could read every row). CREATE OR REPLACE VIEW PRESERVES the
-- existing grants (only DROP+CREATE would reset them), so no re-grant is needed here. The final
-- NOTIFY makes PostgREST reload its schema cache so the API sees the refreshed columns immediately
-- (without it, PostgREST can keep reporting "column does not exist" against a stale cache).
--
-- Reversible via 0011_market_latest_view_refresh_down.sql (which MUST run before 0010_down, so the
-- view stops depending on the columns 0010_down drops). Idempotent — safe to re-run.

create or replace view public.market_latest
  with (security_invoker = on) as
  select distinct on (market_id) *
  from public.market_snapshots
  order by market_id, cached_at desc;

notify pgrst, 'reload schema';
