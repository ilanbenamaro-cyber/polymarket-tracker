-- Reverse 0009_snapshot_hour.sql — restore the (market_id, snapshot_date) unique key + drop the column.
--
-- ⚠ WARNING: if a day ever held TWO captures (a 02:00 + an 18:00 row), restoring the 2-column unique
-- constraint will FAIL with a duplicate-key error. Deduplicate to one row per (market_id, snapshot_date)
-- BEFORE running this down migration, e.g. keep the nearer-US-peak row:
--   delete from public.market_history a using public.market_history b
--   where a.market_id = b.market_id and a.snapshot_date = b.snapshot_date
--     and abs(a.snapshot_hour - 18) > abs(b.snapshot_hour - 18);

alter table public.market_history
  drop constraint if exists market_history_market_id_snapshot_date_hour_key;

alter table public.market_history
  add constraint market_history_market_id_snapshot_date_key
  unique (market_id, snapshot_date);

alter table public.market_history
  drop column if exists snapshot_hour;
