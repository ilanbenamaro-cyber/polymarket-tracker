-- 0010_confidence_split_down.sql — reverse 0010. Drops the two-dimension confidence columns.
-- The legacy confidence_tier/confidence_score columns were never touched by 0010, so they remain.

alter table public.market_history    drop column if exists reliability_tier;
alter table public.market_history    drop column if exists reliability_score;
alter table public.market_history    drop column if exists liquidity_tier;
alter table public.market_history    drop column if exists liquidity_score;

alter table public.market_snapshots  drop column if exists reliability_tier;
alter table public.market_snapshots  drop column if exists reliability_score;
alter table public.market_snapshots  drop column if exists liquidity_tier;
alter table public.market_snapshots  drop column if exists liquidity_score;
