-- 0007_categorical.sql — allow categorical markets in the catalog (Phase 1b).
--
-- Categorical events (named mutually-exclusive outcomes, e.g. "How many Fed rate cuts in
-- 2026?") now COMPUTE (core/categorical + computeCategoricalRecord) instead of being gated
-- with a 422. They store kind='categorical'. Additive: only WIDENS the allowed set; every
-- existing row stays valid. Apply to DEV (and, at prod standup, PROD) like 0001–0006.

alter table public.markets drop constraint if exists markets_kind_check;
alter table public.markets
  add constraint markets_kind_check
  check (kind in ('threshold_ladder', 'binary', 'directional_touch', 'categorical'));
