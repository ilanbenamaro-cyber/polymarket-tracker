-- Teardown for Phase 2a (reversible — the cache is regenerable, no user data).
-- Run in the Supabase SQL editor to reset; then re-run 0001_phase2a.sql.
-- To clear only cached records (keep schema): truncate public.market_snapshots;

drop view if exists public.market_latest;
drop table if exists public.market_snapshots cascade;
drop table if exists public.markets cascade;
