-- 0008_backfill_down.sql — reverse 0008_backfill.sql.
drop index if exists public.market_history_source_idx;
alter table public.markets drop column if exists backfilled_through;
alter table public.markets drop column if exists backfill_status;
alter table public.market_history drop column if exists source;
