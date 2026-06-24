-- 0005_directional_touch_down.sql — revert the kind CHECK to ladder+binary only.
-- NOTE: this will FAIL if any directional_touch rows exist; delete them first
--   (delete from public.markets where kind = 'directional_touch';) — cascades to snapshots.

alter table public.markets drop constraint if exists markets_kind_check;
alter table public.markets
  add constraint markets_kind_check check (kind in ('threshold_ladder', 'binary'));
