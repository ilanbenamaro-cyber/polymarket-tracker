-- Teardown for 0006 (reversible — history is regenerable by the daily cron, no user data).
-- Run in the Supabase SQL editor to reset; then re-run 0006_market_history.sql.
-- To clear only collected history (keep schema): truncate public.market_history;

drop table if exists public.market_history cascade;
