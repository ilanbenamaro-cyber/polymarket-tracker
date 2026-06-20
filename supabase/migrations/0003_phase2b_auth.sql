-- Phase 2b.2 — invite-only signup gate + auto-provisioning. ADDITIVE to 0002
-- (which created allowed_emails / profiles / org_membership). Two privileged
-- functions, both SECURITY DEFINER with search_path pinned to '' (search-path
-- injection hardening on functions that run as the owner):
--
--   1. hook_restrict_signup_to_allowlist  — the "Before User Created" Auth Hook.
--      DENY BY DEFAULT: allow ONLY on an explicit allowed_emails match; reject
--      everything else (missing/null/empty/malformed email included). This is the
--      INVERSE of the docs' deny-list example — invite-only FAILING OPEN is the P0.
--   2. handle_new_user (after insert on auth.users) — provisions profiles +
--      org_membership from the matching allowlist row and stamps consumed_at.
--
-- ⚠ REQUIRED MANUAL STEP (cannot be done in SQL): after applying this migration,
--   ENABLE the hook in the project — Dashboard → Authentication → Hooks →
--   "Before User Created" → Postgres → public.hook_restrict_signup_to_allowlist
--   (or config.toml [auth.hook.before_user_created] enabled=true, uri=
--   "pg-functions://postgres/public/hook_restrict_signup_to_allowlist").
--   A created-but-not-enabled hook fails OPEN silently — the negative gate
--   (scripts/verify-phase2b-auth.mjs) is the proof it is both correct AND enabled.

-- ── 1. signup gate (Before User Created hook) ──
create function public.hook_restrict_signup_to_allowlist(event jsonb)
  returns jsonb
  language plpgsql
  security definer set search_path = ''      -- runs as owner; pin search_path
as $$
declare
  v_email text;
begin
  -- DENY BY DEFAULT: a missing/null/empty/malformed email yields no match below,
  -- so it falls through to the reject branch. Allow ONLY on explicit allowlist hit.
  v_email := lower(event->'user'->>'email');
  if v_email is not null and exists (
       select 1 from public.allowed_emails where email = v_email
     ) then
    return '{}'::jsonb;                       -- allow → user is created
  end if;
  -- Generic message: never reveals allowlist contents or near-matches.
  return jsonb_build_object(
    'error', jsonb_build_object(
      'message', 'Access is invite-only — ask your administrator to add your email.',
      'http_code', 403
    )
  );                                          -- reject → NO auth.users row created
end;
$$;

-- The hook is invoked by the auth server's role; lock it down to that role only.
grant execute on function public.hook_restrict_signup_to_allowlist to supabase_auth_admin;
grant usage on schema public to supabase_auth_admin;
revoke execute on function public.hook_restrict_signup_to_allowlist from authenticated, anon, public;

-- ── 2. auto-provision profile + org membership on user creation ──
create function public.handle_new_user()
  returns trigger
  language plpgsql
  security definer set search_path = ''
as $$
declare
  v_email text;
  v_org   uuid;
  v_role  public.org_role;
begin
  v_email := lower(new.email);
  -- idempotent: this trigger fires for admin-created users too
  insert into public.profiles (id, email)
    values (new.id, v_email)
    on conflict (id) do nothing;
  -- provision membership from the allowlist entry, if one exists
  select org_id, role into v_org, v_role
    from public.allowed_emails where email = v_email;
  if v_org is not null then
    insert into public.org_membership (org_id, user_id, role)
      values (v_org, new.id, v_role)
      on conflict (org_id, user_id) do nothing;
    update public.allowed_emails set consumed_at = now()
      where email = v_email and consumed_at is null;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ── ONE-TIME-INVITE tightening (documented, NOT enabled): to make an invite
--    single-use, add "and consumed_at is null" to the EXISTS check in
--    hook_restrict_signup_to_allowlist so a consumed invite can't be reused.
