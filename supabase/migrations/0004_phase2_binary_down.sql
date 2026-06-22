-- 0004_phase2_binary_down.sql — revert the kind CHECK to threshold_ladder-only.
-- NOTE: this will FAIL if any binary rows exist; delete them first
--   (delete from public.markets where kind = 'binary';) — cascades to market_snapshots.

alter table public.markets drop constraint if exists markets_kind_check;
alter table public.markets
  add constraint markets_kind_check check (kind in ('threshold_ladder'));
