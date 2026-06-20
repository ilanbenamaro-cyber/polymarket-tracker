-- Reverse of 0003_phase2b_auth.sql.
--
-- ⚠ FIRST disable the "Before User Created" hook in the project (Dashboard →
-- Auth → Hooks, or config.toml) — that is project config, not SQL. Dropping the
-- function while the hook still points at it will ERROR every signup.
--
-- (allowed_emails / profiles / org_membership belong to 0002 — left intact.)

drop trigger   if exists on_auth_user_created on auth.users;
drop function  if exists public.handle_new_user();
drop function  if exists public.hook_restrict_signup_to_allowlist(jsonb);
