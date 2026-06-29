-- 0009_snapshot_hour.sql — second daily cron capture (Increment 2: cron timing diversification).
--
-- The history cron ran only at 02:00 UTC — the LOWEST-liquidity hour for US markets, so every
-- velocity/dispersion datapoint was built from off-peak data. We add a second 18:00 UTC (US-peak)
-- run (vercel.json). To store BOTH captures for a day, the uniqueness key gains snapshot_hour:
--   • snapshot_hour smallint — UTC hour of the run (18 = US peak, 2 = off-peak; 0 = backfill/legacy).
--   • the (market_id, snapshot_date) unique key becomes (market_id, snapshot_date, snapshot_hour).
-- Existing rows default to hour 0 (they were single daily captures); the read-time collapse
-- (lib/market-history.ordered) keeps ONE row per day, preferring the nearer-US-peak capture. Purely
-- additive to data (no row rewrite); reversible via 0009_snapshot_hour_down.sql. The compute path is
-- untouched → SpaceX parity unaffected.
--
-- (The new constraint uses the Postgres `_key` convention rather than a `_pkey` name — this is a
-- UNIQUE constraint, not the table's primary key, which remains `id`. PostgREST upserts key off the
-- column list, not the constraint name.)

alter table public.market_history
  add column if not exists snapshot_hour smallint not null default 0;

alter table public.market_history
  drop constraint if exists market_history_market_id_snapshot_date_key;

alter table public.market_history
  add constraint market_history_market_id_snapshot_date_hour_key
  unique (market_id, snapshot_date, snapshot_hour);
