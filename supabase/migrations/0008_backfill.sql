-- 0008_backfill.sql — history backfill provenance + per-market status (backfill I4).
--
-- When a user adds a market we rebuild market_history from Polymarket's CLOB prices-history
-- (lib/backfill). Two additive needs, touching no existing data semantics:
--   1. market_history.source — tag each row 'cron' (the daily live capture) vs 'backfill'
--      (reconstructed from historical prices). Existing rows + future cron inserts default to
--      'cron'. PRECEDENCE: the backfill INSERTs and ignores unique-key conflicts, so a real
--      captured 'cron' row is never overwritten by a reconstruction.
--   2. markets.backfill_status / backfilled_through — per-market progress so the daily cron can
--      retry 'failed'/incomplete markets and the UI can show a "backfilling history" signal.
-- Purely additive (no table rewrite, RLS unchanged). Reversible via 0008_backfill_down.sql.

alter table public.market_history
  add column if not exists source text not null default 'cron';

alter table public.markets
  add column if not exists backfill_status text;          -- null=not attempted | pending | done | failed

alter table public.markets
  add column if not exists backfilled_through date;        -- earliest UTC date a backfill row was written

-- Filtering history by provenance (e.g. "how many real cron rows exist yet") is a per-market scan.
create index if not exists market_history_source_idx
  on public.market_history (market_id, source);
