-- 0005_directional_touch.sql — allow directional-touch markets in the catalog.
--
-- The market-type redesign adds kind='directional_touch' records (WTI/Silver
-- "(LOW)/(HIGH) hit $X" markets) alongside ladders and binaries. These are NOT survival
-- ladders — they store an implied trading range, not a median — so they carry their own
-- `kind`. (Bucket-PMF markets need NO migration: they are ladder-SHAPED and stored as
-- 'threshold_ladder'.) Additive: only WIDENS the allowed set; every existing row stays
-- valid. Apply to DEV (and, at prod standup, PROD) the same way as 0001–0004.

alter table public.markets drop constraint if exists markets_kind_check;
alter table public.markets
  add constraint markets_kind_check check (kind in ('threshold_ladder', 'binary', 'directional_touch'));
