-- 0004_phase2_binary.sql — allow binary (Yes/No) markets in the catalog.
--
-- Phase 2 adds kind='binary' records (single Yes/No markets) alongside the existing
-- threshold ladders. The 2a markets table pinned `kind` to a CHECK that only permits
-- 'threshold_ladder'; writing a binary market hit "markets_kind_check" violation.
-- This is the ONLY schema change Phase 2 needs (the binary probability reuses the
-- existing implied_median column on market_snapshots — no new column). Additive: it
-- only WIDENS the allowed set; every existing 'threshold_ladder' row stays valid.

alter table public.markets drop constraint if exists markets_kind_check;
alter table public.markets
  add constraint markets_kind_check check (kind in ('threshold_ladder', 'binary'));
