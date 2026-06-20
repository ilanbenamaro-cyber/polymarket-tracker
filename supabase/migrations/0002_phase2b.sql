-- Phase 2b — accounts + watchlists. ADDITIVE to 0001_phase2a.sql: this migration
-- does NOT alter the 2a tables (markets, market_snapshots, market_latest). It adds
-- invite-only accounts (orgs + profiles + membership + an operator allowlist) and
-- BOTH personal (private) and org-shared watchlists.
--
-- RLS is the firewall for ALL user data here (2a's tables were deny-all; 2b has
-- real per-user policies). A policy that leaks one user's/org's rows to another is
-- the 2b P0 — every new table is RLS-enabled and policied below, and the blocking
-- gate is scripts/verify-phase2b-isolation.mjs (real-JWT cross-tenant proof).
--
-- DELIBERATELY NOT HERE (2b.2, after verifying the CURRENT Supabase mechanism
-- against live docs): the signup gate (reject non-allowlisted emails) and the
-- handle_new_user auto-provision trigger. 2b.1 provisions users via the admin API.

-- ── role enum ──
create type public.org_role as enum ('admin','member');

-- ── organizations ──
create table public.organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

-- ── profiles: 1:1 with Supabase auth.users (Supabase Auth owns identity) ──
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  display_name text,
  created_at   timestamptz not null default now()
);

-- ── org membership (M:N; role gates org-admin actions later) ──
create table public.org_membership (
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null references public.profiles(id)      on delete cascade,
  role       public.org_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- ── allowlist / invite: operator-managed input to the (2b.2) signup gate ──
create table public.allowed_emails (
  email       text primary key,                      -- store lower(email)
  org_id      uuid not null references public.organizations(id) on delete cascade,
  role        public.org_role not null default 'member',
  invited_by  text,                                  -- operator note
  consumed_at timestamptz,                           -- stamped when the signup lands
  created_at  timestamptz not null default now()
);

-- ── personal watchlist: private to the user ──
create table public.personal_watchlist (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  market_id  text not null references public.markets(id)  on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, market_id)
);

-- ── org watchlist: shared across an org's members; added_by attributes who curated ──
create table public.org_watchlist (
  org_id     uuid not null references public.organizations(id) on delete cascade,
  market_id  text not null references public.markets(id)       on delete cascade,
  added_by   uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (org_id, market_id)
);

create index org_membership_user_idx    on public.org_membership    (user_id);
create index personal_watchlist_user_idx on public.personal_watchlist (user_id);
create index org_watchlist_org_idx       on public.org_watchlist      (org_id);

-- ── membership helpers (SECURITY DEFINER): let a policy ON org_membership check
--    membership WITHOUT recursing into its own RLS. search_path pinned to '' and
--    all objects fully qualified (Supabase hardening guidance). ──
create function public.is_org_member(p_org uuid)
  returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.org_membership
    where org_id = p_org and user_id = (select auth.uid())
  );
$$;

create function public.shares_org(p_other uuid)
  returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.org_membership a
    join public.org_membership b using (org_id)
    where a.user_id = (select auth.uid()) and b.user_id = p_other
  );
$$;

-- ── RLS enable (every new table) ──
alter table public.organizations      enable row level security;
alter table public.profiles           enable row level security;
alter table public.org_membership     enable row level security;
alter table public.allowed_emails     enable row level security;  -- NO policies → client-deny
alter table public.personal_watchlist enable row level security;
alter table public.org_watchlist      enable row level security;

-- ── grants: 'authenticated' gets table privileges (RLS then filters ROWS);
--    'anon' gets NOTHING on user data (invite-only, pre-login); allowed_emails
--    gets neither (operator/service-role only). RLS without a table grant is
--    permission-denied, so these grants are required, not optional. ──
grant select               on public.organizations      to authenticated;
grant select, update       on public.profiles           to authenticated;
grant select               on public.org_membership     to authenticated;
grant select, insert, delete on public.personal_watchlist to authenticated;
grant select, insert, delete on public.org_watchlist      to authenticated;
-- service_role bypasses RLS but still needs table grants for the compute/seed paths:
grant all on public.organizations, public.profiles, public.org_membership,
             public.allowed_emails, public.personal_watchlist, public.org_watchlist
  to service_role;

-- ── policies ──
-- organizations: read orgs you belong to
create policy org_select_member on public.organizations
  for select to authenticated using ( (select public.is_org_member(id)) );

-- profiles: read self + co-org members; update self only
create policy profiles_select_self_or_coorg on public.profiles
  for select to authenticated
  using ( id = (select auth.uid()) or (select public.shares_org(id)) );
create policy profiles_update_self on public.profiles
  for update to authenticated
  using ( id = (select auth.uid()) ) with check ( id = (select auth.uid()) );

-- org_membership: read membership of orgs you belong to (definer helper → no recursion).
-- NO insert/update/delete policies → only service_role / the (2b.2) definer trigger
-- can mutate membership. This is what makes a user unable to add themselves to an org.
create policy orgmem_select_member on public.org_membership
  for select to authenticated using ( (select public.is_org_member(org_id)) );

-- personal_watchlist: full CRUD on OWN rows only
create policy pw_select_own on public.personal_watchlist
  for select to authenticated using ( user_id = (select auth.uid()) );
create policy pw_insert_own on public.personal_watchlist
  for insert to authenticated with check ( user_id = (select auth.uid()) );
create policy pw_delete_own on public.personal_watchlist
  for delete to authenticated using ( user_id = (select auth.uid()) );

-- org_watchlist: any member reads + curates the shared list; added_by must be self
create policy ow_select_member on public.org_watchlist
  for select to authenticated using ( (select public.is_org_member(org_id)) );
create policy ow_insert_member on public.org_watchlist
  for insert to authenticated
  with check ( (select public.is_org_member(org_id)) and added_by = (select auth.uid()) );
create policy ow_delete_member on public.org_watchlist
  for delete to authenticated using ( (select public.is_org_member(org_id)) );
-- TIGHTENING (documented one-liner, if org writes should be admin-only later): add
--   "and exists (select 1 from public.org_membership m where m.org_id = org_watchlist.org_id
--    and m.user_id = (select auth.uid()) and m.role = 'admin')"
-- to ow_insert_member (with check) and ow_delete_member (using).

-- ── union view: 2c "all markets I can see" = personal ∪ org.
--    ⚠ security_invoker = on is MANDATORY (the 2a gotcha): a view runs as its OWNER
--    by default and would BYPASS the base-table RLS, leaking every watchlist. With
--    security_invoker it runs as the querying user and inherits both tables' RLS. ──
create view public.my_visible_watchlist with (security_invoker = on) as
  select 'personal'::text as scope, null::uuid as org_id, market_id, created_at
    from public.personal_watchlist
  union all
  select 'org'::text as scope, org_id, market_id, created_at
    from public.org_watchlist;

grant select on public.my_visible_watchlist to authenticated;
