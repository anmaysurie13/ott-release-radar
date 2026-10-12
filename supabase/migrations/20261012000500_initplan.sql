-- Use the canonical (select auth.jwt()) form so the planner evaluates it once (advisor 0003_auth_rls_initplan).
drop policy admins_self_read on public.app_admins;
create policy admins_self_read on public.app_admins for select to authenticated
  using (email = lower(coalesce((select auth.jwt()) ->> 'email', '')));
drop policy feedback_admin_insert on public.feedback;
create policy feedback_admin_insert on public.feedback for insert to authenticated
  with check ((select private.is_admin()) and created_by = lower((select auth.jwt()) ->> 'email'));
