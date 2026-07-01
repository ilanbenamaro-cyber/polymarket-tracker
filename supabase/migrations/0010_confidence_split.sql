-- 0010_confidence_split.sql — split the single confidence tier into two INDEPENDENT
-- dimensions: RELIABILITY (is the displayed number trustworthy) and LIQUIDITY (can you
-- transact at this price). See decisions "Confidence split into reliability + liquidity".
--
-- ADDITIVE + NON-DESTRUCTIVE. The legacy confidence_tier/confidence_score columns are KEPT
-- (any unmigrated reader still works, and pre-migration history rows keep their data). The
-- new columns are NULL for every pre-migration row — we deliberately do NOT backfill the old
-- single value into both, because the old tier conflated the two dimensions; copying it into
-- liquidity_tier would assert a liquidity reading that was never computed (a fabricated number,
-- which this product's trust posture forbids). The display layer shows "—" for the missing half
-- until new daily snapshots accrue the real split. Reversible via 0010_confidence_split_down.sql.
--
-- ⚠ CORRECTION (see 0011): the original claim here — "market_latest is `select distinct on
-- (market_id) *`, so the new columns surface automatically, no view recreation needed" — is WRONG.
-- A view's `*` is EXPANDED TO AN EXPLICIT COLUMN LIST AT CREATE TIME and frozen; the columns added
-- below do NOT propagate to market_latest. Reads of reliability_/liquidity_ through the view 500'd
-- in prod ("Could not find the 'liquidity_score' column") until 0011 did CREATE OR REPLACE VIEW.
-- If you apply 0010 to a NEW environment, apply 0011 too.

-- The live cache (rail + market_latest read these).
alter table public.market_snapshots add column if not exists reliability_tier  text;
alter table public.market_snapshots add column if not exists reliability_score numeric;
alter table public.market_snapshots add column if not exists liquidity_tier    text;
alter table public.market_snapshots add column if not exists liquidity_score   numeric;

-- The per-market daily history (reliability/liquidity trend cards read these).
alter table public.market_history add column if not exists reliability_tier  text;
alter table public.market_history add column if not exists reliability_score numeric;
alter table public.market_history add column if not exists liquidity_tier    text;
alter table public.market_history add column if not exists liquidity_score   numeric;
