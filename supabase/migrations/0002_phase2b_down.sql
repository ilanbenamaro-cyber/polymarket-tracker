-- Reverse of 0002_phase2b.sql.
--
-- ⚠ REVERSIBLE ONLY BEFORE THE FIRST REAL SIGNUP. Once fund users exist,
-- auth.users rows are real accounts owned by Supabase Auth; dropping profiles /
-- org_membership / watchlists destroys real accounts and associations. After
-- launch, treat 2b as FORWARD-ONLY (patch, don't down-migrate). This script is
-- for the pre-launch dev/branch loop. (No 2a data is ever touched — 2b is purely
-- additive to it.)
--
-- Dropping a table cascades its policies and grants. Children before parents.

drop view     if exists public.my_visible_watchlist;
drop table    if exists public.org_watchlist;
drop table    if exists public.personal_watchlist;
drop table    if exists public.allowed_emails;
drop table    if exists public.org_membership;
drop table    if exists public.profiles;
drop table    if exists public.organizations;
drop function if exists public.is_org_member(uuid);
drop function if exists public.shares_org(uuid);
drop type     if exists public.org_role;
