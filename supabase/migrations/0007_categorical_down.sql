-- Teardown for 0007 — restore the pre-categorical kind check.
-- ⚠ Will fail if any markets row already has kind='categorical' (delete/recompute those first).

alter table public.markets drop constraint if exists markets_kind_check;
alter table public.markets
  add constraint markets_kind_check
  check (kind in ('threshold_ladder', 'binary', 'directional_touch'));
