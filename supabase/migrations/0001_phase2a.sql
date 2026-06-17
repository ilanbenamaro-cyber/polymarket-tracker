-- Phase 2a — verified-snapshot cache + market metadata.
-- Run in the Supabase SQL editor (or `supabase db push`). Reversible via
-- 0001_phase2a_down.sql. RLS enabled with NO anon policies → the anon key can
-- touch nothing; only the service-role key (server-side, in the Vercel function)
-- reads/writes. (Phase 2b adds public-SELECT policies + auth-scoped tables.)

-- markets: catalog + resolution state. id = Polymarket event slug (stable, human,
-- and the FK target for 2b watchlists/notifications).
create table if not exists public.markets (
  id                text primary key,
  title             text,
  kind              text not null default 'threshold_ladder'
                      check (kind in ('threshold_ladder')),
  config            jsonb not null,
  resolution_status text not null default 'open'
                      check (resolution_status in ('open','closed_pending','resolved')),
  resolved_outcome  jsonb,
  last_checked_at   timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- market_snapshots: immutable verified canonical records (generalizes
-- docs/api/v1/snapshots/). The record column holds the full core/-produced,
-- validated, hashed record; raw_sha256 is STORED, never recomputed by the cache.
create table if not exists public.market_snapshots (
  id                  bigint generated always as identity primary key,
  market_id           text not null references public.markets(id) on delete cascade,
  fetched_at          timestamptz not null,
  cached_at           timestamptz not null default now(),
  raw_sha256          text not null,
  schema_version      text not null,
  methodology_version text not null,
  assumptions_version text,
  lifecycle_state     text not null
                        check (lifecycle_state in ('OPEN','CLOSED_PENDING','RESOLVED')),
  is_final            boolean not null default false,
  confidence_tier     text,
  implied_median      numeric,
  stale_after         timestamptz,
  record              jsonb not null,
  unique (market_id, fetched_at)
);

create index if not exists market_snapshots_latest_idx
  on public.market_snapshots (market_id, cached_at desc);

-- O(1) latest snapshot per market.
create or replace view public.market_latest as
  select distinct on (market_id) *
  from public.market_snapshots
  order by market_id, cached_at desc;

-- Lock down: RLS on, no policies → anon denied; service_role bypasses RLS.
alter table public.markets enable row level security;
alter table public.market_snapshots enable row level security;
